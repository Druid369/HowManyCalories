"""Triple-layer JSON parser for LLM responses.

Handles three common Claude output styles:
  1. Direct JSON
  2. JSON wrapped in ```json ... ``` markdown fence
  3. JSON embedded in surrounding prose (extract via brace matching)

Anything more exotic raises ValueError with a snippet of the offending text.
"""

import json
import re


def parse_json_response(raw_text: str) -> dict:
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
