"""Three-stage analyze pipeline orchestrator.

Public entrypoint: analyze_image(image_bytes, media_type, portion_hint).

Pipeline:
  Stage 1 — Sonnet vision identifies foods + portion estimates    (this file)
  Stage 2 — DB enrichment per item (russian → USDA → OFF → AI)    (_enrichment)
  Stage 3 — Opus reviews photo + draft and produces final verdict (_judge)

Cross-cutting concerns:
  - Prompts:           _prompts
  - Cooking math:      _cooking
  - JSON parsing:      _json
  - DB scan write:     server.database.write_scan (called fire-and-forget)
"""

import asyncio
import base64
import copy
import datetime
import hashlib
import json
import time

import anthropic

from server.config import ANTHROPIC_API_KEY, CLAUDE_MODEL, DB_PATH
from server.database import get_cached_scan_by_hash, write_scan
from server.logging_config import get_logger, get_request_id
from server.services._cooking import (
    check_calorie_consistency, compute_cooking_suggestions,
)
from server.services._enrichment import enrich_item
from server.services._events import emit
from server.services._json import parse_json_response
from server.services._judge import judge_with_opus
from server.services._prompts import SYSTEM_PROMPT

logger = get_logger(__name__)
client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


# Anthropic per-token pricing (USD per token). Sonnet 4.6 / Opus 4.6
# rates as of late 2025 — used only for the per-scan cost-summary log
# line, not for billing. Update if a new model is wired into config.
_SONNET_INPUT_USD_PER_TOKEN  = 3.0  / 1_000_000
_SONNET_OUTPUT_USD_PER_TOKEN = 15.0 / 1_000_000
_OPUS_INPUT_USD_PER_TOKEN    = 15.0 / 1_000_000
_OPUS_OUTPUT_USD_PER_TOKEN   = 75.0 / 1_000_000


def _estimate_scan_cost_usd(
    stage1_in: int, stage1_out: int, stage3_in: int, stage3_out: int,
) -> float:
    return (
        stage1_in  * _SONNET_INPUT_USD_PER_TOKEN
        + stage1_out * _SONNET_OUTPUT_USD_PER_TOKEN
        + stage3_in  * _OPUS_INPUT_USD_PER_TOKEN
        + stage3_out * _OPUS_OUTPUT_USD_PER_TOKEN
    )


def _can_skip_opus(parsed: dict) -> bool:
    """Decide whether Stage 1 was confident enough to skip Opus.

    Heuristic: every item came back with confidence='high' AND no item
    asked for clarification (those signal hidden ingredients Sonnet
    explicitly punted on). On either negative signal, run Opus as today.

    Saves ~$0.05 + 10-20s per qualifying scan. The Stage 2 DB enrichment
    still runs, so any DB-correctable issues still get caught.
    """
    items = parsed.get("items") or []
    if not items:
        return False
    if any(it.get("needs_clarification") for it in items):
        return False
    return all(it.get("confidence") == "high" for it in items)


def _build_totals(items: list[dict]) -> dict:
    return {
        "calories":  sum(it.get("calories", 0) for it in items),
        "protein_g": round(sum(it.get("protein_g", 0) for it in items), 1),
        "fat_g":     round(sum(it.get("fat_g", 0) for it in items), 1),
        "carbs_g":   round(sum(it.get("carbs_g", 0) for it in items), 1),
        "sugar_g":   round(sum(it.get("sugar_g", 0) for it in items), 1),
        "fiber_g":   round(sum(it.get("fiber_g", 0) for it in items), 1),
    }


def _cleanup_item(item: dict) -> dict:
    """Remove internal fields before returning to client.

    `per_100g` is intentionally kept — the client uses it to rescale macros
    when the user edits an item's gram count. `usda_search_term` is also kept
    so /api/lookup and /api/validate-edits can replay the correct query
    without re-deriving it from the display name.
    """
    for key in (
        "ai_calories", "ai_protein_g", "ai_fat_g", "ai_carbs_g",
        "ai_sugar_g", "ai_fiber_g",
        "ai_per_100g", "portion_reasoning", "is_branded",
        # _event_id is the SSE correlation id used by the streaming
        # endpoint to address per-item events. It must never leak to the
        # client response — the report card + history don't use it.
        "_event_id",
    ):
        item.pop(key, None)
    return item


async def analyze_image(
    image_bytes: bytes, media_type: str, portion_hint: str | None = None,
    user_id: int | None = None,
) -> dict:
    """Three-stage pipeline: Sonnet identifies → DB enriches → Opus judges.

    `user_id` is the authenticated user's id (Phase 2). It's stamped onto
    the persisted scan row so the admin dashboard knows who uploaded what
    and `/api/entries` can list a user's history. None is allowed for
    safety but the route handler should always pass a real id."""
    pipeline_start  = time.monotonic()
    image_sha256    = hashlib.sha256(image_bytes).hexdigest()
    image_b64       = base64.b64encode(image_bytes).decode("utf-8")
    scan_id         = get_request_id()

    # Image-content dedup: identical bytes → reuse a recent successful
    # final_json instead of burning Sonnet+Opus tokens. The cache helper
    # filters by content hash, age (30d), and success markers; a hit
    # short-circuits the pipeline. We still persist a fresh scan row so
    # this user gets their own attribution + entry id.
    cached = await get_cached_scan_by_hash(DB_PATH, image_sha256)
    if cached:
        return await _serve_cached_scan(
            cached, scan_id, image_sha256, media_type,
            len(image_bytes), portion_hint, user_id, pipeline_start,
        )

    user_text = "Identify the food items in this image and estimate portion weights in grams."
    if portion_hint:
        user_text += f" Portion context: {portion_hint}"

    # SSE: announce the run + start Stage 1. Calls no-op cleanly for the
    # legacy /api/analyze caller (no emitter bound for that ContextVar).
    # ETA is a coarse 35s estimate — the client ticks it down between
    # progress events and floors at 1s remaining.
    await emit("started",  {"eta_seconds": 35, "expected_stages": 3})
    await emit("log",      {"text": "Смотрю на блюдо..."})
    await emit("progress", {"stage": 1, "progress": 0.05})

    # ── Stage 1: Sonnet vision ─────────────────────────────────────────────────
    t0 = time.monotonic()
    message = await client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
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
                    {"type": "text", "text": user_text},
                ],
            }
        ],
    )
    stage1_ms      = round((time.monotonic() - t0) * 1000)
    stage1_in_tok  = message.usage.input_tokens
    stage1_out_tok = message.usage.output_tokens
    raw_text       = message.content[0].text
    parsed         = parse_json_response(raw_text)
    parsed["image_sha256"] = image_sha256
    stage1_snapshot = copy.deepcopy(parsed)

    logger.info("stage1_complete", extra={
        "model": CLAUDE_MODEL,
        "is_food": parsed.get("is_food"),
        "item_count": len(parsed.get("items", [])),
        "stop_reason": message.stop_reason,
        "input_tokens": stage1_in_tok,
        "output_tokens": stage1_out_tok,
        "duration_ms": stage1_ms,
    })

    if not parsed.get("is_food") or not parsed.get("items"):
        total_ms = round((time.monotonic() - pipeline_start) * 1000)
        asyncio.create_task(_write_scan(
            scan_id=scan_id, image_sha256=image_sha256, media_type=media_type,
            image_size_bytes=len(image_bytes), portion_hint=portion_hint,
            stage1_json=json.dumps(stage1_snapshot, ensure_ascii=False),
            stage2_json=None, stage3_json=None,
            final_json=json.dumps(parsed, ensure_ascii=False),
            total_calories=0, item_count=0, confidence=None, data_sources="[]",
            stage1_ms=stage1_ms, stage2_ms=0, stage3_ms=0, total_ms=total_ms,
            stage1_in_tok=stage1_in_tok, stage1_out_tok=stage1_out_tok,
            stage3_in_tok=0, stage3_out_tok=0, opus_used=0, calorie_warn=0,
            user_id=user_id,
        ))
        # Cost log even on the no-food short-circuit so dashboards capture
        # the Sonnet spend (~$0.005 typical) for unrecognised images.
        logger.info("scan_cost", extra={
            "scan_id":       scan_id,
            "user_id":       user_id,
            "stage1_tokens": stage1_in_tok + stage1_out_tok,
            "stage3_tokens": 0,
            "total_tokens":  stage1_in_tok + stage1_out_tok,
            "estimated_usd": round(_estimate_scan_cost_usd(
                stage1_in_tok, stage1_out_tok, 0, 0,
            ), 4),
            "opus_used":     0,
            "cached":        0,
            "no_food":       1,
        })
        parsed["scan_id"] = scan_id
        return parsed

    # SSE: assign per-item correlation ids + emit Stage 1 results. Each
    # item_found event seeds a card on the frontend; subsequent events
    # (item_enriched, item_revised) target that card by id. The bbox is
    # decorative — Sonnet's spatial accuracy is roughly quadrant-level,
    # so the frontend renders corner brackets at the percentage center
    # rather than committing to a precise rectangle.
    items_list = parsed.get("items", [])
    for i, item in enumerate(items_list):
        item["_event_id"] = f"i_{i}"
        bbox = item.get("bbox") or {}
        bbox_payload = None
        try:
            bx = float(bbox.get("x"))
            by = float(bbox.get("y"))
            if 0 <= bx <= 100 and 0 <= by <= 100:
                bbox_payload = {"x": round(bx, 1), "y": round(by, 1)}
        except (TypeError, ValueError):
            bbox_payload = None
        # Bundle the per-item log line into the item_found event so the
        # client's paced queue can render the card and log line together
        # (without that, log lines race ahead of card reveals because
        # they're cheaper for the queue to process). Lowercased verb-form
        # keeps the "Я вижу X" register — soft + first-person.
        nm = (item.get("name") or "").strip()
        log_text = f"Вижу {nm[0].lower() + nm[1:]}" if nm else None
        await emit("item_found", {
            "id":    item["_event_id"],
            "name":  item.get("name", ""),
            "grams": int(item.get("estimated_grams", 0) or 0),
            "bbox":  bbox_payload,
            "log":   log_text,
        })
    if items_list:
        await emit("log", {"text": f"Нашёл {len(items_list)} элемент"
                                   f"{'ов' if len(items_list) != 1 else ''}"})
    # Stage 1 milestone: 0.40 (was 0.33) — gives Stage 1 a more
    # substantial visual share since it's the longest perceived phase.
    await emit("progress", {"stage": 1, "progress": 0.40})
    await emit("stage_done", {"stage": 1})

    # ── Stage 2+: enrichment, judge, cleanup ──────────────────────────────────
    try:
        result = await _pipeline_stages_2_and_3(
            parsed, stage1_snapshot, image_b64, media_type,
            image_bytes, scan_id, image_sha256, portion_hint,
            pipeline_start, stage1_ms, stage1_in_tok, stage1_out_tok,
            user_id,
        )
        result["scan_id"] = scan_id
        return result
    except Exception as exc:
        total_ms = round((time.monotonic() - pipeline_start) * 1000)
        error_payload = {"error": type(exc).__name__, "message": str(exc)}
        asyncio.create_task(_write_scan(
            scan_id=scan_id, image_sha256=image_sha256, media_type=media_type,
            image_size_bytes=len(image_bytes), portion_hint=portion_hint,
            stage1_json=json.dumps(stage1_snapshot, ensure_ascii=False),
            stage2_json=None, stage3_json=None,
            final_json=json.dumps(error_payload, ensure_ascii=False),
            total_calories=0, item_count=0, confidence=None, data_sources="[]",
            stage1_ms=stage1_ms, stage2_ms=0, stage3_ms=0, total_ms=total_ms,
            stage1_in_tok=stage1_in_tok, stage1_out_tok=stage1_out_tok,
            stage3_in_tok=0, stage3_out_tok=0, opus_used=0, calorie_warn=0,
            user_id=user_id,
        ))
        raise


def _stage1_for_judge(parsed: dict) -> dict:
    """Build a judge-friendly draft from Stage 1 (AI estimates only).

    Stage 3 runs in parallel with Stage 2, so it can't see DB-enriched values.
    We map the ai_* fields onto the names the judge prompt expects (calories,
    protein_g, etc.) and label data_source as ai_estimate. Opus reviews the
    photo against this — DB validation lives in Stage 2 and the second
    enrichment pass that follows the verdict.
    """
    items = [
        {
            **it,
            "calories":    it.get("ai_calories", 0),
            "protein_g":   it.get("ai_protein_g", 0),
            "fat_g":       it.get("ai_fat_g", 0),
            "carbs_g":     it.get("ai_carbs_g", 0),
            "sugar_g":     it.get("ai_sugar_g", 0),
            "fiber_g":     it.get("ai_fiber_g", 0),
            "data_source": "ai_estimate",
        }
        for it in parsed.get("items", [])
    ]
    return {
        **parsed,
        "items": items,
        "total": _build_totals(items),
    }


async def _run_stage2(items: list[dict]) -> tuple[list[dict], int]:
    t = time.monotonic()
    out = await asyncio.gather(*[enrich_item(it) for it in items])
    return list(out), round((time.monotonic() - t) * 1000)


async def _pipeline_stages_2_and_3(
    parsed: dict,
    stage1_snapshot: dict,
    image_b64: str,
    media_type: str,
    image_bytes: bytes,
    scan_id: str,
    image_sha256: str,
    portion_hint: str | None,
    pipeline_start: float,
    stage1_ms: int,
    stage1_in_tok: int,
    stage1_out_tok: int,
    user_id: int | None = None,
) -> dict:
    # ── Opus gating ───────────────────────────────────────────────────────────
    # If Stage 1 came back fully confident with no clarification asks, the
    # photo was unambiguous and Opus rarely changes the verdict. Skip it
    # and run Stage 2 alone — saves ~$0.05 + ~10-20s per qualifying scan.
    # Stage 2's DB enrichment + cross-validation still corrects identification
    # mistakes, so the safety net is preserved.
    skip_opus = _can_skip_opus(parsed)

    # ── Stages 2 + 3 in parallel (with serialised perception) ─────────────────
    # Stage 2 (DB enrichment, ~1-3s) and Stage 3 (Opus judge, ~10-20s) are
    # independent at the data layer. We launch both concurrently so total
    # wall time is min(stage2, stage3) + tail. But for the SSE stream we
    # AWAIT them separately so the user perceives Stage 2 finishing first
    # and Stage 3 carrying the long Opus wait. Without this serialisation
    # the user saw "Уточняю" flash by in <1s while "Суммирую" disappeared
    # before they could read it.
    stage1_judge_view = _stage1_for_judge(parsed)

    stage2_task = asyncio.create_task(_run_stage2(parsed["items"]))
    opus_task = (
        None if skip_opus
        else asyncio.create_task(
            judge_with_opus(image_b64, media_type, stage1_judge_view)
        )
    )

    # SSE: Stage 2 framing. item_enriched events fire from inside
    # enrich_item as each item resolves (paced by the client queue).
    await emit("log",      {"text": "Проверяю в базе..."})
    await emit("progress", {"stage": 2, "progress": 0.45})

    # Stage 2 finishes well before Opus in the typical case; await it
    # first so we can emit stage_done(2) at the right time.
    stage2_items, stage2_ms = await stage2_task

    parsed["items"] = stage2_items
    stage2_snapshot = copy.deepcopy(parsed["items"])
    parsed["total"] = _build_totals(parsed["items"])

    sources_stage2 = list(set(it.get("data_source", "ai_estimate") for it in parsed["items"]))
    logger.info("stage2_complete", extra={
        "item_count": len(parsed["items"]),
        "draft_total_kcal": parsed["total"]["calories"],
        "sources": sources_stage2,
        "duration_ms": stage2_ms,
        "ran_parallel_with_stage3": True,
    })

    await emit("progress",   {"stage": 2, "progress": 0.70})
    await emit("stage_done", {"stage": 2})

    # SSE: Stage 3 framing. When Opus runs we wait on it ("Суммирую" with
    # the long tail latency). When skipped we fast-forward through the
    # same milestones so the frontend's progress UI doesn't stall.
    if opus_task is not None:
        await emit("log",      {"text": "Перепроверяю порции..."})
        await emit("progress", {"stage": 3, "progress": 0.75})
        verdict, stage3_in_tok, stage3_out_tok, stage3_ms = await opus_task
    else:
        verdict, stage3_in_tok, stage3_out_tok, stage3_ms = None, 0, 0, 0
        logger.info("stage3_skipped", extra={
            "reason":      "stage1_high_confidence_no_clarifications",
            "item_count":  len(parsed.get("items", [])),
        })

    if verdict and verdict.get("items"):
        stage2_terms = {
            it.get("name", ""): it.get("usda_search_term", "")
            for it in parsed["items"]
            if it.get("usda_search_term")
        }
        # SSE: Opus has returned. Below we map its items back to Stage 2
        # ids, run the second enrichment pass (silenced — no item_enriched
        # events for the same id twice), then emit item_revised events
        # comparing FINAL post-2nd-enrichment values vs Stage 2.

        # Build a name→Stage2-item index so Opus's items can adopt the
        # correct _event_id. Opus often refines names ("Яичница из двух
        # яиц (жареная на сковороде)" → "Яичница-глазунья (2 яйца)") so
        # an exact name match misses most revisions; we fall back to
        # positional matching when the lengths line up.
        stage2_by_name = {
            (it.get("name") or "").strip().lower(): it
            for it in stage2_snapshot
        }
        same_length = len(verdict["items"]) == len(stage2_snapshot)

        for idx, item in enumerate(verdict["items"]):
            item["ai_calories"] = item.pop("calories", 0)
            item["ai_protein_g"] = item.pop("protein_g", 0)
            item["ai_fat_g"]    = item.pop("fat_g", 0)
            item["ai_carbs_g"]  = item.pop("carbs_g", 0)
            item["ai_sugar_g"]  = item.pop("sugar_g", 0)
            item["ai_fiber_g"]  = item.pop("fiber_g", 0)
            item.setdefault("is_branded", False)
            if not item.get("usda_search_term"):
                item["usda_search_term"] = stage2_terms.get(
                    item.get("name", ""), item.get("name", "")
                )
            # Adopt the matching Stage 2 item's _event_id so the frontend
            # card persists across the revision.
            name_key = (item.get("name") or "").strip().lower()
            stage2_match = stage2_by_name.get(name_key)
            if stage2_match is None and same_length:
                # Positional fallback. Opus tends to preserve item order
                # even when it renames; position-based matching is safer
                # than fuzzy name matching for the common case.
                stage2_match = stage2_snapshot[idx]
            if stage2_match and stage2_match.get("_event_id"):
                item["_event_id"] = stage2_match["_event_id"]

        # Second enrichment pass — silenced (emit_progress=False) so the
        # frontend doesn't see duplicate item_enriched events. We emit
        # item_revised AFTER this pass so the `to` value matches the
        # final kcal the report card will display (USDA may down-revise
        # a coarse Opus estimate, e.g. 224 → 133 for a meatloaf hit).
        enriched = await asyncio.gather(
            *[enrich_item(item, emit_progress=False) for item in verdict["items"]]
        )
        parsed["items"] = list(enriched)
        parsed["notes"] = verdict.get("notes", parsed.get("notes", ""))
        if verdict.get("health_insight"):
            parsed["health_insight"] = verdict["health_insight"]
        parsed["total"] = _build_totals(parsed["items"])

        # Now compute revision events using FINAL values vs Stage 2.
        # Threshold: ≥5 absolute kcal AND ≥5% relative — small drifts
        # (e.g. 22 → 18 lemon) aren't dramatic enough to surface.
        stage2_by_eid = {
            it.get("_event_id"): it for it in stage2_snapshot
            if it.get("_event_id")
        }
        for new_item in parsed["items"]:
            eid = new_item.get("_event_id")
            if not eid:
                continue
            old_item = stage2_by_eid.get(eid)
            if not old_item:
                continue
            old_kcal = int(old_item.get("calories", 0) or 0)
            new_kcal = int(new_item.get("calories", 0) or 0)
            if old_kcal and abs(new_kcal - old_kcal) >= 5 and \
               abs(new_kcal - old_kcal) / old_kcal >= 0.05:
                await emit("item_revised", {
                    "id":    eid,
                    "field": "kcal",
                    "from":  old_kcal,
                    "to":    new_kcal,
                })
                await emit("log", {
                    "text": f"Уточняю: {old_kcal} → {new_kcal} ккал",
                })

        await emit("log",      {"text": "Финальная оценка..."})
        await emit("progress", {"stage": 3, "progress": 0.95})
    else:
        # Opus soft-failed (judge_with_opus returns None on any error).
        # The Stage 2 enrichment stands. Tell the user something honest
        # without exposing model names — "первичные данные" reads as
        # "preliminary data," consistent with the soft AI voice.
        await emit("log",      {"text": "Использую первичные данные"})
        await emit("progress", {"stage": 3, "progress": 0.95})

    await emit("stage_done", {"stage": 3})

    # ── Calorie consistency check (log-only) ──────────────────────────────────
    any_calorie_warn = False
    for item in parsed["items"]:
        if check_calorie_consistency(item):
            any_calorie_warn = True
            reported = item.get("calories", 0)
            macro_derived = (
                item.get("protein_g", 0) * 4
                + item.get("carbs_g", 0) * 4
                + item.get("fat_g", 0) * 9
            )
            logger.warning("calorie_consistency_warn", extra={
                "item_name": item.get("name"),
                "reported_kcal": reported,
                "macro_derived_kcal": round(macro_derived),
                "ratio": round(reported / macro_derived, 3) if macro_derived else None,
            })

    # ── Cooking suggestions for raw ingredients (must run before cleanup) ─────
    for item in parsed["items"]:
        if item.get("is_raw_ingredient"):
            item["cooking_suggestions"] = compute_cooking_suggestions(item)

    # ── Overall confidence — weighted by calorie share ────────────────────────
    total_cal = parsed["total"]["calories"] or 1
    score_map = {"high": 1.0, "medium": 0.5, "low": 0.0}
    weighted = sum(
        score_map.get(item.get("confidence", "medium"), 0.5)
        * (item.get("calories", 0) / total_cal)
        for item in parsed["items"]
    )
    parsed["confidence"] = (
        "high" if weighted >= 0.7
        else "medium" if weighted >= 0.35
        else "low"
    )

    sources = list(set(item.get("data_source", "verified") for item in parsed["items"]))
    parsed["data_sources"] = sources
    parsed.setdefault("health_insight", "")

    for item in parsed.get("items", []):
        _cleanup_item(item)

    total_ms = round((time.monotonic() - pipeline_start) * 1000)

    logger.info("pipeline_complete", extra={
        "item_count": len(parsed.get("items", [])),
        "total_kcal": parsed["total"]["calories"],
        "confidence": parsed["confidence"],
        "data_sources": sources,
        "opus_used": verdict is not None and bool(verdict.get("items")),
        "total_duration_ms": total_ms,
        "stage1_ms": stage1_ms,
        "stage2_ms": stage2_ms,
        "stage3_ms": stage3_ms,
    })

    # Per-scan cost summary. One log line you can grep for in production
    # ("event=scan_cost") to answer "what did this scan cost?" / "which
    # user costs the most?" without recomputing from per-stage events.
    cost_usd = _estimate_scan_cost_usd(
        stage1_in_tok, stage1_out_tok, stage3_in_tok, stage3_out_tok,
    )
    logger.info("scan_cost", extra={
        "scan_id":       scan_id,
        "user_id":       user_id,
        "stage1_tokens": stage1_in_tok + stage1_out_tok,
        "stage3_tokens": stage3_in_tok + stage3_out_tok,
        "total_tokens":  stage1_in_tok + stage1_out_tok + stage3_in_tok + stage3_out_tok,
        "estimated_usd": round(cost_usd, 4),
        "opus_used":     int(verdict is not None and bool(verdict.get("items"))),
        "cached":        0,
    })

    asyncio.create_task(_write_scan(
        scan_id=scan_id, image_sha256=image_sha256, media_type=media_type,
        image_size_bytes=len(image_bytes), portion_hint=portion_hint,
        stage1_json=json.dumps(stage1_snapshot, ensure_ascii=False),
        stage2_json=json.dumps(stage2_snapshot, ensure_ascii=False),
        stage3_json=json.dumps(verdict, ensure_ascii=False) if verdict else None,
        final_json=json.dumps(parsed, ensure_ascii=False),
        total_calories=parsed["total"]["calories"],
        item_count=len(parsed.get("items", [])),
        confidence=parsed.get("confidence"),
        data_sources=json.dumps(sources),
        stage1_ms=stage1_ms, stage2_ms=stage2_ms,
        stage3_ms=stage3_ms, total_ms=total_ms,
        stage1_in_tok=stage1_in_tok, stage1_out_tok=stage1_out_tok,
        stage3_in_tok=stage3_in_tok, stage3_out_tok=stage3_out_tok,
        opus_used=1 if (verdict and verdict.get("items")) else 0,
        calorie_warn=1 if any_calorie_warn else 0,
        user_id=user_id,
    ))

    return parsed


async def _write_scan(
    scan_id: str,
    image_sha256: str,
    media_type: str,
    image_size_bytes: int,
    portion_hint: str | None,
    stage1_json: str | None,
    stage2_json: str | None,
    stage3_json: str | None,
    final_json: str,
    total_calories: int,
    item_count: int,
    confidence: str | None,
    data_sources: str,
    stage1_ms: int,
    stage2_ms: int,
    stage3_ms: int,
    total_ms: int,
    stage1_in_tok: int,
    stage1_out_tok: int,
    stage3_in_tok: int,
    stage3_out_tok: int,
    opus_used: int,
    calorie_warn: int,
    user_id: int | None = None,
) -> None:
    await write_scan(DB_PATH, {
        "scan_id":               scan_id,
        "created_at":            datetime.datetime.utcnow().isoformat() + "Z",
        "image_sha256":          image_sha256,
        "media_type":            media_type,
        "image_size_bytes":      image_size_bytes,
        "portion_hint":          portion_hint,
        "stage1_json":           stage1_json,
        "stage2_json":           stage2_json,
        "stage3_json":           stage3_json,
        "final_json":            final_json,
        "total_calories":        total_calories,
        "item_count":            item_count,
        "confidence":            confidence,
        "data_sources":          data_sources,
        "stage1_ms":             stage1_ms,
        "stage2_ms":             stage2_ms,
        "stage3_ms":             stage3_ms,
        "total_ms":              total_ms,
        "stage1_input_tokens":   stage1_in_tok,
        "stage1_output_tokens":  stage1_out_tok,
        "stage3_input_tokens":   stage3_in_tok,
        "stage3_output_tokens":  stage3_out_tok,
        "opus_used":             opus_used,
        "user_id":               user_id,
        "calorie_warn":          calorie_warn,
    })


async def _serve_cached_scan(
    cached: dict,
    scan_id: str,
    image_sha256: str,
    media_type: str,
    image_size_bytes: int,
    portion_hint: str | None,
    user_id: int | None,
    pipeline_start: float,
) -> dict:
    """Replay a cached final_json as if the pipeline had just run.

    Three responsibilities:
      1. Fan out synthetic SSE events so the streaming endpoint hits the
         same milestones (item_found, item_enriched, stage_done) the
         frontend's progress UI expects. The user sees a near-instant
         result with the same cards.
      2. Persist a fresh scan row attributed to THIS user (cached=1, all
         token counts zero) so admin views and edit-tracking work the same
         way on cache hits as on real runs.
      3. Emit a scan_cost log line with cached=1 so cost dashboards can
         tally savings.
    """
    result = copy.deepcopy(cached)
    items = result.get("items") or []

    await emit("started",  {"eta_seconds": 1, "expected_stages": 3})
    await emit("log",      {"text": "Узнаю это блюдо, использую сохранённый анализ..."})
    await emit("progress", {"stage": 1, "progress": 0.20})

    for i, item in enumerate(items):
        eid = f"i_{i}"
        item["_event_id"] = eid
        await emit("item_found", {
            "id":    eid,
            "name":  item.get("name", ""),
            "grams": int(item.get("estimated_grams", 0) or 0),
            "bbox":  None,
            "log":   None,
        })
        await emit("item_enriched", {
            "id":     eid,
            "source": item.get("data_source", "verified"),
            "kcal":   int(item.get("calories", 0) or 0),
        })

    await emit("stage_done", {"stage": 1})
    await emit("stage_done", {"stage": 2})
    await emit("progress",   {"stage": 3, "progress": 0.95})
    await emit("stage_done", {"stage": 3})

    # Strip the synthetic _event_id back out before persisting / returning.
    for item in items:
        item.pop("_event_id", None)

    total_ms = round((time.monotonic() - pipeline_start) * 1000)
    sources = result.get("data_sources") or []
    if isinstance(sources, list):
        data_sources_json = json.dumps(sources)
    else:
        data_sources_json = json.dumps([])

    asyncio.create_task(write_scan(DB_PATH, {
        "scan_id":               scan_id,
        "created_at":            datetime.datetime.utcnow().isoformat() + "Z",
        "image_sha256":          image_sha256,
        "media_type":            media_type,
        "image_size_bytes":      image_size_bytes,
        "portion_hint":          portion_hint,
        "stage1_json":           None,
        "stage2_json":           None,
        "stage3_json":           None,
        "final_json":            json.dumps(result, ensure_ascii=False),
        "total_calories":        (result.get("total") or {}).get("calories", 0),
        "item_count":            len(items),
        "confidence":            result.get("confidence"),
        "data_sources":          data_sources_json,
        "stage1_ms":             0,
        "stage2_ms":             0,
        "stage3_ms":             0,
        "total_ms":              total_ms,
        "stage1_input_tokens":   0,
        "stage1_output_tokens":  0,
        "stage3_input_tokens":   0,
        "stage3_output_tokens":  0,
        "opus_used":             0,
        "user_id":               user_id,
        "calorie_warn":          0,
        "cached":                1,
    }))

    logger.info("scan_cost", extra={
        "scan_id":       scan_id,
        "user_id":       user_id,
        "stage1_tokens": 0,
        "stage3_tokens": 0,
        "total_tokens":  0,
        "estimated_usd": 0.0,
        "opus_used":     0,
        "cached":        1,
    })

    result["scan_id"] = scan_id
    return result
