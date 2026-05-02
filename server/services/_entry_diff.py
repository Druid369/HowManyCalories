"""Compute a structured diff between two analysis-result snapshots.

Used by the PATCH /api/entries/{id} path to produce one row per change in
the `entry_edit_log` table. The diff is field-level, item-aware, and JSON-
serialisable so each change can be persisted as its own training-data
signal: "user changed grams from 200 to 150 on item 'Курица'".

Pure function — no I/O. Failures (malformed JSON, missing keys) collapse
to an empty diff so the caller can still apply the update; we never block
a user save on diff math.
"""

from __future__ import annotations

import json
from typing import Any


# Fields on an item we care about tracking. Anything else (per_100g, bbox,
# data_source) is derived/decorative and noisy to log.
_ITEM_TRACKED_FIELDS = ("name", "estimated_grams", "calories")


def _stringify(value: Any) -> str | None:
    """Render a diff value for storage. None stays None; numbers/strings
    become their str(); dicts/lists are JSON-encoded so they round-trip."""
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _normalised_name(item: dict) -> str:
    return (item.get("name") or "").strip().lower()


def compute_entry_diff(old: dict, new: dict) -> list[dict]:
    """Diff two analysis-result dicts. Returns a list of change records.

    Record shape:
      {
        "field":      "item.estimated_grams" | "item.name" | "item.calories"
                    | "item_added" | "item_removed" | "notes",
        "item_index": int | None,    # 0-based position in the NEW list
        "item_name":  str | None,
        "old_value":  str | None,
        "new_value":  str | None,
      }

    Matching strategy:
      - Same length: positional pairing (the typical edit case — user just
        tweaked grams on existing items).
      - Length differs: name-based match on the items present in both, with
        leftovers reported as item_added / item_removed.
    """
    if not isinstance(old, dict) or not isinstance(new, dict):
        return []

    changes: list[dict] = []
    old_items = old.get("items") or []
    new_items = new.get("items") or []

    if len(old_items) == len(new_items):
        for i, (o, n) in enumerate(zip(old_items, new_items)):
            for field in _ITEM_TRACKED_FIELDS:
                ov, nv = o.get(field), n.get(field)
                if ov != nv:
                    changes.append({
                        "field":      f"item.{field}",
                        "item_index": i,
                        "item_name":  n.get("name") or o.get("name"),
                        "old_value":  _stringify(ov),
                        "new_value":  _stringify(nv),
                    })
    else:
        old_names = [_normalised_name(it) for it in old_items]
        new_names = [_normalised_name(it) for it in new_items]

        # Removed items: in old, not in new.
        for i, on in enumerate(old_names):
            if on and on not in new_names:
                gone = old_items[i]
                changes.append({
                    "field":      "item_removed",
                    "item_index": i,
                    "item_name":  gone.get("name"),
                    "old_value":  _stringify({
                        "grams":    gone.get("estimated_grams"),
                        "calories": gone.get("calories"),
                    }),
                    "new_value":  None,
                })

        # Added items: in new, not in old.
        for i, nn in enumerate(new_names):
            if nn and nn not in old_names:
                added = new_items[i]
                changes.append({
                    "field":      "item_added",
                    "item_index": i,
                    "item_name":  added.get("name"),
                    "old_value":  None,
                    "new_value":  _stringify({
                        "grams":    added.get("estimated_grams"),
                        "calories": added.get("calories"),
                    }),
                })

        # Same-name items: track gram/calorie shifts on what stayed.
        for i, nn in enumerate(new_names):
            if not nn or nn not in old_names:
                continue
            old_idx = old_names.index(nn)
            o, n = old_items[old_idx], new_items[i]
            for field in ("estimated_grams", "calories"):
                ov, nv = o.get(field), n.get(field)
                if ov != nv:
                    changes.append({
                        "field":      f"item.{field}",
                        "item_index": i,
                        "item_name":  n.get("name"),
                        "old_value":  _stringify(ov),
                        "new_value":  _stringify(nv),
                    })

    # Top-level notes change (rare but training-relevant — user adding context).
    old_notes = (old.get("notes") or "").strip()
    new_notes = (new.get("notes") or "").strip()
    if old_notes != new_notes:
        changes.append({
            "field":      "notes",
            "item_index": None,
            "item_name":  None,
            "old_value":  old_notes or None,
            "new_value":  new_notes or None,
        })

    return changes
