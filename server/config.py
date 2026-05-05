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

# ── Phase 1: 152-ФЗ legal / consent ───────────────────────────────────────
# Operator info rendered into /privacy + /terms (and later, email footers
# when SMTP comes online in Phase 2). Kept here as env-overridable so
# production values can land via Amvera env vars without a code change.
# CONSENT_VERSION_CURRENT is bumped by hand when the privacy policy
# materially changes — that re-prompts users on the next registration AND
# becomes the version stamped onto each row in the consent_log table.
OPERATOR_NAME = os.getenv("OPERATOR_NAME", "Иванов Иван Иванович")
OPERATOR_CITY = os.getenv("OPERATOR_CITY", "Москва")
CONSENT_VERSION_CURRENT = os.getenv("CONSENT_VERSION_CURRENT", "v1.2026-05")

# ── Phase 2: email infrastructure ─────────────────────────────────────────
# Transactional email goes through Unisender Go (their REST transactional
# product, not the marketing API). The API key lives ONLY in env vars —
# never committed, never logged, never echoed in error responses.
#
# EMAIL_TRANSPORT controls whether sends actually hit the network:
#   - "log" (default in dev): writes the email body to logs, no API call.
#     Lets us develop + test the auth flows end-to-end without burning
#     Unisender quota or spamming inboxes.
#   - "api": real HTTP POST to UNISENDER_API_ENDPOINT.
#
# Default endpoint is Unisender Go transactional (the product purpose-built
# for confirm/reset emails). If you signed up for the legacy/standard
# Unisender (which has list_id-based campaigns), override the endpoint env
# var — but the standard product is a worse fit for transactional and we
# don't ship a wrapper for its different request shape.
EMAIL_TRANSPORT       = os.getenv("EMAIL_TRANSPORT", "log").lower()
UNISENDER_API_KEY     = os.getenv("UNISENDER_API_KEY", "")
UNISENDER_API_ENDPOINT = os.getenv(
    "UNISENDER_API_ENDPOINT",
    "https://go1.unisender.ru/ru/transactional/api/v1/email/send.json",
)
UNISENDER_FROM_EMAIL  = os.getenv("UNISENDER_FROM_EMAIL", "noreply@myfork.ru")
UNISENDER_FROM_NAME   = os.getenv("UNISENDER_FROM_NAME", "FORK")

# Token lifetimes — per-kind, in seconds. Confirm is generous (a user
# may not check email immediately); reset is tight to limit blast
# radius if a link gets stolen.
EMAIL_CONFIRM_TOKEN_TTL_SEC = int(os.getenv("EMAIL_CONFIRM_TOKEN_TTL_SEC", str(24 * 3600)))
EMAIL_RESET_TOKEN_TTL_SEC   = int(os.getenv("EMAIL_RESET_TOKEN_TTL_SEC",   str(1 * 3600)))

# Public-facing base URL used to build links inside emails (verify,
# reset). In dev defaults to localhost; in prod set to https://myfork.ru
# so the links land where they should after the Phase 4 deploy.
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:8000")

# ── Phase 3: guest accounts ───────────────────────────────────────────────
# A guest is a hidden auto-created user with role='guest'. They can scan
# up to GUEST_FREE_SCANS times before the API gates them with a 403
# REGISTRATION_REQUIRED. Upgrading to a real user updates the same row
# (preserves user_id → preserves scans/entries/water_log/settings).
#
# Cleanup policy: abandoned guests (zero scans, older than ABANDONED_DAYS)
# and tire-kickers (under 2 scans, older than TRIAL_DAYS) get hard-
# deleted by an opportunistic boot-time job in services/_cleanup.py.
# The role='guest' filter ensures upgraded accounts are never touched.
GUEST_FREE_SCANS            = int(os.getenv("GUEST_FREE_SCANS", "5"))
GUEST_CLEANUP_ABANDONED_DAYS = int(os.getenv("GUEST_CLEANUP_ABANDONED_DAYS", "1"))
GUEST_CLEANUP_TRIAL_DAYS    = int(os.getenv("GUEST_CLEANUP_TRIAL_DAYS", "7"))
# Username prefix for auto-generated guests. Underscore was dropped so
# the format `guestXXXXXXXX` matches the existing username regex
# ([A-Za-z0-9]{1,32}) — that means a user upgrading from guest can keep
# their guestXXXXXXXX name without us special-casing the validator.
GUEST_USERNAME_PREFIX       = os.getenv("GUEST_USERNAME_PREFIX", "guest")

# ── Phase 0.5: per-username login throttle ────────────────────────────────
# slowapi's per-IP rate limit on /api/auth/login is bypassable by an
# attacker rotating residential proxies. This adds a per-username throttle
# that locks an account briefly after too many failed attempts in a
# sliding window. Default: 10 fails in 15 minutes → lock for 5 minutes.
# Successful login clears the bucket. State is in-memory (single-process
# app); restart-as-unlock is acceptable since attempts that survive a
# restart still face slow bcrypt + per-IP throttling.
LOGIN_THROTTLE_MAX_FAILS  = int(os.getenv("LOGIN_THROTTLE_MAX_FAILS",  "10"))
LOGIN_THROTTLE_WINDOW_SEC = int(os.getenv("LOGIN_THROTTLE_WINDOW_SEC", "900"))
LOGIN_THROTTLE_LOCK_SEC   = int(os.getenv("LOGIN_THROTTLE_LOCK_SEC",   "300"))

# ── CORS ───────────────────────────────────────────────────────────────────
# Comma-separated origins via env var; wide-open only allowed in dev.
_cors_env = os.getenv("CORS_ORIGINS", "").strip()
if _cors_env:
    CORS_ORIGINS = [o.strip() for o in _cors_env.split(",") if o.strip()]
elif IS_PROD:
    CORS_ORIGINS = []
else:
    CORS_ORIGINS = ["*"]
