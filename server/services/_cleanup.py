"""Maintenance jobs that prune stale rows from the database.

Currently one job: `delete_abandoned_guests`. Designed to run
opportunistically on server startup (called from main.lifespan), so
no scheduler is required — every restart sweeps the table. With a
small Russian/CIS install this is sufficient; on horizontal scale-out
either worker doing the cleanup is fine since the operation is
idempotent (deletes nothing on a re-run).

Why hard-delete instead of soft-delete + flag: guests are
intentionally transient. Keeping abandoned-guest rows around adds no
training-data value (the underlying `scans` rows survive the user
delete via ON DELETE SET NULL on scans.user_id), and the table
filling up with tire-kicker guests slows admin queries that join
`users`. Hard-delete is the right move.
"""

import aiosqlite

from server.logging_config import get_logger

logger = get_logger(__name__)


async def delete_abandoned_guests(
    db_path:        str,
    abandoned_days: int = 1,
    trial_days:     int = 7,
) -> dict:
    """Sweep the users table for stale guest accounts.

    Two categories deleted:

      1. **Zero-scan abandoned guests** older than `abandoned_days`.
         Visitors who hit `/` once, never scanned, never came back.
         Default 1 day grace so "I'll try again tonight" users aren't
         hit.

      2. **Low-engagement guests (<2 scans)** older than `trial_days`.
         Tried the app, didn't stick. Default 7 days lets a casual
         "tried it last weekend, want to come back this weekend"
         user keep their session.

    Both deletes hard-filter on `role = 'guest'`. Upgraded accounts
    (role='user' or 'admin') are NEVER touched, even if their
    created_at is ancient — the role check is the safety boundary.

    The deletes cascade through every users-referencing FK except
    `scans.user_id`, which uses ON DELETE SET NULL — the AI training
    log survives the user-row removal as orphan rows. Sessions,
    entries, water_log, user_settings, consent_log, and email_tokens
    all CASCADE away with the user.

    Returns `{deleted_zero_scan, deleted_low_scan}` for logging. Both
    counts are 0 on a freshly-clean DB.
    """
    if abandoned_days < 0 or trial_days < 0:
        raise ValueError("cleanup day windows must be non-negative")

    # SQLite's datetime() modifier syntax doesn't accept parameter
    # binding for the literal '-N days' form, so we interpolate the
    # int directly. Inputs come from config.py env-validated ints, so
    # there's no SQL-injection surface — but we still cast through
    # int() defensively.
    abandoned_days = int(abandoned_days)
    trial_days     = int(trial_days)

    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")

        # Zero-scan guests — most common cleanup target. The subquery
        # finds guest user_ids whose JOIN against scans yields zero
        # rows; LEFT JOIN keeps guests with no scans, COUNT(scan_id)
        # is 0 for them (NULL collapses to 0 in COUNT).
        cur = await db.execute(
            f"""
            DELETE FROM users
            WHERE role = 'guest'
              AND created_at <= datetime('now', '-{abandoned_days} days')
              AND id IN (
                SELECT u.id FROM users u
                LEFT JOIN scans s ON s.user_id = u.id
                WHERE u.role = 'guest'
                GROUP BY u.id
                HAVING COUNT(s.scan_id) = 0
              )
            """
        )
        deleted_zero = cur.rowcount or 0

        # Low-engagement guests (<2 scans). Same shape, looser
        # threshold, longer cutoff. Catches the "1 scan and bounced"
        # cohort that the zero-scan rule misses.
        cur = await db.execute(
            f"""
            DELETE FROM users
            WHERE role = 'guest'
              AND created_at <= datetime('now', '-{trial_days} days')
              AND id IN (
                SELECT u.id FROM users u
                LEFT JOIN scans s ON s.user_id = u.id
                WHERE u.role = 'guest'
                GROUP BY u.id
                HAVING COUNT(s.scan_id) < 2
              )
            """
        )
        deleted_low = cur.rowcount or 0

        await db.commit()

    return {
        "deleted_zero_scan": deleted_zero,
        "deleted_low_scan":  deleted_low,
    }
