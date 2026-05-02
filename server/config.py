import os
import pathlib
import sys
from dotenv import load_dotenv

load_dotenv(override=True)

ENV = os.getenv("ENV", "dev").lower()
IS_PROD = ENV == "prod"

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
if not ANTHROPIC_API_KEY:
    import warnings
    warnings.warn("ANTHROPIC_API_KEY not set — /api/analyze will return 503")

CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6")
CLAUDE_JUDGE_MODEL = os.getenv("CLAUDE_JUDGE_MODEL", "claude-opus-4-6")
MAX_IMAGE_SIZE_MB = 5

# Per-process global cap on /api/day-quality LLM calls per UTC day.
# Slowapi's per-IP rate limit handles per-actor bursts; this is a circuit
# breaker against unexpected sustained spend (e.g. a runaway client loop or
# a coordinated abuse pattern across many IPs). Tune via env in production.
DAY_QUALITY_DAILY_CAP = int(os.getenv("DAY_QUALITY_DAILY_CAP", "1000"))

USDA_API_KEY = os.getenv("USDA_API_KEY", "DEMO_KEY")
USDA_API_BASE = "https://api.nal.usda.gov/fdc/v1"

DB_PATH = os.getenv(
    "DB_PATH",
    str(pathlib.Path(__file__).parent.parent / "data" / "scans.db"),
)

# ── Session-cookie auth ────────────────────────────────────────────────────
# Cookie config for the new session-based auth. The cookie holds an opaque
# session id (not a JWT) — actual user resolution happens server-side via the
# `sessions` table. SameSite=Lax protects against CSRF on POST while still
# letting top-level navigation (a user clicking a link to the app from email
# or messenger) carry the cookie. Secure flag is enforced in prod; in dev we
# leave it off so localhost HTTP testing works.
SESSION_COOKIE_NAME    = os.getenv("SESSION_COOKIE_NAME", "fork_session")
SESSION_LIFETIME_DAYS  = int(os.getenv("SESSION_LIFETIME_DAYS", "30"))
SESSION_COOKIE_SECURE  = IS_PROD if os.getenv("SESSION_COOKIE_SECURE") is None \
                                  else os.getenv("SESSION_COOKIE_SECURE", "").lower() == "true"
SESSION_COOKIE_SAMESITE = os.getenv("SESSION_COOKIE_SAMESITE", "lax")  # lax | strict | none

# ── Seed accounts (created on first startup, idempotent) ──────────────────
# `admin` is the regular-but-historical-data account; `0` lands directly on
# the admin dashboard. Both have role='admin' so either can reach /admin.
#
# Passwords ARE NOT defaulted — previous defaults of "1363" were committed
# in source, which meant any deployment that forgot to set the env var
# shipped with known-good credentials for two admin accounts. In dev (when
# IS_PROD is false), we fall back to the historical "1363" so local
# development still works without env setup; in prod (IS_PROD true), the
# fallback is None and main.py's seed step will skip account creation
# rather than ship a known password.
SEED_ADMIN_USERNAME      = os.getenv("SEED_ADMIN_USERNAME", "admin")
SEED_SUPERADMIN_USERNAME = os.getenv("SEED_SUPERADMIN_USERNAME", "0")
_DEV_DEFAULT_PASSWORD = "1363" if not IS_PROD else None
SEED_ADMIN_PASSWORD      = os.getenv("SEED_ADMIN_PASSWORD", _DEV_DEFAULT_PASSWORD)
SEED_SUPERADMIN_PASSWORD = os.getenv("SEED_SUPERADMIN_PASSWORD", _DEV_DEFAULT_PASSWORD)

# Per-user daily scan cap — applied in /api/analyze once user identity is
# resolved by the session-auth middleware. 0 disables the cap.
MAX_SCANS_PER_USER_PER_DAY = int(os.getenv("MAX_SCANS_PER_USER_PER_DAY", "20"))

# ── CORS ───────────────────────────────────────────────────────────────────
# Comma-separated origins via env var; wide-open only allowed in dev.
_cors_env = os.getenv("CORS_ORIGINS", "").strip()
if _cors_env:
    CORS_ORIGINS = [o.strip() for o in _cors_env.split(",") if o.strip()]
elif IS_PROD:
    CORS_ORIGINS = []
else:
    CORS_ORIGINS = ["*"]
