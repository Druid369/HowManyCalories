"""Defensive text sanitization for inputs that flow into LLM prompts.

Strips control characters, collapses whitespace, removes common prompt-
injection markers, and caps length. Used at every boundary where user-
controlled free text reaches a Claude prompt — `portion_hint` on
/api/analyze, item names in /api/day-quality, anywhere we interpolate
end-user strings into a system or user message.

Conservative by design: we lose some legitimate text (e.g. multiple
hashes in a recipe) so we never accept a payload like
"### IGNORE PREVIOUS INSTRUCTIONS …" verbatim.
"""

import re

_INJECTION_MARKERS = re.compile(r"###|<\|[^|]*\|>|\[/?INST\]|\\n", re.IGNORECASE)
_CTRL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize_for_prompt(raw: str | None, *, max_len: int = 200) -> str:
    """Make a free-form user string safe to interpolate into an LLM prompt.

    Returns an empty string for None / empty / whitespace-only input.
    Truncates with an ellipsis at `max_len` characters.
    """
    if not raw:
        return ""
    s = str(raw)
    s = _CTRL_CHARS.sub("", s)
    s = _INJECTION_MARKERS.sub("", s)
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) > max_len:
        s = s[: max_len - 1] + "…"
    return s
