"""Local Russian/CIS food reference database.

Per-100g nutritional values for ~150 common Russian and post-Soviet dishes,
products, and ingredients. Used as the first lookup step in _enrich_item —
before USDA — because USDA contains almost no Russian cuisine entries.

Data lives in data/russian_foods.json so calorie tables can be edited without
touching Python. A prefix index over the search_keys is built at module load
to keep search at O(matched_keys) instead of O(entries × keys).

Search supports both Russian (with declension-tolerant prefix matching) and
English queries (via search_keys).

Data sources: Russian nutritional tables (Скурихин), ФГБУ «ФИЦ питания
и биотехнологии», manufacturer packaging values for branded products.
"""

import json
import pathlib
from dataclasses import dataclass, field

_DATA_PATH = pathlib.Path(__file__).resolve().parent.parent.parent / "data" / "russian_foods.json"


@dataclass
class RuFoodEntry:
    name_ru:     str
    name_en:     str
    search_keys: list[str]
    calories:    float
    protein_g:   float
    fat_g:       float
    carbs_g:     float
    sugar_g:     float = 0.0
    fiber_g:     float = 0.0
    description: str = field(default="")

    def __post_init__(self) -> None:
        if not self.description:
            self.description = self.name_ru


def _load_entries() -> list[RuFoodEntry]:
    with _DATA_PATH.open("r", encoding="utf-8") as f:
        raw = json.load(f)
    return [RuFoodEntry(**row) for row in raw]


_ENTRIES: list[RuFoodEntry] = _load_entries()

# Prefix index: first 3 chars of every word in every search_key → set of entry indices.
# Lets us cut the candidate set from ~150 entries to typically <20 before scoring.
_PREFIX_LEN = 3
_prefix_index: dict[str, set[int]] = {}
for _idx, _entry in enumerate(_ENTRIES):
    for _key in _entry.search_keys:
        for _word in _key.lower().split():
            if len(_word) >= _PREFIX_LEN:
                _prefix_index.setdefault(_word[:_PREFIX_LEN], set()).add(_idx)


def _prefix_match(a: str, b: str, min_len: int = 4) -> bool:
    """True if one word is a prefix of the other — handles Russian declensions."""
    if len(a) < min_len or len(b) < min_len:
        return a == b
    return a.startswith(b) or b.startswith(a)


def _score(query: str, entry: RuFoodEntry) -> float:
    """Score how well query matches an entry. Returns 0.0–1.0."""
    q = query.lower().strip().replace(",", " ")
    if not q:
        return 0.0

    best = 0.0
    for key in entry.search_keys:
        k = key.lower()

        # Exact match
        if q == k:
            return 1.0

        # Full substring (one contains the other).
        # Require length similarity to prevent "ham" matching "hamburger".
        if q in k or k in q:
            length_ratio = min(len(q), len(k)) / max(len(q), len(k))
            if length_ratio >= 0.4:
                best = max(best, 0.85)
            continue

        # Word-level overlap with prefix matching for Russian declensions
        q_words = q.split()
        k_words = k.split()
        if not q_words or not k_words:
            continue

        matched = sum(
            1 for qw in q_words
            if any(_prefix_match(qw, kw) for kw in k_words)
        )
        score = matched / len(q_words)
        best = max(best, score)

    return best


def _candidate_indices(query: str) -> list[int]:
    """Use the prefix index to cut down the candidate set before full scoring."""
    q = query.lower().strip().replace(",", " ")
    candidates: set[int] = set()
    for word in q.split():
        if len(word) >= _PREFIX_LEN:
            candidates |= _prefix_index.get(word[:_PREFIX_LEN], set())
    return sorted(candidates) if candidates else list(range(len(_ENTRIES)))


def search_russian_food(query: str, threshold: float = 0.5) -> RuFoodEntry | None:
    """Return the best-matching Russian food entry, or None if below threshold."""
    if not query or not query.strip():
        return None

    best_entry: RuFoodEntry | None = None
    best_score = 0.0

    for idx in _candidate_indices(query):
        entry = _ENTRIES[idx]
        s = _score(query, entry)
        if s > best_score:
            best_score = s
            best_entry = entry

    if best_score >= threshold:
        return best_entry
    return None
