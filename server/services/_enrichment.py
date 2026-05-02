"""Stage 2: per-item nutrition enrichment with cross-validation.

Fallback chain (per item):
  1. Russian food DB        (primary for target market — USDA has ~no Russian dishes)
  2. USDA FoodData Central
  3. OpenFoodFacts
  4. Pure AI estimate       (last resort)

Cross-validation: when both AI and a DB return values, prefer the DB only when
they agree within 50%. Disagreement usually means Claude misidentified the
food, in which case the AI's portion-aware values are more trustworthy than a
DB hit on a wrong food.

For branded products (is_branded=true) the AI's per-100g values are taken
directly (since Claude has memorized standard packaging values), and the DB
hit is used only as a verification signal.
"""

from server.logging_config import get_logger
from server.services._events import emit
from server.services.openfoodfacts import search_food as off_search
from server.services.russian_foods import search_russian_food
from server.services.usda import search_food as usda_search

logger = get_logger(__name__)


async def _emit_enriched_if_streaming(item: dict) -> None:
    """Emit an item_enriched SSE event for this item if a stream is active.

    The endpoint binds an emitter via _events.bind_emitter when serving
    /api/analyze/stream; legacy /api/analyze leaves it unbound, in which
    case `emit` no-ops. We also short-circuit when the item carries no
    _event_id — that flags either a non-streaming caller (e.g. /api/lookup)
    or the second enrichment pass over Opus's items where the frontend
    already addresses cards by their Stage 1 id."""
    eid = item.get("_event_id")
    if not eid:
        return
    await emit("item_enriched", {
        "id":     eid,
        "source": item.get("data_source", "ai_estimate"),
        "kcal":   int(item.get("calories", 0) or 0),
    })


def values_agree(usda_val: float, claude_val: float, threshold: float = 0.5) -> bool:
    if claude_val == 0:
        return usda_val < 20
    ratio = usda_val / claude_val
    return (1 - threshold) <= ratio <= (1 + threshold)


def _apply_db_values(item: dict, db_result, grams: float, source: str) -> None:
    factor = grams / 100.0
    item["calories"]  = round(db_result.calories * factor)
    item["protein_g"] = round(db_result.protein_g * factor, 1)
    item["fat_g"]     = round(db_result.fat_g * factor, 1)
    item["carbs_g"]   = round(db_result.carbs_g * factor, 1)
    item["sugar_g"]   = round(getattr(db_result, "sugar_g", 0) * factor, 1)
    item["fiber_g"]   = round(getattr(db_result, "fiber_g", 0) * factor, 1)
    item["data_source"] = source
    item["usda_match"]  = db_result.description
    item["per_100g"] = {
        "calories":  round(db_result.calories, 1),
        "protein_g": round(db_result.protein_g, 1),
        "fat_g":     round(db_result.fat_g, 1),
        "carbs_g":   round(db_result.carbs_g, 1),
        "sugar_g":   round(getattr(db_result, "sugar_g", 0), 1),
        "fiber_g":   round(getattr(db_result, "fiber_g", 0), 1),
    }


def _apply_ai_values(
    item: dict, ai_cal, ai_prot, ai_fat, ai_carbs,
    ai_sugar=0, ai_fiber=0, *, grams: float,
) -> None:
    item["calories"]  = ai_cal
    item["protein_g"] = ai_prot
    item["fat_g"]     = ai_fat
    item["carbs_g"]   = ai_carbs
    item["sugar_g"]   = ai_sugar
    item["fiber_g"]   = ai_fiber
    item["data_source"] = "ai_estimate"
    item["usda_match"]  = None
    # Derive per-100g from grams + totals so client can rescale on edit.
    factor = 100.0 / grams if grams else 0.0
    item["per_100g"] = {
        "calories":  round(ai_cal   * factor, 1),
        "protein_g": round(ai_prot  * factor, 1),
        "fat_g":     round(ai_fat   * factor, 1),
        "carbs_g":   round(ai_carbs * factor, 1),
        "sugar_g":   round(ai_sugar * factor, 1),
        "fiber_g":   round(ai_fiber * factor, 1),
    }


async def enrich_item(item: dict, *, emit_progress: bool = True) -> dict:
    """Enrich one item: russian_db → USDA → OFF → AI fallback chain.

    `emit_progress=True` (default) fires an item_enriched SSE event after
    the item resolves — used by the first Stage 2 pass over Stage 1's items.
    The second pass (after Opus) passes False so the frontend doesn't see
    duplicate item_enriched events for the same id; revisions are surfaced
    via item_revised events emitted by the orchestrator instead.
    """
    grams       = item["estimated_grams"]
    search_term = item.get("usda_search_term", item["name"])
    is_branded  = item.get("is_branded", False)

    ai_cal   = item.get("ai_calories", 0)
    ai_prot  = item.get("ai_protein_g", 0)
    ai_fat   = item.get("ai_fat_g", 0)
    ai_carbs = item.get("ai_carbs_g", 0)
    ai_sugar = item.get("ai_sugar_g", 0)
    ai_fiber = item.get("ai_fiber_g", 0)

    ai_per_100g = item.get("ai_per_100g")
    if is_branded and ai_per_100g and ai_per_100g.get("calories", 0) > 0:
        factor = grams / 100.0
        item["calories"]  = round(ai_per_100g["calories"] * factor)
        item["protein_g"] = round(ai_per_100g.get("protein_g", 0) * factor, 1)
        item["fat_g"]     = round(ai_per_100g.get("fat_g", 0) * factor, 1)
        item["carbs_g"]   = round(ai_per_100g.get("carbs_g", 0) * factor, 1)
        item["sugar_g"]   = round(ai_per_100g.get("sugar_g", 0) * factor, 1)
        item["fiber_g"]   = round(ai_per_100g.get("fiber_g", 0) * factor, 1)
        item["data_source"] = "ai_branded"
        item["usda_match"]  = None
        item["per_100g"] = {
            "calories":  round(ai_per_100g.get("calories", 0),  1),
            "protein_g": round(ai_per_100g.get("protein_g", 0), 1),
            "fat_g":     round(ai_per_100g.get("fat_g", 0),     1),
            "carbs_g":   round(ai_per_100g.get("carbs_g", 0),   1),
            "sugar_g":   round(ai_per_100g.get("sugar_g", 0),   1),
            "fiber_g":   round(ai_per_100g.get("fiber_g", 0),   1),
        }

        db_result = await usda_search(search_term) or await off_search(search_term)
        if db_result:
            db_cal = round(db_result.calories * (grams / 100.0))
            if values_agree(db_cal, item["calories"]):
                item["data_source"] = "verified"
                item["usda_match"]  = db_result.description

        logger.info("item_enriched", extra={
            "item_name": item.get("name"),
            "search_term": search_term,
            "path": "branded",
            "source": item["data_source"],
            "calories": item["calories"],
        })
        if emit_progress: await _emit_enriched_if_streaming(item)
        return item

    # 1. Russian food DB — checked first because USDA has almost no Russian dishes.
    #    Cross-validation matches the USDA/OFF branches: prefer the DB hit only
    #    when it agrees with the AI estimate (within values_agree threshold).
    #    Disagreement usually signals a fuzzy name match against a wrong dish,
    #    in which case the AI's portion-aware values are more trustworthy.
    ru = search_russian_food(item.get("name", "")) or search_russian_food(search_term)
    if ru:
        ru_cal = round(ru.calories * (grams / 100.0))
        agree = ai_cal > 0 and values_agree(ru_cal, ai_cal)
        if agree:
            _apply_db_values(item, ru, grams, "russian_db")
        elif ai_cal > 0:
            _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs, ai_sugar, ai_fiber, grams=grams)
        else:
            _apply_db_values(item, ru, grams, "russian_db")

        logger.info("item_enriched", extra={
            "item_name": item.get("name"),
            "search_term": search_term,
            "path": "russian_db",
            "source": item["data_source"],
            "calories": item["calories"],
            "russian_db_kcal_per100": ru.calories,
            "russian_db_scaled": ru_cal,
            "ai_cal": ai_cal,
            "values_agree": agree,
            "russian_match": ru.name_ru,
        })
        if emit_progress: await _emit_enriched_if_streaming(item)
        return item

    # 2. USDA FoodData Central
    usda = await usda_search(search_term)
    if usda:
        usda_cal = round(usda.calories * (grams / 100.0))
        agree = ai_cal > 0 and values_agree(usda_cal, ai_cal)
        if agree:
            _apply_db_values(item, usda, grams, "usda")
        elif ai_cal > 0:
            _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs, ai_sugar, ai_fiber, grams=grams)
        else:
            _apply_db_values(item, usda, grams, "usda")

        logger.info("item_enriched", extra={
            "item_name": item.get("name"),
            "search_term": search_term,
            "path": "usda",
            "source": item["data_source"],
            "calories": item["calories"],
            "usda_kcal_per100": usda.calories,
            "usda_scaled": usda_cal,
            "ai_cal": ai_cal,
            "values_agree": agree,
            "usda_match": usda.description,
        })
        if emit_progress: await _emit_enriched_if_streaming(item)
        return item

    # 3. OpenFoodFacts
    off = await off_search(search_term)
    if off:
        off_cal = round(off.calories * (grams / 100.0))
        agree = ai_cal > 0 and values_agree(off_cal, ai_cal)
        if agree:
            _apply_db_values(item, off, grams, "openfoodfacts")
        elif ai_cal > 0:
            _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs, ai_sugar, ai_fiber, grams=grams)
        else:
            _apply_db_values(item, off, grams, "openfoodfacts")

        logger.info("item_enriched", extra={
            "item_name": item.get("name"),
            "search_term": search_term,
            "path": "openfoodfacts",
            "source": item["data_source"],
            "calories": item["calories"],
            "off_kcal_per100": off.calories,
            "off_scaled": off_cal,
            "ai_cal": ai_cal,
            "values_agree": agree,
            "usda_match": off.description,
        })
        if emit_progress: await _emit_enriched_if_streaming(item)
        return item

    # 4. Pure AI estimate fallback
    _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs, ai_sugar, ai_fiber, grams=grams)
    logger.info("item_enriched", extra={
        "item_name": item.get("name"),
        "search_term": search_term,
        "path": "ai_fallback",
        "source": "ai_estimate",
        "calories": ai_cal,
    })
    if emit_progress: await _emit_enriched_if_streaming(item)
    return item
