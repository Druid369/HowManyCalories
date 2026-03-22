import time
from dataclasses import dataclass

import httpx

from server.config import USDA_API_KEY, USDA_API_BASE

# Nutrient numbers we care about
_ENERGY_NUMBERS = {"208", "1008", "2047", "2048", "957", "958"}
_PROTEIN_NUMBER = "203"
_FAT_NUMBER = "204"
_CARBS_NUMBER = "205"

# In-memory cache: search_term → (timestamp, NutrientsPer100g)
_cache: dict[str, tuple[float, "NutrientsPer100g"]] = {}
_CACHE_TTL = 3600  # 1 hour
_CACHE_MAX = 200

# Words that indicate a fundamentally different food category
_PENALTY_WORDS = {
    "dressing", "sauce", "syrup", "candy", "beverage", "drink",
    "supplement", "powder", "mix", "baby", "infant", "formula",
    "oil", "shortening", "margarine",
}


@dataclass
class NutrientsPer100g:
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float
    description: str
    fdc_id: int


def _extract_nutrients(food: dict) -> NutrientsPer100g | None:
    """Extract per-100g macros from a USDA food search result."""
    nutrients = food.get("foodNutrients", [])
    cal = 0.0
    protein = 0.0
    fat = 0.0
    carbs = 0.0

    for n in nutrients:
        num = str(n.get("nutrientNumber", ""))
        val = n.get("value", 0) or 0
        if num in _ENERGY_NUMBERS:
            cal = max(cal, val)
        elif num == _PROTEIN_NUMBER:
            protein = val
        elif num == _FAT_NUMBER:
            fat = val
        elif num == _CARBS_NUMBER:
            carbs = val

    if cal == 0 and protein == 0 and fat == 0:
        return None

    # Sanity: reject entries with impossibly high calorie counts (per 100g)
    # Pure fat is ~900 kcal/100g, anything above that is likely per-serving data
    if cal > 950:
        return None

    return NutrientsPer100g(
        calories=cal,
        protein_g=protein,
        fat_g=fat,
        carbs_g=carbs,
        description=food.get("description", ""),
        fdc_id=food.get("fdcId", 0),
    )


def _score_match(query: str, food: dict) -> float:
    """Score how well a USDA result matches our query. Higher = better."""
    desc = food.get("description", "").lower()
    query_lower = query.lower()
    query_words = set(query_lower.replace(",", " ").split())
    desc_words = set(desc.replace(",", " ").split())

    # Remove trivial words
    stop = {"and", "or", "the", "a", "an", "of", "with", "in", "raw", "cooked"}
    query_sig = query_words - stop
    desc_sig = desc_words - stop

    if not query_sig:
        return 0.0

    # Forward match: what fraction of query words appear in description
    forward = len(query_sig & desc_sig) / len(query_sig)

    # Backward penalty: if description has important words NOT in query,
    # it's likely a different food (e.g. "dressing" in "salad dressing")
    extra_words = desc_sig - query_sig
    penalty_hits = extra_words & _PENALTY_WORDS
    category_penalty = len(penalty_hits) * 0.4

    # Data type bonus (small — tiebreaker only)
    dtype = food.get("dataType", "")
    type_bonus = {
        "Foundation": 0.1,
        "SR Legacy": 0.1,
        "Survey (FNDDS)": 0.08,
        "Branded": 0.0,
    }

    # Exact substring match bonus
    substring_bonus = 0.25 if query_lower in desc else 0.0

    # Description length penalty (branded items tend to be very long)
    length_penalty = 0.1 if len(desc) > 80 else 0.0

    score = forward + type_bonus.get(dtype, 0) + substring_bonus - category_penalty - length_penalty

    return score


async def search_food(query: str) -> NutrientsPer100g | None:
    """Search USDA FoodData Central for a food and return per-100g nutrients."""
    if not USDA_API_KEY:
        return None

    # Check cache
    cache_key = query.lower().strip()
    if cache_key in _cache:
        ts, result = _cache[cache_key]
        if time.time() - ts < _CACHE_TTL:
            return result
        del _cache[cache_key]

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            # Single search across all data types — bigger pool, better matching
            resp = await client.post(
                f"{USDA_API_BASE}/foods/search",
                params={"api_key": USDA_API_KEY},
                json={
                    "query": query,
                    "pageSize": 15,
                },
            )

            if resp.status_code != 200:
                return None

            foods = resp.json().get("foods", [])
            if not foods:
                return None

            # Score and pick best match
            scored = [(food, _score_match(query, food)) for food in foods]
            scored.sort(key=lambda x: x[1], reverse=True)

            # Require minimum relevance — prevents "salad" matching "salad dressing"
            for food, score in scored:
                if score < 0.4:
                    break
                result = _extract_nutrients(food)
                if result:
                    # Cache it
                    if len(_cache) >= _CACHE_MAX:
                        oldest = min(_cache, key=lambda k: _cache[k][0])
                        del _cache[oldest]
                    _cache[cache_key] = (time.time(), result)
                    return result

            return None

    except (httpx.TimeoutException, httpx.HTTPError):
        return None
