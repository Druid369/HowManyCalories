import time
from dataclasses import dataclass

import httpx

# In-memory cache: search_term → (timestamp, NutrientsPer100g)
_cache: dict[str, tuple[float, "OFFNutrients"]] = {}
_CACHE_TTL = 3600
_CACHE_MAX = 200

OFF_SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl"
OFF_USER_AGENT = "HowManyCalories/1.0 (food calorie estimation app)"


@dataclass
class OFFNutrients:
    calories: float
    protein_g: float
    fat_g: float
    carbs_g: float
    description: str
    barcode: str


def _extract_nutrients(product: dict) -> OFFNutrients | None:
    """Extract per-100g macros from an OpenFoodFacts product."""
    nutriments = product.get("nutriments", {})

    cal = nutriments.get("energy-kcal_100g") or nutriments.get("energy_100g", 0)
    # energy_100g is often in kJ — convert if suspiciously high
    if cal and cal > 900 and not nutriments.get("energy-kcal_100g"):
        cal = round(cal / 4.184)

    protein = nutriments.get("proteins_100g", 0) or 0
    fat = nutriments.get("fat_100g", 0) or 0
    carbs = nutriments.get("carbohydrates_100g", 0) or 0

    if cal == 0 and protein == 0 and fat == 0:
        return None

    # Sanity: reject impossibly high values
    if cal > 950:
        return None

    name = product.get("product_name", "") or product.get("product_name_ru", "") or ""
    brand = product.get("brands", "")
    description = f"{brand} {name}".strip() if brand else name

    return OFFNutrients(
        calories=float(cal),
        protein_g=float(protein),
        fat_g=float(fat),
        carbs_g=float(carbs),
        description=description,
        barcode=product.get("code", ""),
    )


def _score_match(query: str, product: dict) -> float:
    """Score how well an OpenFoodFacts result matches our query."""
    name = (product.get("product_name", "") or "").lower()
    name_ru = (product.get("product_name_ru", "") or "").lower()
    brand = (product.get("brands", "") or "").lower()
    full_text = f"{brand} {name} {name_ru}"

    query_lower = query.lower()
    query_words = set(query_lower.replace(",", " ").split())

    if not query_words:
        return 0.0

    text_words = set(full_text.replace(",", " ").split())

    # Forward match: fraction of query words in product text
    forward = len(query_words & text_words) / len(query_words)

    # Exact substring bonus
    substring_bonus = 0.3 if query_lower in full_text else 0.0

    # Completeness score (prefer products with nutrition data filled in)
    nutriments = product.get("nutriments", {})
    has_data = 0.1 if nutriments.get("energy-kcal_100g") or nutriments.get("energy_100g") else 0.0

    return forward + substring_bonus + has_data


async def search_food(query: str) -> OFFNutrients | None:
    """Search OpenFoodFacts for a food and return per-100g nutrients."""
    cache_key = f"off_{query.lower().strip()}"
    if cache_key in _cache:
        ts, result = _cache[cache_key]
        if time.time() - ts < _CACHE_TTL:
            return result
        del _cache[cache_key]

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.get(
                OFF_SEARCH_URL,
                params={
                    "search_terms": query,
                    "search_simple": 1,
                    "action": "process",
                    "json": 1,
                    "page_size": 10,
                    "fields": "code,product_name,product_name_ru,brands,nutriments",
                },
                headers={"User-Agent": OFF_USER_AGENT},
            )

            if resp.status_code != 200:
                return None

            products = resp.json().get("products", [])
            if not products:
                return None

            scored = [(p, _score_match(query, p)) for p in products]
            scored.sort(key=lambda x: x[1], reverse=True)

            for product, score in scored:
                if score < 0.3:
                    break
                result = _extract_nutrients(product)
                if result:
                    if len(_cache) >= _CACHE_MAX:
                        oldest = min(_cache, key=lambda k: _cache[k][0])
                        del _cache[oldest]
                    _cache[cache_key] = (time.time(), result)
                    return result

            return None

    except (httpx.TimeoutException, httpx.HTTPError):
        return None
