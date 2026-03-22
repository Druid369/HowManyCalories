import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
if not ANTHROPIC_API_KEY:
    import warnings
    warnings.warn("ANTHROPIC_API_KEY not set — /api/analyze will return 503")

CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
CLAUDE_JUDGE_MODEL = os.getenv("CLAUDE_JUDGE_MODEL", "claude-opus-4-20250514")
MAX_IMAGE_SIZE_MB = 5

USDA_API_KEY = os.getenv("USDA_API_KEY", "DEMO_KEY")
USDA_API_BASE = "https://api.nal.usda.gov/fdc/v1"
