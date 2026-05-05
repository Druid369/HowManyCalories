"""Email token lifecycle — generate and consume.

Wraps the DB-layer helpers in `database.py` with the cryptographic
parts: raw token generation, SHA-256 hashing, expiry math, kind-based
TTL selection.

Security model:
  - Raw token = 32 bytes from secrets.token_urlsafe (~256 bits of entropy).
    Lives only in transit (the URL we email out) and in the user's inbox.
  - DB stores SHA-256 hash of the raw token. A DB leak doesn't expose
    live links — an attacker would need to brute-force SHA-256 over
    256-bit space to find a matching raw token, which is intractable.
  - Lookup hashes the incoming raw token and queries by hash equality.
    SQLite's = comparison is sufficient here: the DB rows are already
    hashed (uniform length) and an attacker probing for tokens via
    timing the DB layer is far less efficient than just guessing the
    token bytes (which they can't do anyway given the entropy).
  - Mark used BEFORE the calling endpoint takes its action. Trade-off:
    if the action fails, the user re-requests; in exchange we never
    allow replay of a partially-completed flow.
  - Reissuing a token of the same kind invalidates the prior outstanding
    one, so an attacker can't accumulate multiple valid links from
    repeated user requests.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from server.config import EMAIL_CONFIRM_TOKEN_TTL_SEC, EMAIL_RESET_TOKEN_TTL_SEC
from server.database import (
    find_email_token, insert_email_token, invalidate_user_email_tokens,
    mark_email_token_used,
)
from server.logging_config import get_logger

logger = get_logger(__name__)


# 32 bytes = 256 bits of entropy = ~43 URL-safe base64 chars after
# encoding. Plenty for a one-time link.
_TOKEN_BYTES = 32

# TTL lookup keyed by kind. Adding a new kind is a one-line change here
# plus updating the DB CHECK constraint (currently free-form TEXT, so
# no DB change needed in this codebase).
_TTL_BY_KIND = {
    "confirm": EMAIL_CONFIRM_TOKEN_TTL_SEC,
    "reset":   EMAIL_RESET_TOKEN_TTL_SEC,
}


def _hash_token(raw: str) -> str:
    """SHA-256 hex digest. Stable, deterministic, one-way."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def generate_email_token(
    db_path: str,
    user_id: int,
    kind:    str,
    email:   str,
) -> str:
    """Generate + persist a fresh token. Returns the **raw** token
    (the part that goes into the email URL); only its SHA-256 hash
    lands in the DB.

    Side effect: any prior unused tokens of the same kind for this
    user are marked used (invalidated). This prevents an attacker who
    triggered N repeated reset requests from accumulating N valid links
    — the most recent request always wins.
    """
    if kind not in _TTL_BY_KIND:
        raise ValueError(f"Unknown token kind: {kind!r}")

    invalidated = await invalidate_user_email_tokens(db_path, user_id, kind)
    if invalidated:
        # Not a security event per se (legitimate re-requests trigger
        # this), but useful signal for spotting brute-force-attempt
        # patterns in the logs.
        logger.info("email_token_reissue_invalidated", extra={
            "user_id": user_id, "kind": kind, "count": invalidated,
        })

    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    token_hash = _hash_token(raw)
    expires_at = (
        datetime.now(timezone.utc)
        + timedelta(seconds=_TTL_BY_KIND[kind])
    ).isoformat()

    await insert_email_token(
        db_path, token_hash, user_id, kind, email, expires_at,
    )
    logger.info("email_token_generated", extra={
        "user_id": user_id, "kind": kind,
        "ttl_seconds": _TTL_BY_KIND[kind],
        # Never log the raw token or its hash — both could be used for
        # replay if the log were leaked. user_id + kind + ttl is enough
        # for ops triage.
    })
    return raw


async def consume_email_token(
    db_path:   str,
    raw_token: str,
    kind:      str,
) -> dict | None:
    """Validate + atomically consume a token. Returns the token row
    `{token_hash, user_id, kind, email, created_at, expires_at, used}`
    on success, **None** for every failure mode (missing, wrong kind,
    expired, already used, malformed input).

    Failure modes return the same None on purpose — the caller MUST
    NOT distinguish, so error responses don't leak which case applied.
    A 410 ("link expired or invalid") is the canonical surfaced error.

    The token is marked `used = 1` BEFORE this function returns, so
    even if the caller's downstream action fails, the same token can't
    be replayed. Cost: a downstream failure forces the user to
    re-request. Acceptable.
    """
    if not raw_token or kind not in _TTL_BY_KIND:
        return None

    token_hash = _hash_token(raw_token)
    row = await find_email_token(db_path, token_hash, kind)
    if not row:
        return None

    await mark_email_token_used(db_path, token_hash)
    logger.info("email_token_consumed", extra={
        "user_id": row["user_id"], "kind": kind,
    })
    return row
