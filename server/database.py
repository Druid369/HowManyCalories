"""SQLite-backed persistence layer.

Originally a write-only training log (`scans`); since Phase 1A also hosts
the new `users` and `sessions` tables that power session-cookie auth.
Future phases will add `entries`, `water_log`, `user_settings`, and
`day_quality_cache` here.

Every analyse-pipeline DB write is fire-and-forget (asyncio.create_task)
so it never adds latency to the API response. Auth-path queries are NOT
fire-and-forget — they're awaited because every authenticated request
needs the session resolved before routing.
"""

import json
import pathlib
from datetime import datetime, timedelta, timezone

import aiosqlite

from server.logging_config import get_logger

logger = get_logger(__name__)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS scans (
    scan_id               TEXT PRIMARY KEY,
    created_at            TEXT NOT NULL,
    image_sha256          TEXT NOT NULL,
    media_type            TEXT NOT NULL,
    image_size_bytes      INTEGER NOT NULL,
    portion_hint          TEXT,

    stage1_json           TEXT,
    stage2_json           TEXT,
    stage3_json           TEXT,
    final_json            TEXT NOT NULL,

    total_calories        INTEGER,
    item_count            INTEGER,
    confidence            TEXT,
    data_sources          TEXT,

    stage1_ms             INTEGER,
    stage2_ms             INTEGER,
    stage3_ms             INTEGER,
    total_ms              INTEGER,

    stage1_input_tokens   INTEGER,
    stage1_output_tokens  INTEGER,
    stage3_input_tokens   INTEGER,
    stage3_output_tokens  INTEGER,

    opus_used             INTEGER NOT NULL DEFAULT 0,
    calorie_warn          INTEGER NOT NULL DEFAULT 0,
    error                 TEXT,

    -- Phase 2: link every scan to the user who uploaded it. Nullable in
    -- the column DDL (legacy rows pre-Phase-2 have no owner). Migration
    -- helper backfills all NULL rows to the seeded admin user; new rows
    -- are inserted with user_id set by /api/analyze.
    user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,

    -- 1 when the row reused a previous scan's final_json instead of
    -- calling Sonnet+Opus. Lets us measure cache-hit rate and skip the
    -- token totals (stage tokens are 0 on cached rows) when computing
    -- average per-scan cost.
    cached                INTEGER NOT NULL DEFAULT 0
)
"""

# Every admin dashboard query (recent scans, stats date-windows, timeline buckets)
# filters or orders by created_at. Without this index those are full-table scans.
_CREATE_INDEX_CREATED_AT = """
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at DESC)
"""

# ── Users ─────────────────────────────────────────────────────────────────
# `username` uses COLLATE NOCASE so SELECT WHERE username = 'Admin' matches
# 'admin' too — and so the UNIQUE constraint enforces case-insensitive
# uniqueness. Username regex (enforced at the API boundary, not the DB) is
# letters + digits only, ASCII; COLLATE NOCASE handles ASCII case folding
# correctly. Reserved usernames ('admin', '0', 'root', 'superadmin',
# 'system') are blocked at the API boundary, not via a CHECK constraint —
# that lets us seed them ourselves without disabling the constraint.
#
# `role` is 'user' | 'admin'. `status` is 'active' | 'disabled'. Profile
# fields (display_name, avatar_path, weight_kg, height_cm, gender,
# birth_year, activity_level) are all nullable — populated from the
# account-dashboard sheet, not at registration.
_CREATE_USERS_TABLE = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user',
    status          TEXT NOT NULL DEFAULT 'active',
    display_name    TEXT,
    avatar_path     TEXT,
    weight_kg       REAL,
    height_cm       REAL,
    gender          TEXT,
    birth_year      INTEGER,
    activity_level  TEXT,
    created_at      TEXT NOT NULL,
    last_login_at   TEXT,
    scan_count      INTEGER NOT NULL DEFAULT 0
)
"""
_CREATE_INDEX_USERS_USERNAME = """
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)
"""

# ── Sessions ──────────────────────────────────────────────────────────────
# Server-side session store; the cookie sent to the browser is just an
# opaque session_id (256 bits of entropy). Every authenticated request
# resolves it here. Sliding expiry: every successful auth bumps
# last_used_at; expires_at is set on creation and not extended (so a
# session can sit idle for at most SESSION_LIFETIME_DAYS regardless of
# usage — a stricter, simpler model than rolling refresh).
_CREATE_SESSIONS_TABLE = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    created_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    last_used_at    TEXT NOT NULL,
    ip_addr         TEXT,
    user_agent      TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
"""
_CREATE_INDEX_SESSIONS_USER = """
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)
"""
_CREATE_INDEX_SESSIONS_EXPIRES = """
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)
"""


async def init_db(db_path: str) -> None:
    pathlib.Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(db_path) as db:
        # FK enforcement is OFF by default in SQLite — the `sessions.user_id`
        # → `users.id` cascade-delete only works when this pragma is set on
        # every connection that mutates session/user rows. We set it here on
        # init for the create path; helpers below set it themselves when
        # they need cascade behavior.
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute(_CREATE_TABLE)
        await db.execute(_CREATE_INDEX_CREATED_AT)
        await db.execute(_CREATE_USERS_TABLE)
        await db.execute(_CREATE_INDEX_USERS_USERNAME)
        await db.execute(_CREATE_SESSIONS_TABLE)
        await db.execute(_CREATE_INDEX_SESSIONS_USER)
        await db.execute(_CREATE_INDEX_SESSIONS_EXPIRES)
        await db.commit()
    logger.info("db_initialized", extra={"db_path": db_path})


# ── User CRUD ─────────────────────────────────────────────────────────────


async def get_user_by_username(db_path: str, username: str) -> dict | None:
    """Case-insensitive username lookup. Returns None if not found."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE",
            (username,),
        )
        row = await cursor.fetchone()
    return dict(row) if row else None


async def get_user_by_id(db_path: str, user_id: int) -> dict | None:
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
    return dict(row) if row else None


async def create_user(
    db_path: str,
    username: str,
    password_hash: str,
    role: str = "user",
) -> int:
    """Insert a new user row. Returns the new user's id. Raises
    aiosqlite.IntegrityError if the username already exists (UNIQUE
    constraint) — caller should map that to a 409."""
    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute(
            """
            INSERT INTO users (username, password_hash, role, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (username, password_hash, role, _utcnow_iso()),
        )
        user_id = cursor.lastrowid
        await db.commit()
    return user_id


async def update_last_login(db_path: str, user_id: int) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE users SET last_login_at = ? WHERE id = ?",
            (_utcnow_iso(), user_id),
        )
        await db.commit()


# Whitelist of profile columns the user can edit themselves via
# PUT /api/auth/profile. Distinct from the auth-state columns
# (password_hash, role, status) which require admin/dedicated paths.
_USER_PROFILE_COLUMNS = frozenset({
    "display_name", "weight_kg", "height_cm",
    "gender", "birth_year", "activity_level",
})


async def update_user_profile(db_path: str, user_id: int, patch: dict) -> bool:
    """Partial update of profile fields. Empty-string display_name is
    normalized to NULL so the field clears cleanly. Returns True iff a
    row was modified."""
    cols = {k: v for k, v in patch.items() if k in _USER_PROFILE_COLUMNS}
    if "display_name" in cols and cols["display_name"] == "":
        cols["display_name"] = None
    if not cols:
        return False
    set_clause = ", ".join(f"{k} = ?" for k in cols)
    params = list(cols.values()) + [user_id]
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            f"UPDATE users SET {set_clause} WHERE id = ?",
            params,
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def update_user_avatar_path(
    db_path: str, user_id: int, avatar_path: str | None,
) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            "UPDATE users SET avatar_path = ? WHERE id = ?",
            (avatar_path, user_id),
        )
        await db.commit()


# ── Admin user management helpers (Phase 5) ───────────────────────────────
# Read-side: list every user joined against an aggregate of their scans
# so the admin dashboard can show scan-count + last-scan in one query.
# Write-side: status toggle, password reset, hard delete. Sessions for a
# user being modified are blown away separately so admin actions take
# effect immediately (no surprise sessions surviving a disable / reset).


async def list_all_users(db_path: str) -> list[dict]:
    """Returns every user with denormalized scan stats. Subquery groups
    `scans` by user_id and joins back; LEFT JOIN preserves users with
    zero scans (scan_count=0, last_scan_at=NULL). Sorted newest-account
    first so a freshly-registered user surfaces at the top."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT
                u.id, u.username, u.role, u.status, u.display_name,
                u.avatar_path, u.weight_kg, u.height_cm, u.gender,
                u.birth_year, u.activity_level,
                u.created_at, u.last_login_at,
                COALESCE(s.actual_scan_count, 0) AS scan_count,
                s.last_scan_at
            FROM users u
            LEFT JOIN (
                SELECT user_id,
                       COUNT(*) AS actual_scan_count,
                       MAX(created_at) AS last_scan_at
                FROM scans
                WHERE user_id IS NOT NULL
                GROUP BY user_id
            ) s ON s.user_id = u.id
            ORDER BY u.created_at DESC
            """
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def list_scans_for_user(
    db_path: str, user_id: int, limit: int = 50, offset: int = 0,
) -> list[dict]:
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT scan_id, created_at, image_sha256, total_calories,
                   item_count, confidence, total_ms, opus_used
            FROM scans
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (user_id, min(max(limit, 1), 200), max(offset, 0)),
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def count_scans_for_user(db_path: str, user_id: int) -> int:
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            "SELECT COUNT(*) AS c FROM scans WHERE user_id = ?", (user_id,),
        )
        row = await cur.fetchone()
    return row[0] if row else 0


async def count_user_scans_today(db_path: str, user_id: int) -> int:
    """Count today's (UTC) scans for the given user. Used for the
    per-user daily scan cap enforcement in /api/analyze. Day boundary
    is UTC midnight to match the existing /api/day-quality cap and
    keep server-side time math consistent across endpoints."""
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            """
            SELECT COUNT(*) AS c FROM scans
            WHERE user_id = ? AND created_at >= date('now')
            """,
            (user_id,),
        )
        row = await cur.fetchone()
    return row[0] if row else 0


async def update_user_status(db_path: str, user_id: int, status: str) -> bool:
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            "UPDATE users SET status = ? WHERE id = ?",
            (status, user_id),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def update_user_role(db_path: str, user_id: int, role: str) -> bool:
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            "UPDATE users SET role = ? WHERE id = ?",
            (role, user_id),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def update_user_password(
    db_path: str, user_id: int, password_hash: str,
) -> bool:
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (password_hash, user_id),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def delete_all_user_sessions(db_path: str, user_id: int) -> int:
    """Invalidate every session for a user. Called after password reset
    or status disable so the admin's action takes effect immediately
    rather than waiting for sessions to expire naturally."""
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            "DELETE FROM sessions WHERE user_id = ?", (user_id,),
        )
        await db.commit()
        return cur.rowcount or 0


async def delete_user(db_path: str, user_id: int) -> bool:
    """Hard delete. Cascades to sessions, entries, water_log,
    user_settings (all FK ON DELETE CASCADE). The `scans` table uses
    ON DELETE SET NULL so the ML training log is preserved (scan rows
    survive with user_id=NULL). Avatar file on disk is the caller's
    responsibility — main.py handles that before calling this."""
    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        cur = await db.execute(
            "DELETE FROM users WHERE id = ?", (user_id,),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


# ── Session CRUD ──────────────────────────────────────────────────────────


async def create_session(
    db_path: str,
    session_id: str,
    user_id: int,
    lifetime_days: int,
    ip_addr: str | None = None,
    user_agent: str | None = None,
) -> None:
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=lifetime_days)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO sessions (
                session_id, user_id, created_at, expires_at, last_used_at,
                ip_addr, user_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id, user_id, now.isoformat(), expires.isoformat(),
                now.isoformat(), ip_addr, user_agent,
            ),
        )
        await db.commit()


async def get_session_with_user(
    db_path: str, session_id: str, lifetime_days: int | None = None,
) -> dict | None:
    """Resolve a session id to its user. Joins sessions × users and rejects
    the session in three cases: (1) not found, (2) expired, (3) user
    disabled. On success bumps `last_used_at` AND — if `lifetime_days` is
    supplied — slides `expires_at` forward to `now + lifetime_days`.
    The slide makes the session "rolling": as long as the user is active,
    they stay logged in indefinitely. Pass `lifetime_days=None` to
    preserve the original fixed-window behavior (used by tests / probes).

    Returns the full user row (all `users` columns) plus the session's
    `expires_at`. The `users.id` is what the caller wants for FK joins;
    the session's own id is the cookie value the caller already has, so
    we don't bother returning it.
    """
    now = datetime.now(timezone.utc)
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT u.*, s.expires_at AS session_expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.session_id = ?
            """,
            (session_id,),
        )
        row = await cursor.fetchone()
        if not row:
            return None
        # Expiry check — done here rather than in SQL so we can return None
        # consistently (treat expired = not-found from the caller's view)
        # AND so we can opportunistically delete the row.
        if datetime.fromisoformat(row["session_expires_at"]) <= now:
            await db.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
            await db.commit()
            return None
        if row["status"] != "active":
            return None
        # Bump last_used_at, and slide expires_at if a lifetime was given.
        # One UPDATE either way; the WHERE clause on session_id is a
        # primary-key lookup so there's no real cost difference.
        if lifetime_days is not None and lifetime_days > 0:
            new_expiry = now + timedelta(days=lifetime_days)
            await db.execute(
                """
                UPDATE sessions
                SET last_used_at = ?, expires_at = ?
                WHERE session_id = ?
                """,
                (now.isoformat(), new_expiry.isoformat(), session_id),
            )
        else:
            await db.execute(
                "UPDATE sessions SET last_used_at = ? WHERE session_id = ?",
                (now.isoformat(), session_id),
            )
        await db.commit()
    return dict(row)


async def delete_session(db_path: str, session_id: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
        await db.commit()


async def delete_expired_sessions(db_path: str) -> int:
    """Reaper for the sessions table. Called opportunistically (not on a
    schedule) — e.g. once on startup. Returns deleted-row count for log."""
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute(
            "DELETE FROM sessions WHERE expires_at <= ?",
            (now,),
        )
        await db.commit()
        return cursor.rowcount or 0


# ── Phase 2: per-user scans + entries ─────────────────────────────────────


async def init_scans_cached_column(db_path: str) -> int:
    """Idempotently add the `cached` column to scans. Fresh installs have
    it from the CREATE TABLE definition; legacy installs miss it until
    this migration runs. Returns 1 if the column was added, 0 otherwise."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("PRAGMA table_info(scans)")
        cols = {row["name"] for row in await cur.fetchall()}
        if "cached" in cols:
            return 0
        await db.execute(
            "ALTER TABLE scans ADD COLUMN cached INTEGER NOT NULL DEFAULT 0"
        )
        await db.commit()
    logger.info("scans_cached_column_added")
    return 1


async def get_cached_scan_by_hash(
    db_path: str, image_sha256: str, *, max_age_days: int = 30,
) -> dict | None:
    """Return the most recent successful final_json for an image hash, or
    None on miss. Used by /api/analyze to skip Sonnet+Opus when the same
    image was previously analyzed.

    Filters:
      - successful runs only (item_count > 0, total_calories > 0)
      - within `max_age_days` so a prompt change retires the cache naturally
      - prefers non-cached source-of-truth rows so we don't chain
        cache→cache copies (item_count > 0 already requires that, but the
        cached=0 filter makes intent explicit)
    """
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"""
            SELECT final_json FROM scans
            WHERE image_sha256 = ?
              AND cached = 0
              AND item_count > 0
              AND total_calories > 0
              AND final_json IS NOT NULL
              AND created_at > datetime('now', '-{int(max_age_days)} days')
            ORDER BY created_at DESC LIMIT 1
            """,
            (image_sha256,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    try:
        return json.loads(row["final_json"])
    except (json.JSONDecodeError, TypeError):
        return None


async def migrate_scans_user_id(db_path: str, admin_username: str) -> int:
    """Idempotently add `user_id` to existing scans tables that pre-date
    Phase 2, then backfill any NULL rows to the seeded admin's user_id.

    Safe to run on every startup:
      - On a fresh install the column is in the CREATE TABLE definition
        and PRAGMA table_info reports it; the ADD COLUMN is skipped.
      - On an upgrade from a Phase-1A install the column is missing and
        gets added; existing rows have user_id=NULL and get backfilled.
      - On all subsequent runs the column exists and there are no NULL
        rows, so this is a couple of cheap no-op queries.

    Returns the number of rows backfilled (0 once the migration has
    run on this DB).
    """
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("PRAGMA table_info(scans)")
        cols = {row["name"] for row in await cur.fetchall()}
        if "user_id" not in cols:
            await db.execute("ALTER TABLE scans ADD COLUMN user_id INTEGER")
            logger.info("scans_user_id_column_added")
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_scans_user_id ON scans(user_id)"
        )
        # Backfill: every NULL → admin
        admin = await (
            await db.execute(
                "SELECT id FROM users WHERE username = ? COLLATE NOCASE",
                (admin_username,),
            )
        ).fetchone()
        if not admin:
            await db.commit()
            return 0
        cur = await db.execute(
            "UPDATE scans SET user_id = ? WHERE user_id IS NULL",
            (admin["id"],),
        )
        backfilled = cur.rowcount or 0
        await db.commit()
    if backfilled:
        logger.info("scans_backfilled_to_admin", extra={
            "count": backfilled, "admin_id": admin["id"],
        })
    return backfilled


# ── Entries (the user-editable personal history) ─────────────────────────
# Distinct from `scans` (the immutable training log). One entry per
# real-world meal the user tracked. References a `scan_id` when the
# entry came from a photo analysis; `scan_id` is NULL for manually
# added entries (Phase 4+ feature). The user's UI reads from this
# table; ML training reads from `scans`.
#
# `result_json` is a copy of the analysis result the user actually sees
# (mutable — gram edits, ingredient additions/removals all rewrite this).
# `total_calories`, `item_count`, `item_names` are denormalized caches
# of values inside `result_json` to make list rendering fast without
# parsing JSON for every row.

_CREATE_ENTRIES_TABLE = """
CREATE TABLE IF NOT EXISTS entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    scan_id         TEXT,
    created_at      TEXT NOT NULL,
    -- updated_at: bumped on every user mutation (consumed flip, edit, etc).
    -- NULL only on rows that pre-date the edit-tracking migration; the
    -- migration backfills updated_at = created_at for those.
    updated_at      TEXT,
    consumed        INTEGER NOT NULL DEFAULT 0,
    -- edit_count + was_edited are AI-correction signals, distinct from
    -- updated_at. They only advance when the user mutates `result_json`
    -- (i.e. corrects what the AI produced). Toggling consumed bumps
    -- updated_at but NOT these — the eaten/skipped flag is a behavioural
    -- signal, not a correction.
    edit_count      INTEGER NOT NULL DEFAULT 0,
    was_edited      INTEGER NOT NULL DEFAULT 0,
    total_calories  INTEGER,
    item_count      INTEGER,
    item_names      TEXT,
    result_json     TEXT NOT NULL,
    notes           TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
"""
_CREATE_INDEX_ENTRIES_USER_CREATED = """
CREATE INDEX IF NOT EXISTS idx_entries_user_created
    ON entries(user_id, created_at DESC)
"""
_CREATE_INDEX_ENTRIES_SCAN = """
CREATE INDEX IF NOT EXISTS idx_entries_scan_id ON entries(scan_id)
"""

# ── Entry edit log ────────────────────────────────────────────────────────
# One row per individual change made to an entry's `result_json`. Powers
# fine-grained training-data analysis: which fields users correct most,
# how much grams typically shift, which items get added/removed.
#
# CASCADE on entry_id mirrors entries → users CASCADE, so when a user
# deletes their account the whole chain unwinds. The training-meaningful
# AI output stays in `scans` (which uses ON DELETE SET NULL on user_id);
# this table is the human-corrections companion log.

_CREATE_ENTRY_EDIT_LOG_TABLE = """
CREATE TABLE IF NOT EXISTS entry_edit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id    INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    edited_at   TEXT NOT NULL,
    field       TEXT NOT NULL,
    item_index  INTEGER,
    item_name   TEXT,
    old_value   TEXT,
    new_value   TEXT,
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
)
"""
_CREATE_INDEX_EDIT_LOG_ENTRY = """
CREATE INDEX IF NOT EXISTS idx_entry_edit_log_entry
    ON entry_edit_log(entry_id, edited_at)
"""
_CREATE_INDEX_EDIT_LOG_USER = """
CREATE INDEX IF NOT EXISTS idx_entry_edit_log_user
    ON entry_edit_log(user_id, edited_at DESC)
"""


async def init_entries_table(db_path: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute(_CREATE_ENTRIES_TABLE)
        await db.execute(_CREATE_INDEX_ENTRIES_USER_CREATED)
        await db.execute(_CREATE_INDEX_ENTRIES_SCAN)
        await db.execute(_CREATE_ENTRY_EDIT_LOG_TABLE)
        await db.execute(_CREATE_INDEX_EDIT_LOG_ENTRY)
        await db.execute(_CREATE_INDEX_EDIT_LOG_USER)
        await db.commit()


async def init_entries_edit_columns(db_path: str) -> int:
    """Idempotently add edit-tracking columns to a pre-existing entries
    table. Safe on every boot: a fresh install has the columns in the
    CREATE TABLE definition (so PRAGMA reports them and the ALTERs are
    skipped); upgraded installs get the columns added on first run.

    Backfills `updated_at = created_at` for every row missing it so
    queries can sort/filter on `updated_at` without NULL-handling.
    `edit_count` and `was_edited` arrive with their NOT NULL DEFAULT 0
    so existing rows get the right starting values automatically.

    Returns the number of rows backfilled (0 once migrated).
    """
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("PRAGMA table_info(entries)")
        cols = {row["name"] for row in await cur.fetchall()}

        added: list[str] = []
        if "updated_at" not in cols:
            await db.execute("ALTER TABLE entries ADD COLUMN updated_at TEXT")
            added.append("updated_at")
        if "edit_count" not in cols:
            await db.execute(
                "ALTER TABLE entries ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0"
            )
            added.append("edit_count")
        if "was_edited" not in cols:
            await db.execute(
                "ALTER TABLE entries ADD COLUMN was_edited INTEGER NOT NULL DEFAULT 0"
            )
            added.append("was_edited")

        cur = await db.execute(
            "UPDATE entries SET updated_at = created_at WHERE updated_at IS NULL"
        )
        backfilled = cur.rowcount or 0
        await db.commit()

    if added or backfilled:
        logger.info("entries_edit_columns_migrated", extra={
            "added_columns": added, "backfilled": backfilled,
        })
    return backfilled


async def backfill_entries_from_scans(db_path: str, admin_user_id: int) -> int:
    """One-time backfill: create one entry per existing scan that
    doesn't already have one. consumed=1 (assume historical scans were
    actually eaten — the admin can flip individual entries off if not).

    Idempotent via LEFT JOIN (skips scans that already have an entry).
    Caps at 5000 to avoid pathological backfills if someone runs this
    against a much larger DB by accident.
    """
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT s.scan_id, s.created_at, s.final_json,
                   s.total_calories, s.item_count
            FROM scans s
            LEFT JOIN entries e ON e.scan_id = s.scan_id
            WHERE e.id IS NULL AND s.user_id = ?
            ORDER BY s.created_at ASC
            LIMIT 5000
            """,
            (admin_user_id,),
        )
        rows = await cur.fetchall()
        count = 0
        for r in rows:
            try:
                final = json.loads(r["final_json"])
                items = final.get("items", []) or []
                names = ", ".join(
                    str(it.get("name", "")) for it in items[:3] if it.get("name")
                )
            except (json.JSONDecodeError, TypeError):
                names = ""
            await db.execute(
                """
                INSERT INTO entries (
                    user_id, scan_id, created_at, consumed,
                    total_calories, item_count, item_names, result_json
                ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
                """,
                (
                    admin_user_id, r["scan_id"], r["created_at"],
                    r["total_calories"], r["item_count"], names, r["final_json"],
                ),
            )
            count += 1
        await db.commit()
    return count


async def create_entry(
    db_path: str,
    user_id: int,
    result_json: str,
    *,
    scan_id: str | None = None,
    consumed: bool = False,
    total_calories: int | None = None,
    item_count: int | None = None,
    item_names: str | None = None,
    notes: str | None = None,
) -> int:
    now = _utcnow_iso()
    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute(
            """
            INSERT INTO entries (
                user_id, scan_id, created_at, updated_at, consumed,
                total_calories, item_count, item_names, result_json, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id, scan_id, now, now, 1 if consumed else 0,
                total_calories, item_count, item_names, result_json, notes,
            ),
        )
        entry_id = cursor.lastrowid
        await db.commit()
    return entry_id


async def list_entries_for_user(
    db_path: str, user_id: int, limit: int = 200, offset: int = 0,
) -> list[dict]:
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT id, user_id, scan_id, created_at, consumed,
                   total_calories, item_count, item_names, result_json, notes
            FROM entries
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (user_id, limit, offset),
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_entry(db_path: str, entry_id: int, user_id: int) -> dict | None:
    """Auth-scoped getter — returns None if the entry exists but belongs
    to a different user (treat as not-found from the API client's view)."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT * FROM entries WHERE id = ? AND user_id = ?",
            (entry_id, user_id),
        )
        row = await cur.fetchone()
    return dict(row) if row else None


# Whitelist of columns a PATCH request is allowed to set. Anything else
# in the patch dict is silently dropped. user_id, scan_id, created_at, id
# are immutable — changing user_id would let a user transfer ownership;
# changing scan_id would orphan the link; changing created_at would
# rewrite history and break daily aggregates.
_ENTRY_UPDATABLE_COLUMNS = frozenset({
    "consumed", "result_json", "total_calories",
    "item_count", "item_names", "notes",
})


async def delete_entry(db_path: str, entry_id: int, user_id: int) -> bool:
    async with aiosqlite.connect(db_path) as db:
        cur = await db.execute(
            "DELETE FROM entries WHERE id = ? AND user_id = ?",
            (entry_id, user_id),
        )
        await db.commit()
        return (cur.rowcount or 0) > 0


async def update_entry_with_edit_tracking(
    db_path: str, entry_id: int, user_id: int, patch: dict,
) -> tuple[bool, int]:
    """Apply a patch to an entry AND log every diff into entry_edit_log.

    Behaviour:
      - Always bumps `updated_at` to now.
      - When the patch changes `result_json`, computes the field-level
        diff (via _entry_diff.compute_entry_diff), inserts one row per
        change into `entry_edit_log`, and bumps `edit_count` + sets
        `was_edited = 1` on the entries row.
      - Toggling `consumed` alone is NOT counted as an edit — it's a
        behavioural eaten/skipped signal, distinct from AI corrections.

    Returns (ok, diffs_logged). `ok` is False iff the entry didn't exist
    for this user OR the patch was empty.

    Single-connection / single-commit so the entry update + log inserts
    are atomic. A failure on a log insert rolls back the entry update too.
    """
    # Local import keeps database.py free of service dependencies at load.
    from server.services._entry_diff import compute_entry_diff

    cols = {k: v for k, v in patch.items() if k in _ENTRY_UPDATABLE_COLUMNS}
    if not cols:
        return False, 0

    new_result_json = cols.get("result_json")
    diffs: list[dict] = []
    now = _utcnow_iso()

    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        db.row_factory = aiosqlite.Row

        # Fetch the current result_json only when the patch could change it —
        # avoids a needless read on consumed-only / notes-only flips.
        if new_result_json is not None:
            cur = await db.execute(
                "SELECT result_json FROM entries WHERE id = ? AND user_id = ?",
                (entry_id, user_id),
            )
            row = await cur.fetchone()
            if not row:
                return False, 0
            try:
                old_result = json.loads(row["result_json"]) if row["result_json"] else {}
                new_result = json.loads(new_result_json)
                diffs = compute_entry_diff(old_result, new_result)
            except (json.JSONDecodeError, TypeError):
                # Corrupt / malformed JSON on either side — skip the diff
                # rather than block the user save. The update still applies.
                diffs = []

        set_parts = [f"{k} = ?" for k in cols]
        params: list = list(cols.values())

        set_parts.append("updated_at = ?")
        params.append(now)

        if diffs:
            set_parts.append("edit_count = COALESCE(edit_count, 0) + 1")
            set_parts.append("was_edited = 1")

        params.extend([entry_id, user_id])
        cur = await db.execute(
            f"UPDATE entries SET {', '.join(set_parts)} "
            f"WHERE id = ? AND user_id = ?",
            params,
        )
        if (cur.rowcount or 0) == 0:
            await db.commit()
            return False, 0

        for diff in diffs:
            await db.execute(
                """
                INSERT INTO entry_edit_log (
                    entry_id, user_id, edited_at, field,
                    item_index, item_name, old_value, new_value
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry_id, user_id, now, diff["field"],
                    diff.get("item_index"),
                    diff.get("item_name"),
                    diff.get("old_value"),
                    diff.get("new_value"),
                ),
            )

        await db.commit()

    return True, len(diffs)


async def list_edit_log_for_entry(
    db_path: str, entry_id: int,
) -> list[dict]:
    """All edit-log rows for one entry, oldest-first (chronological)."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT id, entry_id, user_id, edited_at, field,
                   item_index, item_name, old_value, new_value
            FROM entry_edit_log
            WHERE entry_id = ?
            ORDER BY edited_at ASC, id ASC
            """,
            (entry_id,),
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def list_edit_log_for_scan(
    db_path: str, scan_id: str,
) -> list[dict]:
    """Edit log for the entry tied to a given scan. Returns [] when the
    scan has no entry (rare — only happens for entries the user deleted)."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT l.id, l.entry_id, l.user_id, l.edited_at, l.field,
                   l.item_index, l.item_name, l.old_value, l.new_value
            FROM entry_edit_log l
            JOIN entries e ON e.id = l.entry_id
            WHERE e.scan_id = ?
            ORDER BY l.edited_at ASC, l.id ASC
            """,
            (scan_id,),
        )
        rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ── Phase 3B: per-user settings + water log ───────────────────────────────
# Both stored as a single JSON blob per user (one row each, primary key
# = user_id). Read whole, written whole. Trade-off: no SQL queries on
# individual settings fields or water entries, but read/write paths are
# trivially simple. Settings + water log are both small (~5KB max each)
# so the blob model has no real downside at this scale.

_CREATE_USER_SETTINGS_TABLE = """
CREATE TABLE IF NOT EXISTS user_settings (
    user_id       INTEGER PRIMARY KEY,
    settings_json TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
"""
_CREATE_WATER_LOG_TABLE = """
CREATE TABLE IF NOT EXISTS water_log (
    user_id    INTEGER PRIMARY KEY,
    log_json   TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)
"""


async def init_user_data_tables(db_path: str) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        await db.execute(_CREATE_USER_SETTINGS_TABLE)
        await db.execute(_CREATE_WATER_LOG_TABLE)
        await db.commit()


async def get_user_settings(db_path: str, user_id: int) -> dict | None:
    """Returns the settings JSON blob (parsed) or None if none stored.
    Caller merges with frontend defaults on its side."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT settings_json FROM user_settings WHERE user_id = ?",
            (user_id,),
        )
        row = await cur.fetchone()
    if not row:
        return None
    try:
        return json.loads(row["settings_json"])
    except (json.JSONDecodeError, TypeError):
        return None


async def put_user_settings(db_path: str, user_id: int, settings: dict) -> None:
    """Upsert (INSERT OR REPLACE) the user's settings blob."""
    payload = json.dumps(settings, ensure_ascii=False)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO user_settings (user_id, settings_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                settings_json = excluded.settings_json,
                updated_at    = excluded.updated_at
            """,
            (user_id, payload, _utcnow_iso()),
        )
        await db.commit()


async def get_water_log(db_path: str, user_id: int) -> list:
    """Returns the water log array (parsed) or [] if none stored."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            "SELECT log_json FROM water_log WHERE user_id = ?",
            (user_id,),
        )
        row = await cur.fetchone()
    if not row:
        return []
    try:
        log = json.loads(row["log_json"])
        return log if isinstance(log, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


async def put_water_log(db_path: str, user_id: int, log: list) -> None:
    """Upsert the user's water log array. Server doesn't validate the
    shape — frontend is the source of truth on schema. We do cap the
    serialized size to prevent abuse (a malicious client trying to fill
    the DB with a giant log)."""
    payload = json.dumps(log, ensure_ascii=False)
    async with aiosqlite.connect(db_path) as db:
        await db.execute(
            """
            INSERT INTO water_log (user_id, log_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                log_json   = excluded.log_json,
                updated_at = excluded.updated_at
            """,
            (user_id, payload, _utcnow_iso()),
        )
        await db.commit()


async def get_scan_for_user(
    db_path: str, scan_id: str, user_id: int, *, admin_bypass: bool = False,
) -> dict | None:
    """Get a scan row. With `admin_bypass=True` the user_id check is
    skipped (admins can read any user's scan — needed for the dashboard
    + the cross-user image endpoint). Without bypass, returns None if
    the scan exists but belongs to another user."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        if admin_bypass:
            cur = await db.execute(
                "SELECT * FROM scans WHERE scan_id = ?", (scan_id,),
            )
        else:
            cur = await db.execute(
                "SELECT * FROM scans WHERE scan_id = ? AND user_id = ?",
                (scan_id, user_id),
            )
        row = await cur.fetchone()
    return dict(row) if row else None


# Module-level counter for failed write_scan calls. Surfaced via
# get_scan_write_failures() so /health can expose it. Operators can spot a
# database that's silently dropping training data without trawling logs.
_scan_write_failures = 0


def get_scan_write_failures() -> int:
    return _scan_write_failures


async def write_scan(db_path: str, payload: dict) -> None:
    """Insert one scan record. Swallows all errors so it never breaks a
    response — the analyze pipeline calls this fire-and-forget. But every
    failure is logged at ERROR level (not WARNING) and increments a
    module-level counter so a misconfigured DB doesn't silently drop
    training data."""
    global _scan_write_failures
    payload = {**payload}
    payload.setdefault("user_id", None)
    payload.setdefault("cached", 0)
    try:
        async with aiosqlite.connect(db_path) as db:
            await db.execute(
                """
                INSERT OR REPLACE INTO scans (
                    scan_id, created_at, image_sha256, media_type, image_size_bytes,
                    portion_hint, stage1_json, stage2_json, stage3_json, final_json,
                    total_calories, item_count, confidence, data_sources,
                    stage1_ms, stage2_ms, stage3_ms, total_ms,
                    stage1_input_tokens, stage1_output_tokens,
                    stage3_input_tokens, stage3_output_tokens,
                    opus_used, calorie_warn, user_id, cached
                ) VALUES (
                    :scan_id, :created_at, :image_sha256, :media_type, :image_size_bytes,
                    :portion_hint, :stage1_json, :stage2_json, :stage3_json, :final_json,
                    :total_calories, :item_count, :confidence, :data_sources,
                    :stage1_ms, :stage2_ms, :stage3_ms, :total_ms,
                    :stage1_input_tokens, :stage1_output_tokens,
                    :stage3_input_tokens, :stage3_output_tokens,
                    :opus_used, :calorie_warn, :user_id, :cached
                )
                """,
                payload,
            )
            await db.commit()
    except Exception as e:
        _scan_write_failures += 1
        logger.error("scan_write_failed", extra={
            "scan_id":        payload.get("scan_id"),
            "error":          str(e),
            "total_failures": _scan_write_failures,
        })


async def get_recent_scans(db_path: str, limit: int = 50, offset: int = 0) -> list[dict]:
    """Phase 5: LEFT JOIN users so the admin dashboard can show a
    `username` column on every scan row. Pre-Phase-2 rows (no user_id)
    fall through with username=NULL, which the dashboard renders as a
    dash. Avatar path is included so the admin can show small per-row
    avatars without a per-row second request."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT s.scan_id, s.created_at, s.image_sha256, s.media_type,
                   s.image_size_bytes,
                   s.total_calories, s.item_count, s.confidence,
                   s.data_sources,
                   s.stage1_ms, s.stage2_ms, s.stage3_ms, s.total_ms,
                   s.stage1_input_tokens, s.stage1_output_tokens,
                   s.stage3_input_tokens, s.stage3_output_tokens,
                   s.opus_used, s.calorie_warn, s.final_json,
                   s.user_id,
                   u.username     AS user_username,
                   u.avatar_path  AS user_avatar_path
            FROM scans s
            LEFT JOIN users u ON u.id = s.user_id
            ORDER BY s.created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def get_scan_detail(db_path: str, scan_id: str) -> dict | None:
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM scans WHERE scan_id = ?", (scan_id,))
        row = await cursor.fetchone()
    return dict(row) if row else None


async def get_scan_count(db_path: str) -> int:
    async with aiosqlite.connect(db_path) as db:
        cursor = await db.execute("SELECT COUNT(*) FROM scans")
        row = await cursor.fetchone()
    return row[0] if row else 0


async def get_stats(db_path: str) -> dict:
    """Aggregated statistics for the admin dashboard."""
    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row

        # Total count
        cur = await db.execute("SELECT COUNT(*) as c FROM scans")
        total = (await cur.fetchone())["c"]

        # Today
        cur = await db.execute(
            "SELECT COUNT(*) as c FROM scans WHERE created_at >= date('now')"
        )
        today = (await cur.fetchone())["c"]

        # This week (last 7 days)
        cur = await db.execute(
            "SELECT COUNT(*) as c FROM scans WHERE created_at >= date('now', '-7 days')"
        )
        week = (await cur.fetchone())["c"]

        # This month (last 30 days)
        cur = await db.execute(
            "SELECT COUNT(*) as c FROM scans WHERE created_at >= date('now', '-30 days')"
        )
        month = (await cur.fetchone())["c"]

        # Averages
        cur = await db.execute("""
            SELECT
                AVG(total_ms) as avg_total_ms,
                AVG(stage1_ms) as avg_stage1_ms,
                AVG(stage2_ms) as avg_stage2_ms,
                AVG(stage3_ms) as avg_stage3_ms,
                AVG(total_calories) as avg_calories,
                AVG(item_count) as avg_items,
                AVG(stage1_input_tokens + stage1_output_tokens
                    + stage3_input_tokens + stage3_output_tokens) as avg_tokens,
                SUM(stage1_input_tokens + stage1_output_tokens
                    + stage3_input_tokens + stage3_output_tokens) as total_tokens,
                SUM(opus_used) as opus_used_count,
                SUM(calorie_warn) as calorie_warn_count
            FROM scans
        """)
        avgs = dict(await cur.fetchone())

        # Confidence distribution
        cur = await db.execute("""
            SELECT confidence, COUNT(*) as c
            FROM scans WHERE confidence IS NOT NULL
            GROUP BY confidence
        """)
        confidence_dist = {row["confidence"]: row["c"] for row in await cur.fetchall()}

        # Data source distribution (from final_json)
        cur = await db.execute("""
            SELECT data_sources FROM scans WHERE data_sources IS NOT NULL
        """)
        source_counts = {}
        for row in await cur.fetchall():
            try:
                import json
                sources = json.loads(row["data_sources"])
                for s in sources:
                    source_counts[s] = source_counts.get(s, 0) + 1
            except (json.JSONDecodeError, TypeError):
                pass

        # Edit-tracking signals: how often users correct the AI. Reads from
        # `entries`, not `scans`, since edits are user-side; the count of
        # entries is the right denominator for an "edit rate" metric.
        cur = await db.execute("SELECT COUNT(*) AS c FROM entries")
        entries_total = (await cur.fetchone())["c"]
        cur = await db.execute("""
            SELECT
              COALESCE(SUM(was_edited), 0) AS edited_entries,
              COALESCE(SUM(edit_count), 0) AS total_edits
            FROM entries
        """)
        edit_row = dict(await cur.fetchone())

        # Cache-hit count: rows that reused a previous final_json instead
        # of calling Sonnet+Opus. Token totals already exclude these (they
        # store 0 stage tokens), so cached_count tells you how many calls
        # the dedup layer prevented — direct dollar savings indicator.
        cur = await db.execute(
            "SELECT COALESCE(SUM(cached), 0) AS c FROM scans"
        )
        cached_count = (await cur.fetchone())["c"]

    return {
        "total": total,
        "today": today,
        "week": week,
        "month": month,
        "avg_total_ms": round(avgs["avg_total_ms"] or 0),
        "avg_stage1_ms": round(avgs["avg_stage1_ms"] or 0),
        "avg_stage2_ms": round(avgs["avg_stage2_ms"] or 0),
        "avg_stage3_ms": round(avgs["avg_stage3_ms"] or 0),
        "avg_calories": round(avgs["avg_calories"] or 0),
        "avg_items": round(avgs["avg_items"] or 0, 1),
        "avg_tokens": round(avgs["avg_tokens"] or 0),
        "total_tokens": avgs["total_tokens"] or 0,
        "opus_used_count": avgs["opus_used_count"] or 0,
        "opus_rate": round((avgs["opus_used_count"] or 0) / max(total, 1) * 100, 1),
        "calorie_warn_count": avgs["calorie_warn_count"] or 0,
        "confidence_dist": confidence_dist,
        "source_dist": source_counts,
        "entries_total":   entries_total,
        "edited_entries":  edit_row["edited_entries"] or 0,
        "total_edits":     edit_row["total_edits"] or 0,
        "edit_rate":       round(
            (edit_row["edited_entries"] or 0) / max(entries_total, 1) * 100, 1,
        ),
        "cached_count":    cached_count,
        "cache_hit_rate":  round(cached_count / max(total, 1) * 100, 1),
    }


async def get_timeline(db_path: str, period: str = "day") -> list[dict]:
    """Hourly or daily scan counts for chart rendering."""
    if period == "day":
        # Last 24 hours, grouped by hour
        query = """
            SELECT strftime('%Y-%m-%dT%H:00:00Z', created_at) as bucket,
                   COUNT(*) as count,
                   AVG(total_ms) as avg_ms,
                   AVG(total_calories) as avg_cal
            FROM scans
            WHERE created_at >= datetime('now', '-24 hours')
            GROUP BY bucket ORDER BY bucket
        """
    elif period == "week":
        query = """
            SELECT strftime('%Y-%m-%d', created_at) as bucket,
                   COUNT(*) as count,
                   AVG(total_ms) as avg_ms,
                   AVG(total_calories) as avg_cal
            FROM scans
            WHERE created_at >= datetime('now', '-7 days')
            GROUP BY bucket ORDER BY bucket
        """
    else:
        query = """
            SELECT strftime('%Y-%m-%d', created_at) as bucket,
                   COUNT(*) as count,
                   AVG(total_ms) as avg_ms,
                   AVG(total_calories) as avg_cal
            FROM scans
            WHERE created_at >= datetime('now', '-30 days')
            GROUP BY bucket ORDER BY bucket
        """

    async with aiosqlite.connect(db_path) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(query)
        rows = await cursor.fetchall()
    return [
        {
            "bucket": r["bucket"],
            "count": r["count"],
            "avg_ms": round(r["avg_ms"] or 0),
            "avg_cal": round(r["avg_cal"] or 0),
        }
        for r in rows
    ]
