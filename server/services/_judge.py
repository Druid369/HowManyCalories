"""Stage 3: Opus reviews the photo + Stage 2 draft and produces the final verdict.

Opus sees the original image plus a compact draft (Stage 2 enriched items +
totals + health insight) and rewrites items it thinks are wrong. We pass only
the externally-meaningful fields — internal scratch (portion_reasoning,
ai_per_100g) is stripped to keep the prompt focused.

Failures (network, parse) preserve the Stage 2 draft. The judge is corrective,
not load-bearing.
"""

import json
import time

import anthropic

from server.config import ANTHROPIC_API_KEY, CLAUDE_JUDGE_MODEL
from server.logging_config import get_logger
from server.services._json import parse_json_response
from server.services._prompts import JUDGE_PROMPT

logger = get_logger(__name__)
_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


async def judge_with_opus(
    image_b64: str, media_type: str, draft: dict,
) -> tuple[dict | None, int, int, int]:
    """Send photo + draft analysis to Opus for final review.

    Returns: (verdict, input_tokens, output_tokens, duration_ms)
    """
    draft_summary = {
        "items": [
            {
                "name": it.get("name"),
                "is_branded": it.get("is_branded", False),
                "usda_search_term": it.get("usda_search_term", ""),
                "estimated_grams": it.get("estimated_grams"),
                "calories": it.get("calories"),
                "protein_g": it.get("protein_g"),
                "fat_g": it.get("fat_g"),
                "carbs_g": it.get("carbs_g"),
                "sugar_g": it.get("sugar_g", 0),
                "fiber_g": it.get("fiber_g", 0),
                "confidence": it.get("confidence"),
                "data_source": it.get("data_source"),
                "is_raw_ingredient": it.get("is_raw_ingredient", False),
            }
            for it in draft.get("items", [])
        ],
        "total": draft.get("total"),
        "health_insight": draft.get("health_insight", ""),
        "notes": draft.get("notes", ""),
    }

    t0 = time.monotonic()
    try:
        message = await _client.messages.create(
            model=CLAUDE_JUDGE_MODEL,
            max_tokens=4096,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": media_type,
                                "data": image_b64,
                            },
                        },
                        {
                            "type": "text",
                            "text": JUDGE_PROMPT.format(
                                draft_json=json.dumps(draft_summary, ensure_ascii=False, indent=2)
                            ),
                        },
                    ],
                }
            ],
        )
        duration_ms = round((time.monotonic() - t0) * 1000)
        in_tok  = message.usage.input_tokens
        out_tok = message.usage.output_tokens

        logger.info("stage3_complete", extra={
            "model": CLAUDE_JUDGE_MODEL,
            "stop_reason": message.stop_reason,
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "duration_ms": duration_ms,
        })

        try:
            verdict = parse_json_response(message.content[0].text)
        except Exception as e:
            logger.warning("stage3_parse_failed", extra={"error": str(e), "duration_ms": duration_ms})
            return None, in_tok, out_tok, duration_ms

        return verdict, in_tok, out_tok, duration_ms

    except Exception as e:
        duration_ms = round((time.monotonic() - t0) * 1000)
        logger.warning("stage3_failed", extra={"error": str(e), "duration_ms": duration_ms})
        return None, 0, 0, duration_ms
