"""Stage 4 (optional): Sonnet sanity-checks user edits to ingredient amounts.

Triggered when the user clicks "Исправить…" after editing the analysis
results. Cheaper than the original Stage 1+3 pipeline (single Sonnet call,
no judge), and conservative by design — only flags items that disagree
with the photo by 2× or more.

Failure modes (network, timeout, parse) collapse to a benign
'looks_right' verdict so the UX never blocks. Validation is advisory.
"""

import json
import time

import anthropic

from server.config import ANTHROPIC_API_KEY, CLAUDE_MODEL
from server.logging_config import get_logger
from server.services._json import parse_json_response

logger = get_logger(__name__)
_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


VALIDATION_PROMPT = """Ты проверяешь правки пользователя в анализе фото еды. Пользователь скорректировал граммы ингредиентов. Внимательно посмотри на фото и реши, есть ли граммы, которые ОЧЕВИДНО неверны — отличаются от разумной оценки в 2+ раза или физически невозможны.

Будь консервативен: помечай ошибку только если фото явно противоречит заявленным граммам. Не придирайся к мелким различиям. Пользователь знает, что он приготовил — твоя задача ловить опечатки и явные ошибки.

Текущие ингредиенты:
{items_json}

Ответ ТОЛЬКО в виде валидного JSON в точном формате:
{{
  "verdict": "looks_right" или "concerns",
  "items": [
    {{"index": 0, "ok": true}},
    {{"index": 1, "ok": false, "suggested_grams": 200, "reason": "На фото около 200г, не 1000г."}}
  ],
  "overall_note": ""
}}

Правила:
- "verdict" = "concerns" если хоть один item имеет ok=false, иначе "looks_right"
- "suggested_grams" и "reason" обязательны ТОЛЬКО при ok=false
- "reason" — на русском, одно предложение, дружелюбный тон
- "overall_note" — опционально, только если есть что добавить помимо построчных деталей
- Возвращай items в том же порядке (по index), что и на входе
"""


async def validate_with_sonnet(
    image_b64: str, media_type: str, items: list[dict],
) -> dict:
    """Send photo + edited items to Sonnet for sanity check.

    Returns a dict matching the ValidationVerdict schema. On any failure
    (network, parse, timeout) returns a benign 'looks_right' fallback so
    the client UX doesn't break.
    """
    items_json = json.dumps(items, ensure_ascii=False, indent=2)
    prompt = VALIDATION_PROMPT.format(items_json=items_json)

    t0 = time.monotonic()
    try:
        msg = await _client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=2048,
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
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
        duration_ms = round((time.monotonic() - t0) * 1000)

        try:
            verdict = parse_json_response(msg.content[0].text)
        except Exception as e:
            logger.warning("validation_parse_failed", extra={
                "error": str(e), "duration_ms": duration_ms,
            })
            return {"verdict": "looks_right", "items": [], "overall_note": ""}

        # Self-correct: if any item has ok:false, force verdict="concerns".
        # Models occasionally produce inconsistent overall verdicts.
        any_concern = any(
            not it.get("ok", True) for it in verdict.get("items", [])
        )
        if any_concern and verdict.get("verdict") != "concerns":
            verdict["verdict"] = "concerns"
        if not any_concern:
            verdict["verdict"] = "looks_right"

        logger.info("validation_complete", extra={
            "verdict": verdict.get("verdict"),
            "concern_count": sum(
                1 for it in verdict.get("items", []) if not it.get("ok", True)
            ),
            "input_tokens":  msg.usage.input_tokens,
            "output_tokens": msg.usage.output_tokens,
            "duration_ms":   duration_ms,
        })

        return verdict

    except Exception as e:
        duration_ms = round((time.monotonic() - t0) * 1000)
        logger.warning("validation_failed", extra={
            "error": str(e), "duration_ms": duration_ms,
        })
        return {"verdict": "looks_right", "items": [], "overall_note": ""}
