import asyncio
import base64
import hashlib
import json
import pathlib
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from pydantic import ValidationError
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from server.config import (
    ANTHROPIC_API_KEY, APP_BASE_URL, CLAUDE_JUDGE_MODEL, CLAUDE_MODEL,
    CONSENT_VERSION_CURRENT, CORS_ORIGINS, DAY_QUALITY_DAILY_CAP,
    DB_PATH, ENV, GUEST_CLEANUP_ABANDONED_DAYS, GUEST_CLEANUP_TRIAL_DAYS,
    GUEST_FREE_SCANS, GUEST_USERNAME_PREFIX, IS_PROD,
    MAX_IMAGE_SIZE_MB, MAX_SCANS_PER_USER_PER_DAY,
    OPERATOR_CITY, OPERATOR_NAME,
    SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD,
    SEED_SUPERADMIN_USERNAME, SEED_SUPERADMIN_PASSWORD,
    SESSION_COOKIE_NAME, SESSION_COOKIE_SAMESITE, SESSION_COOKIE_SECURE,
    SESSION_LIFETIME_DAYS,
)
from server.database import (
    backfill_entries_from_scans, count_scans_for_user,
    count_user_scans_today, create_entry, create_session, create_user,
    delete_all_user_sessions, delete_entry,
    delete_expired_email_tokens, delete_expired_sessions,
    delete_session, delete_user, find_email_token,
    get_entry, get_recent_scans, get_scan_count, get_scan_detail,
    get_scan_for_user, get_scan_write_failures, get_session_with_user,
    get_stats, get_timeline, get_user_by_email, get_user_by_id,
    get_user_by_username, get_user_settings, get_water_log,
    init_consent_log_table, init_db, init_email_tokens_table,
    init_entries_edit_columns, init_entries_table,
    init_scans_cached_column, init_user_data_tables,
    init_users_email_columns, insert_email_token,
    invalidate_user_email_tokens, list_all_users,
    list_edit_log_for_entry, list_edit_log_for_scan, list_entries_for_user,
    list_scans_for_user, mark_email_token_used, mark_email_verified,
    migrate_scans_user_id, put_user_settings, put_water_log,
    record_consent, update_entry_with_edit_tracking, update_last_login,
    update_user_avatar_path, update_user_email, update_user_password,
    update_user_profile, update_user_role, update_user_status,
    upgrade_guest_to_user,
)
from server.logging_config import configure_logging, get_logger, set_request_id
from server.models.schemas import (
    AdminResetPasswordRequest, AdminUserUpdate, AnalysisResult, AuthResponse,
    ChangePasswordRequest, DayQualityRequest, DayQualityVerdict,
    DeleteAccountRequest, EntryEditLogRecord, EntryPublic, EntryUpdate,
    Item, LoginRequest, LookupRequest, PasswordResetConfirm,
    PasswordResetRequest, ProfileUpdate, RegisterRequest,
    ScanSummary, ScansListResponse, StatsResponse, TimelineBucket,
    UpgradeGuestRequest, UserAdminPublic, UserPublic,
    ValidationRequestItem, ValidationVerdict,
)
from server.services._auth import (
    generate_guest_password, generate_guest_username, hash_password,
    new_session_id, validate_password, validate_username, verify_password,
)
from server.services._cleanup import delete_abandoned_guests
from server.services._day_judge import judge_day_quality
from server.services._email import send_email
from server.services._email_templates import (
    confirm_email_template, reset_email_template, welcome_email_template,
)
from server.services._email_tokens import (
    consume_email_token, generate_email_token,
)
from server.services._enrichment import enrich_item
from server.services._events import bind_emitter, unbind_emitter
from server.services._http import close_client, open_client
from server.services._sanitize import sanitize_for_prompt
from server.services._validator import validate_with_sonnet
from server.services.claude_vision import analyze_image

IMAGES_DIR  = pathlib.Path(DB_PATH).parent / "images"
AVATARS_DIR = pathlib.Path(DB_PATH).parent / "avatars"

configure_logging()
logger = get_logger(__name__)


async def _seed_admin_users() -> None:
    """Idempotently create the seeded admin accounts on first startup.

    Both `admin` and `0` get role='admin'. They differ only in the post-
    login redirect target — that's a frontend concern (script.js inspects
    username after login). Skipping silently if either already exists, so
    a deploy with rotated SEED_*_PASSWORD env vars does NOT change the
    stored hash. Password rotation must go through the change-password
    flow, not env-var redeploys.
    """
    for username, password in (
        (SEED_ADMIN_USERNAME,      SEED_ADMIN_PASSWORD),
        (SEED_SUPERADMIN_USERNAME, SEED_SUPERADMIN_PASSWORD),
    ):
        existing = await get_user_by_username(DB_PATH, username)
        if existing:
            continue
        # In prod, the password defaults to None (no committed default) so
        # operators can't accidentally ship a known-good credential. Skip
        # seeding loudly rather than crashing — first deploy can register
        # an admin manually or set SEED_*_PASSWORD env vars.
        if not password:
            logger.warning("admin_user_seed_skipped_no_password", extra={
                "username": username,
                "reason": "set SEED_ADMIN_PASSWORD / SEED_SUPERADMIN_PASSWORD to seed",
            })
            continue
        try:
            user_id = await create_user(
                DB_PATH, username, hash_password(password), role="admin",
            )
            logger.info("admin_user_seeded", extra={
                "user_id": user_id, "username": username,
            })
        except Exception as e:
            # Don't crash startup over a seeding failure (e.g. race between
            # two workers booting at once and both inserting). Log loudly.
            logger.error("admin_user_seed_failed", extra={
                "username": username, "error": str(e),
            }, exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db(DB_PATH)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    AVATARS_DIR.mkdir(parents=True, exist_ok=True)
    await _seed_admin_users()
    # Phase 2 migrations — must run AFTER _seed_admin_users so the admin
    # user_id exists for the scans backfill. All idempotent: safe on every
    # boot, no-op once already applied.
    try:
        await migrate_scans_user_id(DB_PATH, SEED_ADMIN_USERNAME)
        # Image-dedup `cached` column on scans. Idempotent — adds the
        # column on legacy installs, no-op on fresh ones.
        await init_scans_cached_column(DB_PATH)
        await init_entries_table(DB_PATH)
        # Edit-tracking columns + entry_edit_log table. Order matters:
        # init_entries_table CREATE-IF-NOT-EXISTS leaves a pre-existing
        # `entries` table untouched, so this migration is what actually
        # adds updated_at / edit_count / was_edited on upgraded installs.
        await init_entries_edit_columns(DB_PATH)
        await init_user_data_tables(DB_PATH)  # Phase 3B: settings + water log
        # Phase 1: 152-ФЗ consent audit log. Idempotent — safe on every
        # boot, depends only on the `users` table existing (FK target).
        await init_consent_log_table(DB_PATH)
        # Phase 2: email columns on users + email_tokens table.
        # init_users_email_columns must run BEFORE init_email_tokens_table
        # since the latter has a FK to users(id) and we want both
        # migrations to land in the same boot. Both idempotent.
        await init_users_email_columns(DB_PATH)
        await init_email_tokens_table(DB_PATH)
        admin = await get_user_by_username(DB_PATH, SEED_ADMIN_USERNAME)
        if admin:
            n = await backfill_entries_from_scans(DB_PATH, admin["id"])
            if n:
                logger.info("entries_backfilled_from_scans", extra={"count": n})
    except Exception as e:
        logger.error("phase2_migration_failed", extra={"error": str(e)}, exc_info=True)
    # Opportunistic session reaper — runs once on boot. With SQLite + a
    # single Railway dyno this is fine; on horizontal scale-out only one
    # worker actually deletes the rows but they're all idempotent.
    try:
        deleted = await delete_expired_sessions(DB_PATH)
        if deleted:
            logger.info("expired_sessions_reaped", extra={"count": deleted})
    except Exception as e:
        logger.warning("session_reap_failed", extra={"error": str(e)})
    # Phase 2: email-tokens reaper — same pattern. Drops expired and
    # already-used tokens so the table doesn't grow unboundedly. Both
    # confirm and reset tokens are short-lived (1h–24h), so the
    # population is naturally small, but a determined account-creation
    # attacker could otherwise burn through token rows.
    try:
        deleted = await delete_expired_email_tokens(DB_PATH)
        if deleted:
            logger.info("expired_email_tokens_reaped", extra={"count": deleted})
    except Exception as e:
        logger.warning("email_tokens_reap_failed", extra={"error": str(e)})
    # Phase 3.8: guest cleanup. Hard-deletes abandoned (0 scans) +
    # tire-kicker (<2 scans) guest rows older than the configured
    # windows. Strict role='guest' filter — never touches real users
    # or admins. CASCADE cleans up sessions/entries/etc; scans are
    # preserved as orphan rows (training-data continuity).
    try:
        counts = await delete_abandoned_guests(
            DB_PATH,
            abandoned_days=GUEST_CLEANUP_ABANDONED_DAYS,
            trial_days=GUEST_CLEANUP_TRIAL_DAYS,
        )
        if counts["deleted_zero_scan"] or counts["deleted_low_scan"]:
            logger.info("guest_cleanup_complete", extra=counts)
    except Exception as e:
        logger.warning("guest_cleanup_failed", extra={"error": str(e)})
    await open_client()
    logger.info("startup", extra={"env": ENV, "cors_origins": CORS_ORIGINS})
    yield
    await close_client()


# ── Auth helpers ──────────────────────────────────────────────────────────


def _set_session_cookie(response: Response, session_id: str) -> None:
    """Set the session cookie consistently across login + register paths.
    Max-Age in seconds = lifetime in days × 86400. HttpOnly is non-
    negotiable; without it the whole point (hide from JS) is defeated."""
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=session_id,
        max_age=SESSION_LIFETIME_DAYS * 86400,
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        httponly=True,
        secure=SESSION_COOKIE_SECURE,
        samesite=SESSION_COOKIE_SAMESITE,
    )


def _user_dict_to_public(user: dict) -> UserPublic:
    """Strip password_hash + any internals before sending to the client."""
    return UserPublic.model_validate({
        k: v for k, v in user.items() if k != "password_hash"
    })


async def _get_request_user(request: Request) -> dict | None:
    """Read the session cookie, resolve to a user. Returns None if no
    cookie / invalid / expired session. Pure read — does NOT raise. Use
    `_require_user(request)` to enforce auth on a route.

    Side effect: when the session is valid, stashes the session id on
    `request.state.session_id`. The request_lifecycle middleware reads
    that flag on the way out and refreshes the cookie's max-age, so an
    actively-using user's cookie expiry rolls forward continuously
    instead of running out at the original cookie creation + lifetime.
    """
    sid = request.cookies.get(SESSION_COOKIE_NAME)
    if not sid:
        return None
    user = await get_session_with_user(DB_PATH, sid, SESSION_LIFETIME_DAYS)
    if user:
        request.state.session_id = sid
    return user


async def _require_user(request: Request) -> dict:
    user = await _get_request_user(request)
    if not user:
        raise HTTPException(401, "Authentication required")
    return user


async def _require_admin_user(request: Request) -> dict:
    user = await _require_user(request)
    if user.get("role") != "admin":
        raise HTTPException(403, "Admin role required")
    return user


limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="HowManyCalories", version="0.1.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# Per-UTC-day counter for /api/day-quality LLM calls. Resets at midnight UTC.
# A small read-then-write race exists under concurrent requests but only lets
# a handful slip past at the moment of overflow — acceptable for a cost
# circuit-breaker. Each Railway dyno keeps its own counter; on horizontal
# scale-out the effective cap is N × DAY_QUALITY_DAILY_CAP.
_day_quality_state: dict = {"count": 0, "reset_at": None}


def _check_day_quality_cap() -> tuple[bool, int]:
    """Returns (allowed, seconds_until_reset). Increments counter on allow."""
    now = datetime.now(timezone.utc)
    today_midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    next_reset = today_midnight + timedelta(days=1)
    if _day_quality_state["reset_at"] != next_reset:
        _day_quality_state["count"] = 0
        _day_quality_state["reset_at"] = next_reset
    seconds_until = max(int((next_reset - now).total_seconds()), 1)
    if _day_quality_state["count"] >= DAY_QUALITY_DAILY_CAP:
        return False, seconds_until
    _day_quality_state["count"] += 1
    return True, seconds_until

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    # PATCH/PUT/DELETE were missing — the API has routes using all three
    # (PATCH /api/entries/{id}, PUT /api/settings, PUT /api/water,
    # DELETE /api/entries/{id}). Without them, browser preflight rejects
    # those calls cross-origin even though same-origin works fine. Note:
    # allow_credentials stays at its default (False) because dev origins
    # is wildcard ["*"] and CORS spec forbids credentials+wildcard. Same-
    # origin auth (Railway production) is unaffected by either setting.
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


@app.middleware("http")
async def request_lifecycle(request: Request, call_next):
    rid = str(uuid.uuid4())[:8]
    set_request_id(rid)
    request.state.request_id = rid
    start = time.monotonic()

    logger.info("request_start", extra={
        "method": request.method,
        "path": request.url.path,
    })

    response = await call_next(request)

    duration_ms = round((time.monotonic() - start) * 1000)
    logger.info("request_complete", extra={
        "status": response.status_code,
        "duration_ms": duration_ms,
    })
    response.headers["X-Request-ID"] = rid

    # Phase 10: cookie max-age refresh. If the route handler resolved a
    # valid session (set request.state.session_id via _get_request_user),
    # re-issue the cookie with a fresh max-age so the browser-side
    # expiry slides forward in lockstep with the DB-side expires_at
    # bump. Skipped for /api/auth/logout because that handler explicitly
    # CLEARS the cookie — re-setting it here would defeat that. The
    # cookie value is unchanged; this is purely max-age.
    sid = getattr(request.state, "session_id", None)
    if sid and request.url.path != "/api/auth/logout":
        response.set_cookie(
            key=SESSION_COOKIE_NAME,
            value=sid,
            max_age=SESSION_LIFETIME_DAYS * 86400,
            httponly=True,
            secure=SESSION_COOKIE_SECURE,
            samesite=SESSION_COOKIE_SAMESITE,
            path="/",
        )
    return response


# ── Auth endpoints ────────────────────────────────────────────────────────
# Cookie-based session auth. Public routes (no session required):
#   POST /api/auth/register, POST /api/auth/login
# Auth-required:
#   POST /api/auth/logout, GET /api/auth/me
#
# Rate limits are deliberately tight on register/login since these are the
# attack surface. Per-username rate limiting (to slow down credential-
# stuffing on a single account) is deferred to a later phase; for now we
# rely on bcrypt cost factor + per-IP throttling.


@app.post("/api/auth/register", response_model=AuthResponse)
@limiter.limit("5/minute")
async def auth_register(request: Request, response: Response, payload: RegisterRequest):
    # Phase 1: 152-ФЗ requires affirmative consent BEFORE any other
    # processing of personal data, so this check sits ahead of username
    # uniqueness and password validation. Russian message goes straight
    # to the client (auth-form's localizeError passes through Russian).
    if not payload.consent:
        raise HTTPException(
            422,
            "Согласие на обработку персональных данных обязательно",
        )

    ok, err = validate_username(payload.username)
    if not ok:
        raise HTTPException(422, err)
    ok, err = validate_password(payload.password)
    if not ok:
        raise HTTPException(422, err)

    # Pre-check uniqueness for a clean 409 message; the UNIQUE constraint
    # is the actual guarantor (race-safe), but checking first avoids a
    # caught IntegrityError exception in the common conflict case.
    existing = await get_user_by_username(DB_PATH, payload.username)
    if existing:
        raise HTTPException(409, "Username is already taken")

    try:
        user_id = await create_user(
            DB_PATH,
            payload.username,
            hash_password(payload.password),
            role="user",
        )
    except sqlite3.IntegrityError:
        # Race: someone registered the same username between the pre-check
        # and the insert. Surface the same 409 the explicit check would.
        raise HTTPException(409, "Username is already taken")

    # Audit-log the consent event before issuing the session. Awaited
    # rather than fire-and-forget — losing this row is a legal-compliance
    # gap, not a tolerable training-data drop. The consent_version stamp
    # is what we'll use to re-prompt users on policy v-bumps.
    ip_addr    = get_remote_address(request)
    user_agent = request.headers.get("user-agent", "")[:200]
    await record_consent(
        DB_PATH, user_id, CONSENT_VERSION_CURRENT, "registration",
        ip_addr=ip_addr, user_agent=user_agent,
    )

    # Auto-login on register: create a session and set the cookie so the
    # client can navigate straight into the app without a separate login
    # round-trip.
    sid = new_session_id()
    await create_session(
        DB_PATH, sid, user_id, SESSION_LIFETIME_DAYS,
        ip_addr=ip_addr, user_agent=user_agent,
    )
    await update_last_login(DB_PATH, user_id)
    _set_session_cookie(response, sid)

    user = await get_user_by_username(DB_PATH, payload.username)
    logger.info("user_registered", extra={
        "user_id":         user_id,
        "username":        payload.username,
        "consent_version": CONSENT_VERSION_CURRENT,
    })
    return AuthResponse(user=_user_dict_to_public(user))


# ── Phase 3: guest accounts ──────────────────────────────────────────────
# Auto-created hidden accounts that let first-time visitors use the
# scanner immediately, without a registration prompt. The user_id assigned
# here survives the upgrade to a real account, so the guest's first 5
# scans (entries, water log, settings) carry through to their real account
# unchanged. See PRD Phase 3 + the upgrade flow in /api/auth/upgrade-guest.


async def _create_guest_user(request: Request) -> tuple[dict, str]:
    """Create a guest user + session row. Returns (user_dict, session_id).

    Caller is responsible for setting the session cookie on the
    actual response they return — when a handler returns a pre-built
    Response (FileResponse, RedirectResponse), FastAPI uses it as-is
    and does NOT merge cookies set via `response: Response` param.
    Returning the session_id makes the caller's cookie-attachment
    explicit and bug-resistant.

    Username is `guestXXXXXXXX` (8 hex chars after the prefix);
    collision on the UNIQUE constraint is theoretically possible at
    32 bits of randomness, so we retry up to 3 times before giving up.
    Password is random and the user never sees it — upgrade rotates it.
    """
    last_err: Exception | None = None
    for _attempt in range(3):
        username = generate_guest_username(GUEST_USERNAME_PREFIX)
        try:
            user_id = await create_user(
                DB_PATH, username,
                hash_password(generate_guest_password()),
                role="guest",
            )
            break
        except sqlite3.IntegrityError as e:
            # Almost certainly a UNIQUE collision on username. Retry
            # with a fresh random suffix; 32-bit entropy means this
            # converges fast in practice.
            last_err = e
            continue
    else:
        # Three retries, all collisions — astronomically unlikely with
        # 4 billion possibilities and a small user table. Surface as 503
        # rather than 500 because it's a transient state, not a bug.
        logger.error("guest_create_collision_exhausted", extra={
            "error": str(last_err) if last_err else "no error captured",
        })
        raise HTTPException(503, "Не удалось создать гостевой аккаунт")

    sid = new_session_id()
    await create_session(
        DB_PATH, sid, user_id, SESSION_LIFETIME_DAYS,
        ip_addr=get_remote_address(request),
        user_agent=request.headers.get("user-agent", "")[:200],
    )
    await update_last_login(DB_PATH, user_id)

    user = await get_user_by_id(DB_PATH, user_id)
    logger.info("guest_created", extra={
        "user_id": user_id,
        # We log the username because guests are intentionally non-
        # private (no PII attached) — useful for ops triage.
        "username": user["username"],
    })
    return user, sid


@app.post("/api/auth/upgrade-guest", response_model=AuthResponse)
@limiter.limit("10/minute")
async def auth_upgrade_guest(
    request: Request, response: Response, payload: UpgradeGuestRequest,
):
    """Convert a guest to a real user IN PLACE. Same user_id survives,
    so all the guest's scans, entries, water log, settings, and sessions
    keep working unchanged. The session cookie itself doesn't rotate —
    the session row's user_id reference is enough to keep it valid as
    that user_id transitions from guest to user.

    Validation order (matches /api/auth/register for consistency):
      1. Caller IS a guest (403 if not — endpoint is guest-only)
      2. Consent given (422 if false — 152-ФЗ requires before any other
         processing of personal data)
      3. Username + password format
      4. Email format (basic — '@' present)
      5. Username uniqueness (allows keeping current guest_xxx name)
      6. Email uniqueness (case-insensitive)

    A single atomic UPDATE handles the role/username/password/email
    rotation. consent_log row is recorded after, then a confirmation
    email is fired-and-forget so the endpoint returns fast.
    """
    user = await _require_user(request)
    if user.get("role") != "guest":
        raise HTTPException(403, "Только гостевые аккаунты можно регистрировать")

    if not payload.consent:
        raise HTTPException(
            422, "Согласие на обработку персональных данных обязательно",
        )

    new_username = payload.username.strip()
    ok, err = validate_username(new_username)
    if not ok:
        raise HTTPException(422, err)

    ok, err = validate_password(payload.password)
    if not ok:
        raise HTTPException(422, err)

    new_email = payload.email.strip()
    if "@" not in new_email or "." not in new_email.rsplit("@", 1)[-1]:
        raise HTTPException(422, "Неверный формат email")

    # Username uniqueness — except when the user kept their current
    # guest_xxx name (PRD: "let user choose to keep").
    if new_username.lower() != user["username"].lower():
        existing = await get_user_by_username(DB_PATH, new_username)
        if existing:
            raise HTTPException(409, "Это имя уже занято")

    # Email uniqueness — anyone else holding it blocks the upgrade.
    existing_email = await get_user_by_email(DB_PATH, new_email)
    if existing_email and existing_email["id"] != user["id"]:
        raise HTTPException(409, "Этот email уже используется")

    # Atomic upgrade. The UNIQUE constraint on email + username catches
    # any race-condition collision between our pre-checks and the UPDATE
    # — caught here and surfaced as 409 with the same Russian message.
    try:
        upgraded = await upgrade_guest_to_user(
            DB_PATH, user["id"], new_username,
            hash_password(payload.password), new_email,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Это имя или email уже используется")

    if not upgraded:
        # WHERE role='guest' didn't match — rare race where another
        # request upgraded the same guest first. Surface as 409 too.
        raise HTTPException(409, "Этот аккаунт уже зарегистрирован")

    # Audit-log the consent event. Awaited (not fire-and-forget) — losing
    # this row is a 152-ФЗ compliance gap.
    ip_addr    = get_remote_address(request)
    user_agent = request.headers.get("user-agent", "")[:200]
    await record_consent(
        DB_PATH, user["id"], CONSENT_VERSION_CURRENT, "registration",
        ip_addr=ip_addr, user_agent=user_agent,
    )

    # Send confirmation email — fire-and-forget so the endpoint returns
    # without waiting on Unisender. The token is generated synchronously
    # so we don't lose it if the response goes out before the task runs.
    raw = await generate_email_token(DB_PATH, user["id"], "confirm", new_email)
    verify_url = f"{APP_BASE_URL}/api/auth/email/verify?token={raw}"
    tpl = confirm_email_template(verify_url)
    asyncio.create_task(send_email(
        to=new_email, subject=tpl["subject"],
        html=tpl["html"], text=tpl["text"],
    ))

    fresh = await get_user_by_id(DB_PATH, user["id"])
    logger.info("guest_upgraded_to_user", extra={
        "user_id":        user["id"],
        "old_username":   user["username"],
        "new_username":   new_username,
        # Only domain — full email could be PII for analytics
        "email_domain":   new_email.rsplit("@", 1)[-1][:64],
        "consent_version": CONSENT_VERSION_CURRENT,
    })
    return AuthResponse(user=_user_dict_to_public(fresh))


@app.post("/api/auth/guest", response_model=AuthResponse)
@limiter.limit("10/minute")
async def auth_guest(request: Request, response: Response):
    """Public endpoint — creates a guest account and returns the user.
    Idempotency note: every call creates a NEW guest. If the caller
    already has a valid session, this still creates a fresh guest and
    overwrites the session cookie. Frontend should call this only when
    /api/auth/me returned 401 — calling it on a logged-in user
    accidentally throws away the user's session for a fresh guest one.
    The /api/auth/guest endpoint exists alongside the auto-spawn at /
    so explicit clients (testing, programmatic) can create guests
    without hitting the HTML route.
    """
    user, sid = await _create_guest_user(request)
    # Pydantic-model returns flow through FastAPI's response builder
    # which DOES merge cookies set on the `response: Response` param.
    # That's the supported path; the / route below uses a different
    # path (FileResponse) and handles cookie attachment itself.
    _set_session_cookie(response, sid)
    return AuthResponse(user=_user_dict_to_public(user))


@app.post("/api/auth/login", response_model=AuthResponse)
@limiter.limit("5/minute")
async def auth_login(request: Request, response: Response, payload: LoginRequest):
    user = await get_user_by_username(DB_PATH, payload.username)
    # Single 401 path for "no such user" and "wrong password" — don't leak
    # which one was wrong via the error message. (Timing-channel hardening
    # via a dummy bcrypt verify on the no-user branch is deferred — at
    # 5/min/IP the wall-time signal is too narrow to be exploitable.)
    if not user:
        raise HTTPException(401, "Invalid username or password")
    if user.get("status") != "active":
        raise HTTPException(403, "This account is disabled")
    if not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(401, "Invalid username or password")

    sid = new_session_id()
    await create_session(
        DB_PATH, sid, user["id"], SESSION_LIFETIME_DAYS,
        ip_addr=get_remote_address(request),
        user_agent=request.headers.get("user-agent", "")[:200],
    )
    await update_last_login(DB_PATH, user["id"])
    _set_session_cookie(response, sid)

    # Re-fetch to include the just-updated last_login_at in the response.
    user = await get_user_by_username(DB_PATH, payload.username)
    logger.info("user_login", extra={
        "user_id": user["id"], "username": user["username"], "role": user["role"],
    })
    return AuthResponse(user=_user_dict_to_public(user))


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    """Idempotent: returns 200 even if there was no session to clear."""
    sid = request.cookies.get(SESSION_COOKIE_NAME)
    if sid:
        await delete_session(DB_PATH, sid)
    _clear_session_cookie(response)
    return {"ok": True}


@app.get("/api/auth/me", response_model=UserPublic)
async def auth_me(request: Request):
    user = await _require_user(request)
    # Patch in the real lifetime scan count (the stored users.scan_count
    # column is legacy / unmaintained — never incremented by write_scan).
    # The frontend's guest scan-counter chip reads this field, so it
    # needs to reflect actual scan history rather than 0.
    user["scan_count"] = await count_scans_for_user(DB_PATH, user["id"])
    return _user_dict_to_public(user)


# Profile fields the user can edit (display_name, weight, height, gender,
# birth_year, activity_level). Username + role + status + password are
# managed via separate endpoints / admin flows. Returns the fresh user
# row so the client can populate the form with what's now stored.
@app.put("/api/auth/profile", response_model=UserPublic)
async def update_profile(request: Request, payload: ProfileUpdate):
    user = await _require_user(request)
    patch = payload.model_dump(exclude_unset=True)
    if patch:
        await update_user_profile(DB_PATH, user["id"], patch)
    fresh = await get_user_by_id(DB_PATH, user["id"])
    if not fresh:
        raise HTTPException(404, "User not found")
    logger.info("profile_updated", extra={
        "user_id": user["id"],
        "fields":  sorted(patch.keys()),
    })
    return _user_dict_to_public(fresh)


# Avatar upload: multipart image, saved as data/avatars/{user_id}.{ext}.
# A user has at most one avatar — re-upload overwrites. Old extensions
# are cleaned up so the only file on disk for this user is the active
# one (prevents `.png` and `.jpg` co-existing if the user swaps formats).
_AVATAR_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
_AVATAR_MAX_BYTES = 4 * 1024 * 1024  # 4 MB


@app.post("/api/auth/avatar", response_model=UserPublic)
@limiter.limit("10/minute")
async def upload_avatar(request: Request, image: UploadFile = File(...)):
    user = await _require_user(request)
    if image.content_type not in _AVATAR_TYPES:
        raise HTTPException(400, "Unsupported image type. Use JPEG, PNG, or WebP.")
    image_bytes = await image.read()
    if len(image_bytes) > _AVATAR_MAX_BYTES:
        raise HTTPException(400, "Avatar too large. Max 4MB.")
    if not image_bytes:
        raise HTTPException(400, "Empty image")

    # Clean up any prior avatar files for this user (different extensions).
    for ext in _AVATAR_TYPES.values():
        prior = AVATARS_DIR / f"{user['id']}{ext}"
        if prior.exists():
            try:
                prior.unlink()
            except OSError as e:
                logger.warning("avatar_cleanup_failed", extra={
                    "path": str(prior), "error": str(e),
                })

    ext = _AVATAR_TYPES[image.content_type]
    rel_path = f"{user['id']}{ext}"
    abs_path = AVATARS_DIR / rel_path
    abs_path.write_bytes(image_bytes)
    await update_user_avatar_path(DB_PATH, user["id"], rel_path)

    fresh = await get_user_by_id(DB_PATH, user["id"])
    if not fresh:
        raise HTTPException(404, "User not found")
    logger.info("avatar_uploaded", extra={
        "user_id": user["id"], "size_bytes": len(image_bytes), "ext": ext,
    })
    return _user_dict_to_public(fresh)


@app.get("/api/auth/avatar/{user_id}")
async def get_avatar(user_id: int, request: Request):
    """Serve a user's avatar. Auth-required (any logged-in user can see
    any avatar — they're profile pictures, not secret). Returns 404 if
    the target user has no avatar set OR if the file's missing on disk."""
    await _require_user(request)
    target = await get_user_by_id(DB_PATH, user_id)
    if not target or not target.get("avatar_path"):
        raise HTTPException(404, "Avatar not set")
    path = AVATARS_DIR / target["avatar_path"]
    if not path.exists():
        raise HTTPException(404, "Avatar file missing")
    media_map = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
    ext = path.suffix.lower()
    media = media_map.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=media)


@app.post("/api/auth/change-password")
@limiter.limit("5/minute")
async def change_password(
    request: Request, response: Response, payload: ChangePasswordRequest,
):
    """User-initiated password change. Verifies the current password,
    sets the new hash, and revokes every OTHER session for this user
    (current cookie keeps working — re-issued from a fresh row so the
    cookie value stays valid). 5/min rate limit defends against an XSS
    or stolen-cookie attacker spamming password-rotation attempts."""
    user = await _require_user(request)
    full = await get_user_by_id(DB_PATH, user["id"])
    if not full:
        raise HTTPException(404, "User not found")
    if not verify_password(payload.current_password, full["password_hash"]):
        raise HTTPException(401, "Текущий пароль неверный")
    ok, err = validate_password(payload.new_password)
    if not ok:
        raise HTTPException(422, err)
    await update_user_password(
        DB_PATH, user["id"], hash_password(payload.new_password),
    )
    # Wipe every existing session, then issue a fresh one for the
    # current device so the user isn't kicked out of the page they're
    # on. Other devices (laptop, second phone) get logged out — which
    # is the right answer if the password change was triggered by a
    # suspected compromise.
    await delete_all_user_sessions(DB_PATH, user["id"])
    sid = new_session_id()
    await create_session(
        DB_PATH, sid, user["id"], SESSION_LIFETIME_DAYS,
        ip_addr=get_remote_address(request),
        user_agent=request.headers.get("user-agent", "")[:200],
    )
    _set_session_cookie(response, sid)
    logger.info("password_changed", extra={
        "user_id": user["id"], "username": user.get("username"),
    })
    return {"ok": True}


# ── Phase 2: email-driven flows ──────────────────────────────────────────
# Four endpoints that wire the consent_log / email_tokens / email service
# layers together:
#   POST /api/auth/email/request-confirmation    (auth req'd)
#   GET  /api/auth/email/verify?token=...        (public, browser-clicked)
#   POST /api/auth/password-reset/request        (public, anti-enumeration)
#   POST /api/auth/password-reset/confirm        (public)
#
# All four use the same canonical send path: build URL → render
# template → fire send_email(). In dev mode (EMAIL_TRANSPORT=log) the
# emails surface in the structured log instead of being delivered, so
# the round-trip is testable end-to-end without burning Unisender quota.


@app.post("/api/auth/email/request-confirmation")
@limiter.limit("3/hour")
async def request_email_confirmation(request: Request):
    """Send a fresh confirmation email to the current user. Requires
    that the user has set an email and that it isn't already verified
    — both are 400s rather than silent no-ops because they signal
    a UI bug if hit (the client should never offer this button to a
    user who has nothing to confirm)."""
    user = await _require_user(request)

    email = (user.get("email") or "").strip()
    if not email:
        raise HTTPException(400, "У этого аккаунта не задан email")
    if user.get("email_verified"):
        raise HTTPException(400, "Email уже подтверждён")

    raw = await generate_email_token(DB_PATH, user["id"], "confirm", email)
    verify_url = f"{APP_BASE_URL}/api/auth/email/verify?token={raw}"
    tpl = confirm_email_template(verify_url)

    sent = await send_email(
        to=email, subject=tpl["subject"], html=tpl["html"], text=tpl["text"],
    )
    if not sent:
        # send_email logs the underlying failure; don't surface details
        # to the client (could leak Unisender errors). 503 lets the
        # client decide whether to retry.
        raise HTTPException(503, "Не удалось отправить письмо. Попробуйте позже.")

    logger.info("email_confirm_requested", extra={"user_id": user["id"]})
    return {"ok": True}


@app.get("/api/auth/email/verify")
async def verify_email(request: Request, token: str = ""):
    """Public endpoint hit by clicking the email link. Always returns
    a 302 redirect — never JSON — so the user always lands somewhere
    visible regardless of token validity. Query params on the redirect
    target tell the client whether to show a success or failure toast.

    Defensive checks beyond plain token validity:
      - User row still exists (rare race: account deleted post-issue)
      - User's CURRENT email matches the email captured at issue time.
        If user rotated email between request and click, the older
        token must NOT verify the newer email.
    """
    fail_url = f"{APP_BASE_URL}/?verified=0"
    ok_url   = f"{APP_BASE_URL}/?verified=1"

    if not token:
        return RedirectResponse(fail_url, status_code=302)

    row = await consume_email_token(DB_PATH, token, "confirm")
    if not row:
        return RedirectResponse(fail_url, status_code=302)

    user = await get_user_by_id(DB_PATH, row["user_id"])
    if not user:
        # Token was valid but user is gone — race with self-delete.
        logger.warning("email_verify_user_missing", extra={
            "user_id": row["user_id"],
        })
        return RedirectResponse(fail_url, status_code=302)

    current = (user.get("email") or "").strip().lower()
    captured = (row.get("email") or "").strip().lower()
    if current != captured:
        logger.warning("email_verify_email_changed_since_issue", extra={
            "user_id": user["id"],
        })
        return RedirectResponse(fail_url, status_code=302)

    await mark_email_verified(DB_PATH, user["id"])
    logger.info("email_verified", extra={"user_id": user["id"]})

    # Welcome email — fire-and-forget so the redirect isn't blocked on
    # the second send. asyncio.create_task copies the current context
    # so logging request_id stays attached.
    welcome = welcome_email_template(f"{APP_BASE_URL}/")
    asyncio.create_task(send_email(
        to=user["email"], subject=welcome["subject"],
        html=welcome["html"], text=welcome["text"],
    ))

    return RedirectResponse(ok_url, status_code=302)


@app.post("/api/auth/password-reset/request")
@limiter.limit("3/hour")
async def request_password_reset(
    request: Request, payload: PasswordResetRequest,
):
    """Anti-enumeration: ALWAYS returns 200. The response body shape
    never changes whether the email exists, isn't registered, or is
    malformed — clients can't poll this endpoint to harvest valid
    addresses. Per-IP rate limit is applied via slowapi; per-email
    throttling at the DB layer is deferred to the 0.5 hardening pass."""
    email = payload.email.strip()
    if "@" not in email:
        # Don't reject — silent no-op. The endpoint should LOOK
        # identical to the success path even on garbage input.
        return {"ok": True}

    user = await get_user_by_email(DB_PATH, email)
    if user:
        raw = await generate_email_token(DB_PATH, user["id"], "reset", email)
        # /reset doesn't exist yet — that's a Phase 3 page. The link
        # is still emailable; testing in Phase 2 happens via curl
        # against /password-reset/confirm directly.
        reset_url = f"{APP_BASE_URL}/reset?token={raw}"
        tpl = reset_email_template(reset_url)

        sent = await send_email(
            to=email, subject=tpl["subject"],
            html=tpl["html"], text=tpl["text"],
        )
        if not sent:
            logger.warning("password_reset_email_send_failed", extra={
                "user_id": user["id"],
            })
        else:
            logger.info("password_reset_requested", extra={"user_id": user["id"]})
    else:
        # Don't log the full email — could be probe data. Domain only
        # for spam-pattern analysis.
        domain = email.rsplit("@", 1)[-1] if "@" in email else "?"
        logger.info("password_reset_request_unknown_email", extra={
            "email_domain": domain[:64],
        })

    return {"ok": True}


@app.post("/api/auth/password-reset/confirm")
@limiter.limit("5/hour")
async def confirm_password_reset(
    request: Request, payload: PasswordResetConfirm,
):
    """Validate token, validate new password, atomically swap hash +
    invalidate every session for that user. The user must log in fresh
    after this — we don't auto-issue a session cookie. That's safer
    against a stolen-token attacker who'd otherwise gain a live session
    by completing the reset themselves."""
    ok, err = validate_password(payload.new_password)
    if not ok:
        raise HTTPException(422, err)

    row = await consume_email_token(DB_PATH, payload.token, "reset")
    if not row:
        raise HTTPException(410, "Ссылка устарела или недействительна")

    await update_user_password(
        DB_PATH, row["user_id"], hash_password(payload.new_password),
    )
    revoked = await delete_all_user_sessions(DB_PATH, row["user_id"])

    logger.info("password_reset_confirmed", extra={
        "user_id":          row["user_id"],
        "sessions_revoked": revoked,
    })
    return {"ok": True}


@app.post("/api/auth/delete-account")
async def delete_account_self(
    request: Request, response: Response, payload: DeleteAccountRequest,
):
    """User-initiated self-delete. Requires current password. Seed
    admin accounts are blocked from this path — they're the dev's
    escape hatches and should only be deleted out of band. Cascades
    to sessions, entries, water_log, user_settings; preserves scans
    rows with user_id=NULL (training-data continuity)."""
    user = await _require_user(request)
    if user.get("username") in (SEED_ADMIN_USERNAME, SEED_SUPERADMIN_USERNAME):
        raise HTTPException(
            400, "Этот аккаунт нельзя удалить из приложения.",
        )
    full = await get_user_by_id(DB_PATH, user["id"])
    if not full:
        raise HTTPException(404, "User not found")
    if not verify_password(payload.password, full["password_hash"]):
        raise HTTPException(401, "Неверный пароль")
    # Avatar file cleanup before the row goes away.
    if full.get("avatar_path"):
        path = AVATARS_DIR / full["avatar_path"]
        if path.exists():
            try:
                path.unlink()
            except OSError as e:
                logger.warning("self_delete_avatar_cleanup_failed", extra={
                    "user_id": user["id"], "error": str(e),
                })
    ok = await delete_user(DB_PATH, user["id"])
    if not ok:
        raise HTTPException(500, "Delete failed")
    _clear_session_cookie(response)
    logger.info("user_self_deleted", extra={
        "user_id":  user["id"],
        "username": user.get("username"),
        # Optional user feedback from the designed delete-modal. Logged
        # only — no DB row, no analytics export beyond the structured
        # logs. Truncated to 500 chars by the schema.
        "reason":   (payload.reason or "").strip() or None,
    })
    return {"ok": True}


@app.post("/api/auth/avatar/delete", response_model=UserPublic)
async def delete_avatar(request: Request):
    """Clear the user's avatar (file + DB pointer). Returns the fresh
    user row with avatar_path=None so the client UI can re-render."""
    user = await _require_user(request)
    if user.get("avatar_path"):
        path = AVATARS_DIR / user["avatar_path"]
        if path.exists():
            try:
                path.unlink()
            except OSError as e:
                logger.warning("avatar_delete_failed", extra={
                    "path": str(path), "error": str(e),
                })
    await update_user_avatar_path(DB_PATH, user["id"], None)
    fresh = await get_user_by_id(DB_PATH, user["id"])
    return _user_dict_to_public(fresh)


# ── Entries (per-user personal history) ───────────────────────────────────


def _entry_row_to_public(row: dict) -> dict:
    """Server row → client `EntryPublic` shape. Mirrors the localStorage
    `hmc_v1` entry shape (frontend reads them interchangeably). The
    `imageDataUrl` field is named for backward compat — for server entries
    it's a regular URL that <img src> handles identically to a base64
    data URL, so renderers don't need updating."""
    try:
        result = json.loads(row["result_json"]) if row.get("result_json") else {}
    except (json.JSONDecodeError, TypeError):
        result = {}
    # Convert the ISO created_at to epoch ms (matches the frontend's
    # `entry.ts` shape from the localStorage era).
    try:
        ts_ms = int(
            datetime.fromisoformat(
                row["created_at"].replace("Z", "+00:00")
            ).timestamp() * 1000
        )
    except (ValueError, AttributeError):
        ts_ms = 0
    return {
        "id":            row["id"],
        # Frontend reads `entry.timestamp` (number, epoch ms). The previous
        # `ts` key was a mismatch — every server-pulled entry had
        # `timestamp` undefined, which produced "Invalid Date" labels and
        # broke today-filtering for the day-hero stats.
        "timestamp":     ts_ms,
        "imageDataUrl":  f"/api/scans/{row['scan_id']}/image" if row.get("scan_id") else None,
        "result":        result,
        "totalCalories": row.get("total_calories") or 0,
        "itemCount":     row.get("item_count") or 0,
        "itemNames":     row.get("item_names") or "",
        "consumed":      bool(row.get("consumed")),
    }


@app.get("/api/entries", response_model=list[EntryPublic])
async def list_entries(request: Request, limit: int = 200, offset: int = 0):
    user = await _require_user(request)
    rows = await list_entries_for_user(
        DB_PATH, user["id"], limit=min(max(limit, 1), 500), offset=max(offset, 0),
    )
    return [_entry_row_to_public(r) for r in rows]


@app.patch("/api/entries/{entry_id}")
async def patch_entry(entry_id: int, request: Request, payload: EntryUpdate):
    user = await _require_user(request)
    patch = payload.model_dump(exclude_none=True)
    # Frontend sends `result` as a JSON-serializable dict; we re-stringify
    # so the DB column stays canonical (the renderer parses on read).
    if "result" in patch:
        patch["result_json"] = json.dumps(patch.pop("result"), ensure_ascii=False)
    if "consumed" in patch:
        patch["consumed"] = 1 if patch["consumed"] else 0
    ok, diffs_logged = await update_entry_with_edit_tracking(
        DB_PATH, entry_id, user["id"], patch,
    )
    if not ok:
        raise HTTPException(404, "Entry not found or no changes")
    if diffs_logged:
        # Structured signal so admin log-tail can spot user-correction
        # patterns ("user X edited 3 items on scan Y"). The diffs
        # themselves live in the entry_edit_log table for full detail.
        logger.info("entry_edited", extra={
            "entry_id":     entry_id,
            "user_id":      user["id"],
            "diffs_logged": diffs_logged,
        })
    return {"ok": True, "diffs_logged": diffs_logged}


@app.delete("/api/entries/{entry_id}")
async def delete_entry_endpoint(entry_id: int, request: Request):
    user = await _require_user(request)
    ok = await delete_entry(DB_PATH, entry_id, user["id"])
    if not ok:
        raise HTTPException(404, "Entry not found")
    return {"ok": True}


# ── Phase 3B: per-user settings + water log ───────────────────────────────
# Both stored as a single JSON blob per user. Whole-blob PUT replaces;
# GET returns whatever's stored (or {} / [] for "never set"). The client
# is the source of truth for the schema (DEFAULT_SETTINGS in storage.js
# and the water_log entry shape); the server just persists whatever it
# receives. Body size is capped at 64KB per write to prevent abuse.
_MAX_BLOB_BYTES = 64 * 1024


def _check_blob_size(payload: object) -> None:
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > _MAX_BLOB_BYTES:
        raise HTTPException(413, "Payload too large")


@app.get("/api/settings")
async def get_settings_endpoint(request: Request):
    user = await _require_user(request)
    settings = await get_user_settings(DB_PATH, user["id"])
    return settings or {}


@app.put("/api/settings")
async def put_settings_endpoint(request: Request, payload: dict):
    user = await _require_user(request)
    if not isinstance(payload, dict):
        raise HTTPException(422, "Settings must be an object")
    _check_blob_size(payload)
    await put_user_settings(DB_PATH, user["id"], payload)
    return {"ok": True}


@app.get("/api/water")
async def get_water_endpoint(request: Request):
    user = await _require_user(request)
    return await get_water_log(DB_PATH, user["id"])


@app.put("/api/water")
async def put_water_endpoint(request: Request, payload: list):
    user = await _require_user(request)
    if not isinstance(payload, list):
        raise HTTPException(422, "Water log must be an array")
    if len(payload) > 5000:
        raise HTTPException(422, "Water log too long (max 5000 entries)")
    _check_blob_size(payload)
    await put_water_log(DB_PATH, user["id"], payload)
    return {"ok": True}


@app.get("/api/scans/{scan_id}/image")
async def get_scan_image(scan_id: str, request: Request):
    """Auth-required image serve, scoped to the scan's owner. Admins
    bypass the ownership check (so the dashboard can preview any user's
    scan). Returns 404 for both "scan doesn't exist" and "scan exists
    but belongs to a different non-admin user" — the latter shouldn't
    leak existence to a probing client."""
    user = await _require_user(request)
    is_admin = user.get("role") == "admin"
    scan = await get_scan_for_user(
        DB_PATH, scan_id, user["id"], admin_bypass=is_admin,
    )
    if not scan:
        raise HTTPException(404, "Scan not found")
    img_hash = scan.get("image_sha256")
    if not img_hash:
        raise HTTPException(404, "Image not found")
    for ext in (".jpg", ".png", ".webp", ".gif"):
        path = IMAGES_DIR / f"{img_hash}{ext}"
        if path.exists():
            media = {
                ".jpg": "image/jpeg", ".png": "image/png",
                ".webp": "image/webp", ".gif": "image/gif",
            }[ext]
            return FileResponse(path, media_type=media)
    # Scan record exists, image_sha256 is set, but no file matches on
    # disk — the file was wiped out from under us. On Railway this is the
    # signature of the ephemeral-filesystem reset between deploys; locally
    # it usually means manual cleanup. Logged loudly so the rate of these
    # tells us the scope of the persistence problem.
    logger.warning("scan_image_file_missing", extra={
        "scan_id":      scan_id,
        "image_sha256": img_hash,
        "user_id":      user.get("id"),
        "media_type":   scan.get("media_type"),
    })
    raise HTTPException(404, "Image not found")


async def _check_guest_scan_quota(user: dict) -> None:
    """Phase 3: lifetime cap on guest scans. No-op for non-guests
    (role='user' or 'admin'). When a guest has used GUEST_FREE_SCANS or
    more lifetime scans, raises HTTPException(403) with a structured
    detail dict the frontend can match on:

        {"code": "REGISTRATION_REQUIRED",
         "message": "Зарегистрируйтесь чтобы продолжить...",
         "free_scans": 5, "used": 5}

    Lifetime count comes from the scans table, NOT entries — even if a
    guest deletes their entries, the underlying scan rows persist and
    count against the quota. That's by design: the quota is "sessions
    of AI cost we've extended to this guest", not "items currently in
    their history".
    """
    if user.get("role") != "guest":
        return
    lifetime_count = await count_scans_for_user(DB_PATH, user["id"])
    if lifetime_count >= GUEST_FREE_SCANS:
        logger.info("guest_scan_quota_hit", extra={
            "user_id":        user["id"],
            "username":       user.get("username"),
            "lifetime_count": lifetime_count,
            "cap":            GUEST_FREE_SCANS,
        })
        raise HTTPException(
            status_code=403,
            detail={
                "code":       "REGISTRATION_REQUIRED",
                "message":    (
                    f"Зарегистрируйтесь чтобы продолжить — "
                    f"ваши {GUEST_FREE_SCANS} бесплатных сканов сохранятся."
                ),
                "free_scans": GUEST_FREE_SCANS,
                "used":       lifetime_count,
            },
        )


@app.post("/api/analyze", response_model=AnalysisResult)
@limiter.limit("10/minute")
async def analyze(
    request: Request,
    image: UploadFile = File(...),
    portion_hint: str | None = Form(default=None),
):
    # Session-required. Without this, an attacker who's never logged in
    # can still hit /api/analyze directly via curl and burn the API key.
    user = await _require_user(request)

    # Phase 3: guest lifetime scan cap — fires BEFORE any expensive work
    # so a 6th-scan attempt by a guest is rejected with no Anthropic
    # round-trip and no DB write.
    await _check_guest_scan_quota(user)

    # User-supplied free text flows into the Sonnet prompt — strip control
    # chars, prompt-injection markers ("###", "[INST]", "<|...|>"), collapse
    # whitespace, and truncate. Empty result → None so the prompt builder
    # cleanly omits the "Portion context" suffix.
    portion_hint = sanitize_for_prompt(portion_hint, max_len=200) or None

    # Phase 8: per-user daily scan cap. Counts the user's scans since
    # UTC midnight; rejects with 429 once the cap is reached. Admins are
    # never capped — they pay for the API key, the cap is a per-account
    # cost guard for the open-registration flow. Setting the env var to
    # 0 disables the cap entirely.
    if MAX_SCANS_PER_USER_PER_DAY > 0 and user.get("role") != "admin":
        today_count = await count_user_scans_today(DB_PATH, user["id"])
        if today_count >= MAX_SCANS_PER_USER_PER_DAY:
            logger.warning("user_daily_scan_cap_hit", extra={
                "user_id":  user["id"],
                "username": user.get("username"),
                "cap":      MAX_SCANS_PER_USER_PER_DAY,
                "today":    today_count,
            })
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Дневной лимит сканов ({MAX_SCANS_PER_USER_PER_DAY}) "
                    f"исчерпан. Попробуйте завтра."
                ),
            )

    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, "API key not configured — UI-only mode")

    if image.content_type not in ALLOWED_TYPES:
        logger.warning("invalid_content_type", extra={"content_type": image.content_type})
        raise HTTPException(400, f"Unsupported image type: {image.content_type}. Use JPEG, PNG, or WebP.")

    image_bytes = await image.read()
    size_bytes = len(image_bytes)

    if size_bytes > MAX_IMAGE_SIZE_MB * 1024 * 1024:
        logger.warning("image_too_large", extra={"size_bytes": size_bytes, "limit_mb": MAX_IMAGE_SIZE_MB})
        raise HTTPException(400, f"Image too large. Maximum size is {MAX_IMAGE_SIZE_MB}MB.")

    logger.info("analyze_start", extra={
        "content_type": image.content_type,
        "size_bytes": size_bytes,
        "has_portion_hint": portion_hint is not None,
    })

    # Save image to disk for dashboard review
    import hashlib
    img_hash = hashlib.sha256(image_bytes).hexdigest()
    ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}.get(image.content_type, ".bin")
    img_path = IMAGES_DIR / f"{img_hash}{ext}"
    if not img_path.exists():
        img_path.write_bytes(image_bytes)

    try:
        result = await analyze_image(
            image_bytes, image.content_type, portion_hint, user_id=user["id"],
        )
    except ValueError as e:
        logger.error("parse_error", extra={"error": str(e)})
        raise HTTPException(500, f"Failed to parse analysis: {e}")
    except Exception as e:
        logger.error("analyze_error", extra={"error": str(e)}, exc_info=True)
        raise HTTPException(500, "Analysis failed. Please try again.")

    if not result.get("is_food"):
        logger.info("no_food_detected", extra={"notes": result.get("notes", "")})
        raise HTTPException(422, detail={
            "error": "no_food_detected",
            "message": "No food was detected in this image. Please try a different photo.",
            "notes": result.get("notes", ""),
        })

    # Auto-create the user-facing entry. Eager-save with consumed=False:
    # the frontend's swipe-right gesture promotes it to consumed via the
    # /api/entries/{id} PATCH path. Failures are logged but don't break
    # the response — the analysis result is still useful to the client
    # (it can fall back to localStorage-only persistence in that case).
    scan_id = result.get("scan_id")
    items = result.get("items") or []
    item_names = ", ".join(
        str(it.get("name", "")) for it in items[:3] if it.get("name")
    )
    try:
        entry_id = await create_entry(
            DB_PATH,
            user_id=user["id"],
            result_json=json.dumps(result, ensure_ascii=False),
            scan_id=scan_id,
            consumed=False,
            total_calories=(result.get("total") or {}).get("calories"),
            item_count=len(items),
            item_names=item_names,
        )
        result["entry_id"] = entry_id
    except Exception as e:
        logger.warning("entry_create_failed", extra={
            "scan_id": scan_id, "user_id": user["id"], "error": str(e),
        })

    return result


# ──────────────────────────────────────────────────────────────────────
# /api/analyze/stream — SSE-streaming variant of /api/analyze.
#
# Same auth + validation gate as /api/analyze, but instead of holding
# the response open for 30-60s and returning a single JSON blob, this
# endpoint streams progress events as Server-Sent Events. The pipeline
# is identical (server.services.claude_vision.analyze_image); we just
# bind a per-request emitter via ContextVar so the same pipeline code
# pushes structured events out the wire as it runs.
#
# Wire format (SSE per W3C spec):
#   event: <name>\ndata: <json>\n\n
#
# Event vocabulary — frontend may receive ANY of these:
#   started        eta_seconds, expected_stages
#   progress       stage (1|2|3), progress (0..1 — global)
#   log            text  (Russian, soft first-person — see feedback memory)
#   item_found     id, name, grams, bbox{x,y}    (Stage 1)
#   stage_done     stage (1|2|3)
#   item_enriched  id, source, kcal               (Stage 2)
#   item_revised   id, field, from, to            (Stage 3 diff vs Stage 2)
#   error          message, recoverable
#   done           full result payload mirroring legacy /api/analyze
# ──────────────────────────────────────────────────────────────────────
def _sse(event: str, data: dict) -> str:
    """SSE wire format: `event:` line + `data:` (JSON) + blank line."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/analyze/stream")
@limiter.limit("10/minute")
async def analyze_stream(
    request: Request,
    image: UploadFile = File(...),
    portion_hint: str | None = Form(default=None),
):
    user = await _require_user(request)

    # Same Phase 3 guest-quota gate as /api/analyze, fires before
    # everything else so a 6th-scan attempt costs nothing.
    await _check_guest_scan_quota(user)

    portion_hint = sanitize_for_prompt(portion_hint, max_len=200) or None

    # Same daily-cap guard as /api/analyze. Admins exempt.
    if MAX_SCANS_PER_USER_PER_DAY > 0 and user.get("role") != "admin":
        today_count = await count_user_scans_today(DB_PATH, user["id"])
        if today_count >= MAX_SCANS_PER_USER_PER_DAY:
            raise HTTPException(
                status_code=429,
                detail=f"Дневной лимит сканов ({MAX_SCANS_PER_USER_PER_DAY}) исчерпан. Попробуйте завтра.",
            )

    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, "API key not configured — UI-only mode")

    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported image type: {image.content_type}")

    image_bytes = await image.read()
    if len(image_bytes) > MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"Image too large. Maximum size is {MAX_IMAGE_SIZE_MB}MB.")

    img_hash = hashlib.sha256(image_bytes).hexdigest()
    ext = {
        "image/jpeg": ".jpg", "image/png": ".png",
        "image/webp": ".webp", "image/gif": ".gif",
    }.get(image.content_type, ".bin")
    img_path = IMAGES_DIR / f"{img_hash}{ext}"
    if not img_path.exists():
        img_path.write_bytes(image_bytes)

    content_type = image.content_type  # capture before generator (UploadFile may go out of scope)
    user_id = user["id"]

    logger.info("analyze_stream_start", extra={
        "user_id": user_id, "size_bytes": len(image_bytes),
        "img_sha256": img_hash, "has_portion_hint": portion_hint is not None,
    })

    async def event_generator():
        # Per-request asyncio.Queue acts as the wire between the pipeline
        # task (producer) and this generator (consumer). The pipeline
        # calls _events.emit(...), which forwards through the bound
        # emitter onto this queue; the generator drains the queue and
        # writes SSE frames to the HTTP response.
        queue: asyncio.Queue = asyncio.Queue()

        async def emit_to_queue(event: str, data: dict) -> None:
            try:
                await queue.put((event, data))
            except Exception:
                # Closed queue or task cancelled — pipeline-side emit
                # has its own try/except so this just stops the flow.
                pass

        # Bind the emitter for the CURRENT context, then create the
        # pipeline task — asyncio.create_task copies the current context,
        # so emit() calls deep inside analyze_image / enrich_item see
        # the bound emitter.
        bind_token = bind_emitter(emit_to_queue)

        async def run_pipeline() -> None:
            try:
                result = await analyze_image(
                    image_bytes, content_type, portion_hint, user_id=user_id,
                )

                if not result.get("is_food"):
                    # Mirror the legacy 422 detail shape inside an error
                    # event so the frontend can show the same "no food"
                    # treatment it already has.
                    await queue.put(("error", {
                        "message": "В кадре не видно еды. Попробуйте другое фото.",
                        "recoverable": True,
                        "no_food": True,
                        "notes": result.get("notes", ""),
                    }))
                    return

                # Eager-save the entry like /api/analyze does, so the
                # report card has an entry_id to address. Failures here
                # don't block the done event — the client falls back to
                # localStorage-only persistence in that path.
                items = result.get("items") or []
                item_names = ", ".join(
                    str(it.get("name", "")) for it in items[:3] if it.get("name")
                )
                try:
                    entry_id = await create_entry(
                        DB_PATH,
                        user_id=user_id,
                        result_json=json.dumps(result, ensure_ascii=False),
                        scan_id=result.get("scan_id"),
                        consumed=False,
                        total_calories=(result.get("total") or {}).get("calories"),
                        item_count=len(items),
                        item_names=item_names,
                    )
                    result["entry_id"] = entry_id
                except Exception as e:
                    logger.warning("entry_create_failed_stream", extra={
                        "scan_id":  result.get("scan_id"),
                        "user_id":  user_id,
                        "error":    str(e),
                    })

                await queue.put(("done", result))

            except asyncio.CancelledError:
                # Client hung up; let the cancellation propagate so the
                # task ends cleanly. The Anthropic SDK's in-flight call
                # may still complete server-side — that's a known gap;
                # it gets billed but the response is discarded.
                raise
            except ValueError as e:
                logger.error("stream_parse_error", extra={"error": str(e)})
                await queue.put(("error", {
                    "message": "Не удалось распознать ответ модели",
                    "recoverable": True,
                }))
            except Exception:
                logger.exception("stream_pipeline_error")
                await queue.put(("error", {
                    "message": "Ошибка анализа. Попробуйте ещё раз.",
                    "recoverable": True,
                }))
            finally:
                # Sentinel so the generator's read loop exits cleanly
                # whether we ended via done, error, or unexpected.
                await queue.put((None, None))

        pipeline_task = asyncio.create_task(run_pipeline())

        try:
            while True:
                event, data = await queue.get()
                if event is None:
                    break
                yield _sse(event, data)
        except asyncio.CancelledError:
            # Browser closed the stream (e.g. iris-cancel committed).
            # Cancel the pipeline so we don't burn the API call quota
            # on a discarded response.
            logger.info("analyze_stream_disconnect", extra={
                "user_id": user_id, "img_sha256": img_hash,
            })
            pipeline_task.cancel()
            raise
        finally:
            unbind_emitter(bind_token)
            if not pipeline_task.done():
                pipeline_task.cancel()
            # Best-effort drain — give the task ~2s to wind down so any
            # in-flight Anthropic SDK call gets a chance to release its
            # connection. Past 2s we move on; the task gets GC'd.
            try:
                await asyncio.wait_for(asyncio.shield(pipeline_task), timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Disables proxy buffering on Cloudflare/Nginx variants used
            # by Railway. Without this, events are queued until the
            # response closes — defeating the whole point of streaming.
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/lookup", response_model=Item)
@limiter.limit("30/minute")
async def lookup_ingredient(request: Request, payload: LookupRequest):
    """Manual ingredient lookup — used when the user adds an item after
    analysis. Reuses the same russian_db → USDA → OFF → AI fallback chain
    as Stage 2 of /api/analyze, so a manually-added "хлеб 80г" looks
    identical to one the photo identified."""
    user = await _require_user(request)
    item = {
        "name":             payload.name,
        "estimated_grams":  payload.grams,
        "usda_search_term": payload.usda_search_term or payload.name,
        "is_branded":       False,
        "ai_calories":      0,
        "ai_protein_g":     0,
        "ai_fat_g":         0,
        "ai_carbs_g":       0,
        "ai_sugar_g":       0,
        "ai_fiber_g":       0,
        "confidence":       "medium",
    }
    enriched = await enrich_item(item)

    # If russian_db, USDA, and OFF all missed AND there are no AI estimates
    # to fall back on, the enriched item ends up as zero-cal "ai_estimate".
    # That's not a useful answer for the user — surface a 404 so they can
    # try a more recognizable name.
    if enriched.get("data_source") == "ai_estimate" and enriched.get("calories", 0) == 0:
        logger.info("lookup_not_found", extra={
            "item_name": payload.name, "grams": payload.grams,
        })
        raise HTTPException(
            404,
            f"Не удалось найти '{payload.name}'. Попробуйте более общее название.",
        )

    # Strip internal fields the same way Stage 2 does before returning to
    # the client. `per_100g` and `usda_search_term` are kept on purpose so
    # the new card behaves identically to existing items (rescaling, badges).
    for key in (
        "ai_calories", "ai_protein_g", "ai_fat_g", "ai_carbs_g",
        "ai_sugar_g", "ai_fiber_g", "is_branded",
    ):
        enriched.pop(key, None)

    logger.info("lookup_complete", extra={
        "item_name": payload.name,
        "grams": payload.grams,
        "source": enriched.get("data_source"),
        "calories": enriched.get("calories"),
    })
    return enriched


@app.post("/api/validate-edits", response_model=ValidationVerdict)
@limiter.limit("5/minute")
async def validate_edits(
    request: Request,
    image: UploadFile = File(...),
    items: str = Form(...),
):
    """Sanity-check the user's edited ingredient list against the original
    photo. Reuses the multipart pattern of /api/analyze; the image is
    re-uploaded by the client (history thumbnails are too small for
    vision, and Railway's filesystem is ephemeral so we don't rely on a
    server-side photo cache).

    Failures collapse to a 'looks_right' verdict in the validator —
    validation is advisory and must never block the user.
    """
    user = await _require_user(request)

    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, "API key not configured — validation unavailable")

    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported image type: {image.content_type}")

    try:
        items_raw = json.loads(items)
        if not isinstance(items_raw, list):
            raise ValueError("items must be a list")
        if len(items_raw) == 0:
            raise ValueError("items must not be empty")
        if len(items_raw) > 30:
            raise ValueError("items has too many entries (max 30)")
        validated = [ValidationRequestItem(**it).model_dump(exclude_none=True) for it in items_raw]
    except (json.JSONDecodeError, ValueError, ValidationError, TypeError) as e:
        raise HTTPException(422, f"Invalid items: {e}")

    image_bytes = await image.read()
    if len(image_bytes) > MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"Image too large. Max {MAX_IMAGE_SIZE_MB}MB.")

    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    logger.info("validation_start", extra={
        "item_count":    len(validated),
        "image_size_kb": round(len(image_bytes) / 1024),
    })

    verdict = await validate_with_sonnet(image_b64, image.content_type, validated)
    return verdict


@app.post("/api/day-quality", response_model=DayQualityVerdict)
@limiter.limit("10/minute")
async def day_quality(request: Request, payload: DayQualityRequest):
    """Score a day's consumed items + water as green/yellow/orange/red and
    return a brief commentary. Used by the calendar widget on the scanner
    screen to colour-tint each day cell. Stateless on the server — the
    client caches verdicts per date in localStorage and invalidates when
    the day's content changes.

    Two layers of protection against runaway LLM spend:
      1. Per-IP rate limit (10/minute) handles individual-actor bursts.
      2. Per-process daily cap (DAY_QUALITY_DAILY_CAP) is the global
         circuit breaker.
    Empty-day or oversized requests are rejected before the cap check so
    they don't burn budget on no-op calls."""
    user = await _require_user(request)

    if not ANTHROPIC_API_KEY:
        raise HTTPException(503, "API key not configured")

    if not payload.items:
        return DayQualityVerdict(
            color="yellow",
            summary="Нет записей за этот день.",
            tip="",
        )

    if len(payload.items) > 30:
        raise HTTPException(422, "Too many items for a single day (max 30)")

    allowed, seconds_until_reset = _check_day_quality_cap()
    if not allowed:
        logger.warning("day_quality_daily_cap_hit", extra={
            "cap":              DAY_QUALITY_DAILY_CAP,
            "reset_in_seconds": seconds_until_reset,
        })
        raise HTTPException(
            status_code=429,
            detail="Daily quality cap reached. Try again tomorrow.",
            headers={"Retry-After": str(seconds_until_reset)},
        )

    items_dicts = [it.model_dump() for it in payload.items]
    verdict = await judge_day_quality(
        payload.date,
        items_dicts,
        payload.water_ml,
        payload.target_calories,
    )
    return verdict


@app.get("/health")
async def health():
    # `scan_write_failures` is a process-local counter incremented by
    # database.write_scan on any caught exception. Any non-zero value
    # means training data has been silently dropped — surface it here so
    # an uptime probe / dashboard can alert without parsing logs.
    return JSONResponse({
        "status":               "ok",
        "model":                CLAUDE_MODEL,
        "judge_model":          CLAUDE_JUDGE_MODEL,
        "api_key_configured":   bool(ANTHROPIC_API_KEY),
        "scan_write_failures":  get_scan_write_failures(),
    })


@app.get("/api/admin/scans", response_model=ScansListResponse)
async def list_scans(request: Request, limit: int = 50, offset: int = 0):
    await _require_admin_user(request)
    rows = await get_recent_scans(DB_PATH, limit=min(limit, 200), offset=offset)
    total = await get_scan_count(DB_PATH)
    return {"total": total, "count": len(rows), "offset": offset, "scans": rows}


@app.get("/api/admin/scans/{scan_id}", response_model=ScanSummary)
async def scan_detail(scan_id: str, request: Request):
    await _require_admin_user(request)
    row = await get_scan_detail(DB_PATH, scan_id)
    if not row:
        raise HTTPException(404, "Scan not found")
    return row


@app.get("/api/admin/stats", response_model=StatsResponse)
async def admin_stats(request: Request):
    await _require_admin_user(request)
    return await get_stats(DB_PATH)


@app.get("/api/admin/timeline", response_model=list[TimelineBucket])
async def admin_timeline(request: Request, period: str = "day"):
    await _require_admin_user(request)
    if period not in ("day", "week", "month"):
        raise HTTPException(400, "period must be day, week, or month")
    return await get_timeline(DB_PATH, period)


@app.get("/api/admin/images/{image_hash}")
async def serve_image(image_hash: str, request: Request):
    await _require_admin_user(request)
    for ext in (".jpg", ".png", ".webp", ".gif"):
        path = IMAGES_DIR / f"{image_hash}{ext}"
        if path.exists():
            media = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}[ext]
            return FileResponse(path, media_type=media)
    raise HTTPException(404, "Image not found")


# ── Admin: edit-log endpoints ─────────────────────────────────────────────
# Surface the entry_edit_log table so the admin dashboard can answer
# "what did the user actually change about the AI's analysis?" for any
# given scan or entry. Both endpoints return chronological order
# (oldest first) so a viewer reads the edit history top-to-bottom.


@app.get("/api/admin/entries/{entry_id}/edit-log",
         response_model=list[EntryEditLogRecord])
async def admin_entry_edit_log(entry_id: int, request: Request):
    await _require_admin_user(request)
    rows = await list_edit_log_for_entry(DB_PATH, entry_id)
    return rows


@app.get("/api/admin/scans/{scan_id}/edit-log",
         response_model=list[EntryEditLogRecord])
async def admin_scan_edit_log(scan_id: str, request: Request):
    """Convenience: dashboard pivots on scan_id, edit log keys on entry_id.
    Returns [] (not 404) when the scan has no entry — the absence of
    edits is itself meaningful information for the dashboard to render."""
    await _require_admin_user(request)
    rows = await list_edit_log_for_scan(DB_PATH, scan_id)
    return rows


# ── Admin user management (Phase 5) ───────────────────────────────────────
# All gated by `_require_admin_user`. Self-protection rules:
#   - Admin cannot delete their own account
#   - Admin cannot disable their own account
#   - Admin cannot demote their own role
# Without these guards, an admin could lock themselves out by mistake
# (and there's no recovery path without server access).


def _strip_password_hash(user: dict) -> dict:
    """Remove sensitive fields from a user dict before returning to the
    client. Used for every admin user endpoint."""
    return {k: v for k, v in user.items() if k != "password_hash"}


@app.get("/api/admin/users", response_model=list[UserAdminPublic])
async def admin_list_users(request: Request):
    await _require_admin_user(request)
    users = await list_all_users(DB_PATH)
    return [_strip_password_hash(u) for u in users]


@app.get("/api/admin/users/{user_id}", response_model=UserAdminPublic)
async def admin_get_user(user_id: int, request: Request):
    await _require_admin_user(request)
    user = await get_user_by_id(DB_PATH, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    scan_count = await count_scans_for_user(DB_PATH, user_id)
    out = _strip_password_hash(user)
    out["scan_count"] = scan_count
    return out


@app.get("/api/admin/users/{user_id}/scans")
async def admin_user_scans(
    user_id: int, request: Request, limit: int = 50, offset: int = 0,
):
    await _require_admin_user(request)
    target = await get_user_by_id(DB_PATH, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    rows = await list_scans_for_user(DB_PATH, user_id, limit, offset)
    total = await count_scans_for_user(DB_PATH, user_id)
    return {
        "user_id": user_id, "username": target.get("username"),
        "total": total, "count": len(rows), "offset": offset,
        "scans": rows,
    }


@app.patch("/api/admin/users/{user_id}", response_model=UserAdminPublic)
async def admin_patch_user(
    user_id: int, request: Request, payload: AdminUserUpdate,
):
    admin = await _require_admin_user(request)
    target = await get_user_by_id(DB_PATH, user_id)
    if not target:
        raise HTTPException(404, "User not found")

    is_self = admin["id"] == user_id
    if payload.status is not None:
        if is_self and payload.status != "active":
            raise HTTPException(400, "Cannot disable your own account")
        await update_user_status(DB_PATH, user_id, payload.status)
        if payload.status == "disabled":
            # Revoke all sessions so the disable takes effect immediately.
            await delete_all_user_sessions(DB_PATH, user_id)
        logger.info("admin_user_status_changed", extra={
            "actor_id": admin["id"], "user_id": user_id, "status": payload.status,
        })
    if payload.role is not None:
        if is_self and payload.role != "admin":
            raise HTTPException(400, "Cannot demote your own role")
        await update_user_role(DB_PATH, user_id, payload.role)
        logger.info("admin_user_role_changed", extra={
            "actor_id": admin["id"], "user_id": user_id, "role": payload.role,
        })

    fresh = await get_user_by_id(DB_PATH, user_id)
    scan_count = await count_scans_for_user(DB_PATH, user_id)
    out = _strip_password_hash(fresh)
    out["scan_count"] = scan_count
    return out


@app.post(
    "/api/admin/users/{user_id}/reset-password", response_model=UserAdminPublic,
)
async def admin_reset_password(
    user_id: int, request: Request, payload: AdminResetPasswordRequest,
):
    admin = await _require_admin_user(request)
    target = await get_user_by_id(DB_PATH, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    ok, err = validate_password(payload.password)
    if not ok:
        raise HTTPException(422, err)
    await update_user_password(DB_PATH, user_id, hash_password(payload.password))
    # Force re-login: every session for this user is invalidated.
    revoked = await delete_all_user_sessions(DB_PATH, user_id)
    logger.info("admin_user_password_reset", extra={
        "actor_id": admin["id"], "user_id": user_id, "sessions_revoked": revoked,
    })
    fresh = await get_user_by_id(DB_PATH, user_id)
    out = _strip_password_hash(fresh)
    out["scan_count"] = await count_scans_for_user(DB_PATH, user_id)
    return out


@app.delete("/api/admin/users/{user_id}")
async def admin_delete_user(user_id: int, request: Request):
    admin = await _require_admin_user(request)
    if admin["id"] == user_id:
        raise HTTPException(400, "Cannot delete your own account")
    target = await get_user_by_id(DB_PATH, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    # Clean up the avatar file on disk before the DB row goes away.
    if target.get("avatar_path"):
        path = AVATARS_DIR / target["avatar_path"]
        if path.exists():
            try:
                path.unlink()
            except OSError as e:
                logger.warning("admin_avatar_cleanup_failed", extra={
                    "user_id": user_id, "error": str(e),
                })
    ok = await delete_user(DB_PATH, user_id)
    if not ok:
        raise HTTPException(500, "Delete failed")
    logger.info("admin_user_deleted", extra={
        "actor_id": admin["id"], "user_id": user_id,
        "username": target.get("username"),
    })
    return {"ok": True, "deleted_user_id": user_id}


def _looks_like_browser(user_agent: str) -> bool:
    """Heuristic: does this UA look like a real browser? Used by the /
    route to decide whether to auto-spawn a guest (browser → yes) or
    redirect to /login (curl, scripts, bots → no). False positives
    create stray guest rows the nightly cleanup will sweep; false
    negatives just deliver /login to a confused real user, who can
    still log in / register manually.

    Most browsers (even ancient ones) include 'mozilla' in their UA
    for legacy-compatibility reasons. The other tokens cover the rare
    cases (e.g. some old IE forks, exotic mobile browsers).
    """
    if not user_agent:
        return False
    ua = user_agent.lower()
    return any(marker in ua for marker in (
        "mozilla", "webkit", "chrome", "firefox",
        "safari", "edge", "trident", "gecko", "opera",
    ))


@app.get("/")
async def root(request: Request, response: Response):
    """Auth gate for the main app.
      - Existing session → serve the app. Username `0` going to / is
        allowed (they have role='admin' but may navigate here
        intentionally); the post-login auto-redirect to /admin happens
        client-side based on the response of /api/auth/login.
      - No session + looks-like-browser → auto-spawn a guest and serve
        the app. First-time visitors land directly in the scanner
        instead of seeing /login. Their 5 free scans accumulate against
        this guest user_id; upgrading to a real account preserves
        the id (and therefore the scans, entries, settings, water log).
      - No session + non-browser → existing redirect to /login. Curl,
        scripts, and bots get the friendly URL hint without polluting
        the users table with throwaway guest rows.
    """
    user = await _get_request_user(request)
    if user:
        return FileResponse("static/index.html")

    if _looks_like_browser(request.headers.get("user-agent", "")):
        # Build the FileResponse first, then attach the session cookie
        # DIRECTLY to it. FastAPI's `response: Response` cookie merging
        # only fires when FastAPI builds the response itself (e.g. from
        # a Pydantic return); pre-built Response subclasses are used
        # as-is, with cookies set on the `response` param dropped.
        _user, sid = await _create_guest_user(request)
        file_resp = FileResponse("static/index.html")
        _set_session_cookie(file_resp, sid)
        return file_resp

    return RedirectResponse("/login", status_code=302)


@app.get("/login")
async def login_page(request: Request):
    """Public route — but if the visitor already has a valid session,
    bounce them to where they should be (admin → /admin, anyone else →
    /) so a stray bookmark or back-button hit doesn't strand them on
    a useless form."""
    user = await _get_request_user(request)
    if user:
        target = "/admin" if user.get("username") == "0" else "/"
        return RedirectResponse(target, status_code=302)
    return FileResponse("static/login/index.html")


@app.get("/landing")
async def landing():
    return FileResponse("static/landing/index.html")


@app.get("/reset")
async def reset_page():
    """Phase 3.7 — password reset page. Public route. The password-
    reset email contains a link to /reset?token=X; this serves the SPA
    that POSTs the token + new password to /api/auth/password-reset/
    confirm. The page itself reads ?token from the URL client-side, so
    no server-side token validation happens here — the SPA shows an
    "expired link" card on 410 from the API."""
    return FileResponse("static/reset/index.html")


# ── Phase 1: legal pages (public, no auth) ────────────────────────────────
# /privacy and /terms are stable URLs required by 152-ФЗ — they MUST be
# reachable without a session cookie so unregistered visitors can read
# the policy before consenting at /login. The static HTML embeds
# placeholder spans (data-legal="operator_name" etc.) that the page
# fills on load by fetching /api/legal/info — keeps the policy text
# editable in one HTML file while operator info lives in env vars.


@app.get("/api/legal/info")
async def legal_info():
    """Operator + consent-version metadata. Public — no PII here, just
    the legally-required disclosure. Pages render this with one fetch
    call on load instead of a server-side template engine."""
    return {
        "operator_name":    OPERATOR_NAME,
        "operator_city":    OPERATOR_CITY,
        "consent_version":  CONSENT_VERSION_CURRENT,
    }


@app.get("/privacy")
async def privacy_page():
    return FileResponse("static/privacy/index.html")


@app.get("/terms")
async def terms_page():
    return FileResponse("static/terms/index.html")


@app.get("/admin")
async def admin_page(request: Request):
    """Server-side gate. No session → /login. Logged in but not admin →
    bounce to /. Only authenticated admins ever see the dashboard HTML.
    The admin JS does its own /api/auth/me check on load too — belt and
    braces: server gate prevents direct hits, client gate handles
    session-expiry-while-page-is-open."""
    user = await _get_request_user(request)
    if not user:
        return RedirectResponse("/login", status_code=302)
    if user.get("role") != "admin":
        return RedirectResponse("/", status_code=302)
    return FileResponse("static/admin/index.html")


app.mount("/static", StaticFiles(directory="static"), name="static")
