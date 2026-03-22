import asyncio
import base64
import json
import re

import anthropic

from server.config import ANTHROPIC_API_KEY, CLAUDE_MODEL, CLAUDE_JUDGE_MODEL
from server.services.usda import search_food as usda_search
from server.services.openfoodfacts import search_food as off_search

client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

# ── Stage 1: Sonnet identifies food + provides initial estimates ──

SYSTEM_PROMPT = """You are an expert food identification and nutrition estimation specialist. You analyze photos of food to identify items, estimate their weight in grams using chain-of-thought reasoning, and provide accurate nutritional data.

═══ IDENTIFICATION RULES ═══
1. Identify every distinct food item visible in the image.
2. For "name": clear human-readable label IN RUSSIAN (e.g. "Куриная грудка на гриле", "Картофельное пюре").
3. For branded/packaged products you recognize (Russian, CIS, or international brands — candies, chocolates, snacks, drinks, etc.): set "is_branded" to true and use the EXACT per-100g nutritional values from the product's standard packaging that you know from your training data. Examples: "Алёнка" chocolate, "Коровка" candy, "Докторская" sausage, Snickers, etc.
4. For "usda_search_term": specific ENGLISH term for USDA/OpenFoodFacts lookup (e.g. "chicken breast, grilled, skinless"). For branded products, use the product's English name or closest generic equivalent.
5. If the image does not contain food, set is_food to false and leave items empty.

═══ PORTION ESTIMATION (Chain-of-Thought) ═══
For EACH item, estimate weight step-by-step:
a) Look for reference objects to establish scale: dinner plate (≈25cm), fork (≈19cm), knife (≈20cm), smartphone (≈15cm), spoon (≈15cm), standard bowl (≈14cm diameter, 300-400ml).
b) Estimate the food's dimensions in centimeters using references.
c) Estimate volume in ml/cm³.
d) Apply the appropriate density to convert volume → grams:
   - Salad greens: 0.06 g/ml
   - Bread/pastry: 0.25-0.40 g/ml
   - Dry cereal/oats: 0.40 g/ml
   - Nuts/seeds: 0.55-0.65 g/ml
   - Cooked rice/grains: 0.70-0.80 g/ml
   - Cooked pasta: 0.75-0.85 g/ml
   - Butter/oil: 0.90-0.92 g/ml
   - Cooked meat/fish: 0.90-1.10 g/ml
   - Soups/liquids: 1.00-1.05 g/ml
   - Hard cheese: 1.00-1.20 g/ml
   - Honey/syrups: 1.30-1.45 g/ml
e) For discrete countable items (dumplings, sushi, nuggets, candies, cookies): COUNT them individually and multiply by single-item weight.
f) For packaged products: use standard package weight if recognizable (e.g. standard Snickers bar = 50g, Алёнка chocolate bar = 100g).
g) Record your reasoning in "portion_reasoning".

When uncertain, overestimate slightly (conservative for dieters).

═══ CONFIDENCE ═══
- "high": clearly identifiable food, obvious portion, reference objects visible
- "medium": identifiable but portion ambiguous (no references, piled food)
- "low": mixed dish, hidden ingredients, very unclear portion

═══ NUTRITIONAL DATA ═══
- For branded products (is_branded=true): use EXACT per-100g values from packaging, scaled to estimated portion.
- For generic foods: use your best knowledge of nutritional values per the estimated portion. Consider cooking method — it affects calorie density significantly (fried vs. boiled can differ 30-50%).

═══ HEALTH INSIGHT ═══
Write a concise nutritional assessment of the ENTIRE meal IN RUSSIAN (2-4 sentences max). Include ONLY what is genuinely useful:
- Macro balance: is protein/carbs/fat ratio reasonable?
- Key benefits if any (high protein, fiber, vitamins)
- Key concerns if any (excess sugar, saturated fat, sodium, empty calories)
- Meal context if relevant ("тяжело для перекуса", "хорошо после тренировки")
NO filler words. NO generic health advice. Only specific observations about THIS meal.

═══ NOTES ═══
In "notes", write IN RUSSIAN. Mention hidden calorie sources: oils, butter, sauces, dressings, cooking fats.

═══ OUTPUT ═══
Respond ONLY with valid JSON — no markdown, no explanation:
{
  "is_food": boolean,
  "items": [
    {
      "name": string (IN RUSSIAN),
      "is_branded": boolean,
      "usda_search_term": string (IN ENGLISH),
      "estimated_grams": number,
      "portion_reasoning": string (brief, IN ENGLISH — how you estimated the weight),
      "confidence": "high" | "medium" | "low",
      "ai_calories": number (for this portion),
      "ai_protein_g": number,
      "ai_fat_g": number,
      "ai_carbs_g": number,
      "ai_per_100g": {"calories": number, "protein_g": number, "fat_g": number, "carbs_g": number}
    }
  ],
  "health_insight": string (IN RUSSIAN, 2-4 sentences),
  "notes": string (IN RUSSIAN)
}"""

# ── Stage 3: Opus reviews the photo + draft result and produces final verdict ──

JUDGE_PROMPT = """You are a senior nutritionist reviewing a food analysis. You have the ORIGINAL PHOTO and a draft analysis from a junior system. Your job is to produce the FINAL, most accurate result.

The draft analysis was produced by:
1. An AI vision model identifying foods and estimating portions (with chain-of-thought reasoning)
2. USDA/OpenFoodFacts database lookups for nutritional data
3. Cross-checking between the two

═══ REVIEW CHECKLIST ═══
Compare the draft against what YOU see in the photo. Fix any errors:
1. IDENTIFICATION: Wrong food? Missing items? Phantom items not in the photo?
2. BRANDED PRODUCTS: If a branded product was identified (is_branded=true), verify the brand is correct. If you know the exact per-100g nutritional data from the packaging, use it.
3. PORTION SIZE: Count discrete items yourself (dumplings, candies, sushi pieces). Check portion_reasoning — does the math make sense? Verify against visual references in the photo.
4. NUTRITION: Do the values make sense? (e.g. lean chicken breast shouldn't have more fat than protein; chocolate should be ~500-550 kcal/100g not 200)
5. HEALTH INSIGHT: Is it accurate, concise, and useful? No generic filler. Fix or rewrite if needed.
6. CONFIDENCE: Does it match actual certainty?

For each item, provide YOUR best nutritional estimate for the portion shown.
Assign confidence honestly: "high" only if food is clearly identifiable and portion is obvious.

IMPORTANT: Item names, health_insight, and notes must be IN RUSSIAN.

The draft analysis is:
{draft_json}

Respond ONLY with valid JSON — the corrected final result:
{{
  "items": [
    {{
      "name": string (IN RUSSIAN),
      "is_branded": boolean,
      "usda_search_term": string (specific ENGLISH term for lookup),
      "estimated_grams": number,
      "calories": number (your best estimate for this portion),
      "protein_g": number,
      "fat_g": number,
      "carbs_g": number,
      "confidence": "high" | "medium" | "low"
    }}
  ],
  "health_insight": string (IN RUSSIAN — concise nutritional assessment, 2-4 sentences, no filler),
  "notes": string (IN RUSSIAN — brief, mention hidden calories)
}}"""


def _parse_json_response(raw_text: str) -> dict:
    """Triple-layer JSON parser: direct → code block → brace extraction."""
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        pass

    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw_text)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    match = re.search(r"\{[\s\S]*\}", raw_text)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse JSON from Claude response: {raw_text[:200]}")


def _values_agree(usda_val: float, claude_val: float, threshold: float = 0.5) -> bool:
    """Check if USDA and Claude values are within threshold of each other."""
    if claude_val == 0:
        return usda_val < 20
    ratio = usda_val / claude_val
    return (1 - threshold) <= ratio <= (1 + threshold)


def _apply_db_values(item: dict, db_result, grams: float, source: str) -> None:
    """Apply database nutritional values scaled to portion weight."""
    factor = grams / 100.0
    item["calories"] = round(db_result.calories * factor)
    item["protein_g"] = round(db_result.protein_g * factor, 1)
    item["fat_g"] = round(db_result.fat_g * factor, 1)
    item["carbs_g"] = round(db_result.carbs_g * factor, 1)
    item["data_source"] = source
    item["usda_match"] = db_result.description


def _apply_ai_values(item: dict, ai_cal, ai_prot, ai_fat, ai_carbs) -> None:
    """Apply AI-estimated nutritional values."""
    item["calories"] = ai_cal
    item["protein_g"] = ai_prot
    item["fat_g"] = ai_fat
    item["carbs_g"] = ai_carbs
    item["data_source"] = "ai_estimate"
    item["usda_match"] = None


async def _enrich_item(item: dict) -> dict:
    """Enrich one item: USDA → OpenFoodFacts → AI estimate fallback chain.

    For branded products, AI per-100g data is preferred when databases disagree,
    since Claude often knows exact packaging values for branded items.

    Internal fields (ai_*, usda_search_term, etc.) are NOT cleaned up here —
    they're preserved so the Opus judge stage can reuse English search terms.
    Cleanup happens in analyze_image() after all stages complete.
    """
    grams = item["estimated_grams"]
    search_term = item.get("usda_search_term", item["name"])
    is_branded = item.get("is_branded", False)

    ai_cal = item.get("ai_calories", 0)
    ai_prot = item.get("ai_protein_g", 0)
    ai_fat = item.get("ai_fat_g", 0)
    ai_carbs = item.get("ai_carbs_g", 0)

    print(f"  [enrich] '{item.get('name')}' → search='{search_term}' branded={is_branded}")

    # For branded products with AI per-100g data, use that as the primary source
    ai_per_100g = item.get("ai_per_100g")
    if is_branded and ai_per_100g and ai_per_100g.get("calories", 0) > 0:
        factor = grams / 100.0
        item["calories"] = round(ai_per_100g["calories"] * factor)
        item["protein_g"] = round(ai_per_100g.get("protein_g", 0) * factor, 1)
        item["fat_g"] = round(ai_per_100g.get("fat_g", 0) * factor, 1)
        item["carbs_g"] = round(ai_per_100g.get("carbs_g", 0) * factor, 1)
        item["data_source"] = "ai_branded"
        item["usda_match"] = None

        db_result = await usda_search(search_term) or await off_search(search_term)
        if db_result:
            db_cal = round(db_result.calories * (grams / 100.0))
            if _values_agree(db_cal, item["calories"]):
                item["data_source"] = "verified"
                item["usda_match"] = db_result.description
        print(f"  [enrich] → branded path, source={item['data_source']}")
    else:
        # Standard path: try USDA first, then OpenFoodFacts, then AI
        usda = await usda_search(search_term)

        if usda:
            usda_cal = round(usda.calories * (grams / 100.0))
            print(f"  [enrich] USDA hit: '{usda.description}' → {usda.calories} kcal/100g (scaled={usda_cal}, ai={ai_cal})")
            if ai_cal > 0 and _values_agree(usda_cal, ai_cal):
                _apply_db_values(item, usda, grams, "usda")
            elif ai_cal > 0:
                print(f"  [enrich] USDA/AI disagree (usda={usda_cal}, ai={ai_cal}) → using AI")
                _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs)
            else:
                _apply_db_values(item, usda, grams, "usda")
        else:
            print(f"  [enrich] USDA miss → trying OFF")
            off = await off_search(search_term)
            if off:
                off_cal = round(off.calories * (grams / 100.0))
                print(f"  [enrich] OFF hit: '{off.description}' → {off.calories} kcal/100g (scaled={off_cal}, ai={ai_cal})")
                if ai_cal > 0 and _values_agree(off_cal, ai_cal):
                    _apply_db_values(item, off, grams, "openfoodfacts")
                elif ai_cal > 0:
                    print(f"  [enrich] OFF/AI disagree (off={off_cal}, ai={ai_cal}) → using AI")
                    _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs)
                else:
                    _apply_db_values(item, off, grams, "openfoodfacts")
            else:
                print(f"  [enrich] No DB match → pure AI fallback")
                _apply_ai_values(item, ai_cal, ai_prot, ai_fat, ai_carbs)

    print(f"  [enrich] final: {item.get('calories')} kcal, source={item.get('data_source')}")
    return item


def _cleanup_item(item: dict) -> dict:
    """Remove internal fields before returning to client."""
    for key in ("ai_calories", "ai_protein_g", "ai_fat_g", "ai_carbs_g",
                "ai_per_100g", "usda_search_term", "portion_reasoning", "is_branded"):
        item.pop(key, None)
    return item


async def _judge_with_opus(image_b64: str, media_type: str, draft: dict) -> dict | None:
    """Send photo + draft analysis to Opus for final review."""
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
                "confidence": it.get("confidence"),
                "data_source": it.get("data_source"),
            }
            for it in draft.get("items", [])
        ],
        "total": draft.get("total"),
        "health_insight": draft.get("health_insight", ""),
        "notes": draft.get("notes", ""),
    }

    try:
        message = await client.messages.create(
            model=CLAUDE_JUDGE_MODEL,
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
                        {
                            "type": "text",
                            "text": JUDGE_PROMPT.format(draft_json=json.dumps(draft_summary, ensure_ascii=False, indent=2)),
                        },
                    ],
                }
            ],
        )
        return _parse_json_response(message.content[0].text)
    except Exception:
        return None


async def analyze_image(image_bytes: bytes, media_type: str, portion_hint: str | None = None) -> dict:
    """Three-stage pipeline: Sonnet identifies → USDA enriches → Opus judges."""
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    user_text = "Identify the food items in this image and estimate portion weights in grams."
    if portion_hint:
        user_text += f" Portion context: {portion_hint}"

    # ── Stage 1: Sonnet vision ──
    message = await client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=2048,
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
                    {
                        "type": "text",
                        "text": user_text,
                    },
                ],
            }
        ],
    )

    raw_text = message.content[0].text
    parsed = _parse_json_response(raw_text)

    if not parsed.get("is_food") or not parsed.get("items"):
        return parsed

    print(f"[stage1] Sonnet identified {len(parsed['items'])} items:")
    for it in parsed["items"]:
        print(f"  - {it.get('name')} | search='{it.get('usda_search_term')}' | {it.get('estimated_grams')}g | ai_cal={it.get('ai_calories')}")

    # ── Stage 2: USDA enrichment ──
    items = await asyncio.gather(*[_enrich_item(item) for item in parsed["items"]])
    parsed["items"] = items

    # Compute draft totals
    parsed["total"] = {
        "calories": sum(item["calories"] for item in items),
        "protein_g": round(sum(item["protein_g"] for item in items), 1),
        "fat_g": round(sum(item["fat_g"] for item in items), 1),
        "carbs_g": round(sum(item["carbs_g"] for item in items), 1),
    }

    # ── Stage 3: Opus judge ──
    verdict = await _judge_with_opus(image_b64, media_type, parsed)

    if verdict and verdict.get("items"):
        # Build name→search_term map from Stage 2 items (English terms)
        stage2_terms = {
            it.get("name", ""): it.get("usda_search_term", "")
            for it in parsed["items"]
            if it.get("usda_search_term")
        }

        # Opus corrected identification/portions — re-enrich with database data
        print("[judge] Opus returned verdict, re-enriching...")
        for item in verdict["items"]:
            item["ai_calories"] = item.pop("calories", 0)
            item["ai_protein_g"] = item.pop("protein_g", 0)
            item["ai_fat_g"] = item.pop("fat_g", 0)
            item["ai_carbs_g"] = item.pop("carbs_g", 0)
            item.setdefault("is_branded", False)
            # Preserve English search term: Opus → Stage 2 fallback → name
            if not item.get("usda_search_term"):
                item["usda_search_term"] = stage2_terms.get(item.get("name", ""), item.get("name", ""))

        enriched = await asyncio.gather(*[_enrich_item(item) for item in verdict["items"]])
        parsed["items"] = enriched
        parsed["notes"] = verdict.get("notes", parsed.get("notes", ""))

        # Opus may have refined health_insight
        if verdict.get("health_insight"):
            parsed["health_insight"] = verdict["health_insight"]

        parsed["total"] = {
            "calories": sum(it.get("calories", 0) for it in enriched),
            "protein_g": round(sum(it.get("protein_g", 0) for it in enriched), 1),
            "fat_g": round(sum(it.get("fat_g", 0) for it in enriched), 1),
            "carbs_g": round(sum(it.get("carbs_g", 0) for it in enriched), 1),
        }

    # Overall confidence — weighted by each item's calorie share, not worst-wins
    total_cal = parsed["total"]["calories"] or 1
    score_map = {"high": 1.0, "medium": 0.5, "low": 0.0}
    weighted = sum(
        score_map.get(item.get("confidence", "medium"), 0.5)
        * (item.get("calories", 0) / total_cal)
        for item in parsed["items"]
    )
    if weighted >= 0.7:
        parsed["confidence"] = "high"
    elif weighted >= 0.35:
        parsed["confidence"] = "medium"
    else:
        parsed["confidence"] = "low"

    # Data sources
    sources = list(set(item.get("data_source", "verified") for item in parsed["items"]))
    parsed["data_sources"] = sources

    # Ensure health_insight exists
    parsed.setdefault("health_insight", "")

    # Final cleanup — remove internal fields before returning to client
    for item in parsed.get("items", []):
        _cleanup_item(item)

    return parsed
