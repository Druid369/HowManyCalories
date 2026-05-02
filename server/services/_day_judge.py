"""Day-level nutrition quality agent.

A single Sonnet call that looks at everything the user actually ate on a
given day (consumed entries only — skipped scans don't count) plus their
water intake, and returns a traffic-light verdict + brief commentary.

Used by the calendar widget to colour-tint each day cell. Failure modes
collapse to a benign "yellow" verdict so the calendar never breaks.
"""

import time

import anthropic

from server.config import ANTHROPIC_API_KEY, CLAUDE_MODEL
from server.logging_config import get_logger
from server.services._json import parse_json_response
from server.services._prompts import DAY_JUDGE_PROMPT
from server.services._sanitize import sanitize_for_prompt


logger = get_logger(__name__)
_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


def _sanitize_name(raw: str) -> str:
    """Item names from user-editable history feed straight into the prompt;
    sanitize_for_prompt handles control chars + injection markers. The em-dash
    fallback is kept for nicer UI rendering when a name comes through empty."""
    return sanitize_for_prompt(raw, max_len=80) or "—"


async def judge_day_quality(
    date_str: str,
    items: list[dict],
    water_ml: int,
    target_kcal: int,
) -> dict:
    """Send the day's consumed items + water to Sonnet, return a verdict.

    Returns a dict matching the DayQualityVerdict schema. On any failure
    (timeout, network, parse) returns a benign 'yellow' fallback so the
    calendar doesn't break.
    """
    if not items:
        return {"color": "yellow", "summary": "Нет записей за этот день.", "tip": ""}

    total_kcal = sum(int(i.get("calories", 0) or 0) for i in items)
    pct_of_target = (total_kcal / target_kcal * 100.0) if target_kcal else 0.0

    items_summary = "\n".join(
        f"- {_sanitize_name(i.get('name', '—'))}, {round(i.get('estimated_grams', 0))}г, "
        f"{int(i.get('calories', 0))} ккал · "
        f"Б {i.get('protein_g', 0):.0f}г, "
        f"У {i.get('carbs_g',   0):.0f}г, "
        f"Ж {i.get('fat_g',     0):.0f}г"
        for i in items
    )

    prompt = DAY_JUDGE_PROMPT.format(
        target_kcal   = target_kcal,
        total_kcal    = total_kcal,
        pct_of_target = pct_of_target,
        water_ml      = water_ml,
        items_summary = items_summary,
    )

    t0 = time.monotonic()
    try:
        msg = await _client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        duration_ms = round((time.monotonic() - t0) * 1000)

        try:
            verdict = parse_json_response(msg.content[0].text)
        except Exception as e:
            logger.warning("day_judge_parse_failed", extra={
                "error": str(e), "duration_ms": duration_ms, "date": date_str,
            })
            return {"color": "yellow", "summary": "Не удалось оценить день.", "tip": ""}

        color = verdict.get("color", "yellow")
        if color not in ("green", "yellow", "orange", "red"):
            color = "yellow"

        logger.info("day_judge_complete", extra={
            "date":         date_str,
            "color":        color,
            "total_kcal":   total_kcal,
            "item_count":   len(items),
            "water_ml":     water_ml,
            "input_tokens": msg.usage.input_tokens,
            "output_tokens": msg.usage.output_tokens,
            "duration_ms":  duration_ms,
        })

        return {
            "color":   color,
            "summary": (verdict.get("summary") or "").strip(),
            "tip":     (verdict.get("tip") or "").strip(),
        }

    except Exception as e:
        duration_ms = round((time.monotonic() - t0) * 1000)
        logger.warning("day_judge_failed", extra={
            "error": str(e), "duration_ms": duration_ms, "date": date_str,
        })
        return {"color": "yellow", "summary": "Не удалось оценить день.", "tip": ""}
