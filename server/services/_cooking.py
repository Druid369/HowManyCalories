"""Cooking method math: calorie densities, weight changes, oil absorption.

Each method maps to (kcal_multiplier, weight_change_ratio, oil_absorbed_g_per_100g_raw).
Used to (1) generate per-method cooking suggestions for raw ingredients shown
in the photo, and (2) sanity-check final calorie estimates against the
macro-derived value.

Sources for the constants below:
  - Moisture loss for grilled / baked / roasted meat: USDA Agricultural
    Handbook 102 "Food Yields" — typical 20-25% loss for medium-cooked
    beef/poultry, 30-35% for well-done.
    https://www.ars.usda.gov/ARSUserFiles/80400535/Data/retn/retn06.pdf
  - Oil absorption for deep-fried doughs (чебурек, беляш, пирожок): Russian
    food-science tables (Скурихин & Тутельян, "Химический состав
    российских пищевых продуктов"), cross-checked against published
    industry data showing 8-12g oil per 100g finished pastry.
  - Pan-fry oil pickup (~3-5g/100g raw): Bognár, Tables on Weight Yield of
    Food and Retention Factors of Food Constituents (BFE Karlsruhe, 2002).
  - Boiled / steamed weight gain (5-10%): same Bognár tables, varies by
    starch content of the ingredient.

These are typical-value tables, not exact lab numbers — they're used for
suggestion estimates the user sees as a list, not for billing.
"""

COOKING_FACTORS: dict[str, tuple[float, float, float]] = {
    "raw":        (1.00, 1.00,  0.0),
    "boiled":     (1.00, 1.10,  0.0),   # water absorbed; calorie density per 100g stays ~equal
    "steamed":    (1.00, 1.05,  0.0),
    "stewed":     (1.00, 1.05,  1.0),   # small oil addition from braising liquid
    "baked":      (1.18, 0.80,  0.0),   # ~20% moisture loss concentrates kcal
    "grilled":    (1.20, 0.77,  0.0),   # ~23% moisture loss
    "fried_pan":  (1.25, 0.85,  4.0),   # pan-fry: ~4g oil absorbed per 100g raw
    "fried_deep": (1.30, 0.80, 10.0),   # deep-fry: ~10g oil per 100g raw (чебурек/беляш/пирожок)
}

COOKING_LABELS_RU: dict[str, str] = {
    "raw":        "сырой",
    "boiled":     "варёный",
    "steamed":    "на пару",
    "stewed":     "тушёный",
    "baked":      "запечённый",
    "grilled":    "на гриле",
    "fried_pan":  "жареный (сковорода)",
    "fried_deep": "жареный (фритюр)",
}


def compute_cooking_suggestions(item: dict) -> list[dict]:
    """Generate per-cooking-method calorie estimates for a raw ingredient."""
    ai_per_100g = item.get("ai_per_100g") or {}
    raw_cal   = ai_per_100g.get("calories", 0)
    raw_prot  = ai_per_100g.get("protein_g", 0)
    raw_fat   = ai_per_100g.get("fat_g", 0)
    raw_carbs = ai_per_100g.get("carbs_g", 0)
    raw_sugar = ai_per_100g.get("sugar_g", 0)
    raw_fiber = ai_per_100g.get("fiber_g", 0)
    grams     = item.get("estimated_grams", 100)

    if raw_cal == 0 or grams == 0:
        return []

    suggestions = []
    for method, (kcal_mult, weight_ratio, oil_g_per_100_raw) in COOKING_FACTORS.items():
        cooked_weight = round(grams * weight_ratio)
        # Oil adds fat calories proportional to the raw weight
        oil_cal = oil_g_per_100_raw * 9 * (grams / 100.0)
        total_cal = round(raw_cal * kcal_mult * (grams / 100.0) + oil_cal)
        cooked_factor = cooked_weight / 100.0 if cooked_weight else 0
        suggestions.append({
            "method":          method,
            "label_ru":        COOKING_LABELS_RU[method],
            "estimated_grams": cooked_weight,
            "calories":        total_cal,
            "protein_g":       round(raw_prot * cooked_factor, 1),
            "fat_g":           round((raw_fat * kcal_mult + oil_g_per_100_raw) * (grams / 100.0), 1),
            "carbs_g":         round(raw_carbs * cooked_factor, 1),
            "sugar_g":         round(raw_sugar * cooked_factor, 1),
            "fiber_g":         round(raw_fiber * cooked_factor, 1),
        })
    return suggestions


def check_calorie_consistency(item: dict) -> bool:
    """Return True if reported calories deviate >25% from macro-derived estimate."""
    reported = item.get("calories", 0)
    if reported == 0:
        return False
    macro_derived = (
        item.get("protein_g", 0) * 4
        + item.get("carbs_g", 0) * 4
        + item.get("fat_g", 0) * 9
    )
    if macro_derived == 0:
        return False
    ratio = reported / macro_derived
    return not (0.75 <= ratio <= 1.25)
