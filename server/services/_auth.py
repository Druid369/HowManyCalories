"""Auth primitives: password hashing, session id generation, validation.

Stateless utilities — all DB-touching auth logic lives in `database.py`
(get_user_by_username, create_session, etc.). This module is the
"crypto + rules" layer.

Why direct bcrypt (not passlib): passlib 1.7.4 uses a version-detection
API that bcrypt 4.1+ removed, so passlib's bcrypt backend silently
breaks against modern bcrypt installs. We only ever need bcrypt — no
multi-scheme support — so the passlib wrapper costs more than it gives.
Using `bcrypt` directly is ~10 lines and bug-free against current and
future bcrypt versions.
"""

import re
import secrets
from typing import Final

import bcrypt

# bcrypt rounds: 12 = ~250ms hash cost on commodity hardware. The login
# rate limit (5/min/IP) prevents this being a DOS vector while still
# making offline cracking expensive if the DB is ever exfiltrated.
_BCRYPT_ROUNDS: Final = 12


def hash_password(plain: str) -> str:
    """Returns a UTF-8 bcrypt hash string (60 chars, format `$2b$12$...`)."""
    salt = bcrypt.gensalt(rounds=_BCRYPT_ROUNDS)
    return bcrypt.hashpw(plain.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Constant-time bcrypt compare. Returns False on malformed hash
    (rather than raising) so a corrupted DB row surfaces as a normal
    401, not a 500."""
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# Username rules (per user spec):
#   - letters (A-Z, a-z) and digits (0-9) only
#   - 1 to 32 characters
#   - case-insensitive uniqueness (enforced by COLLATE NOCASE on the column)
# Reserved usernames are seeded by the system; users cannot register them.
_USERNAME_REGEX: Final = re.compile(r"^[A-Za-z0-9]{1,32}$")
_RESERVED_USERNAMES: Final = frozenset({
    "admin", "0", "root", "superadmin", "system",
})


def validate_username(username: str) -> tuple[bool, str]:
    """Returns (is_valid, error_message). Empty error_message on success."""
    if not isinstance(username, str):
        return False, "Username must be a string"
    if not _USERNAME_REGEX.fullmatch(username):
        return False, "Username must be 1-32 letters or digits (no symbols, no spaces)"
    if username.lower() in _RESERVED_USERNAMES:
        return False, "This username is reserved"
    return True, ""


# Password rules: min 4 chars (the user's seeded `1363` is 4), max 128
# (avoid bcrypt's 72-byte truncation surprise — passlib handles it but
# we cap length for sanity). No complexity rules in v1; we rely on rate
# limiting + the user's own choice. Phase 10 polish can add a strength
# meter on the register screen.
def validate_password(password: str) -> tuple[bool, str]:
    if not isinstance(password, str):
        return False, "Password must be a string"
    if len(password) < 4:
        return False, "Password must be at least 4 characters"
    if len(password) > 128:
        return False, "Password is too long (max 128 characters)"
    return True, ""


def new_session_id() -> str:
    """256 bits of entropy, URL-safe. Output length ~43 chars."""
    return secrets.token_urlsafe(32)


# ── Guest credentials (Phase 3) ───────────────────────────────────────────
# Auto-generated for visitors who hit `/` without a session. Username is
# 8 hex chars after the prefix ('guestXXXXXXXX', 13 chars total) — fits
# the existing username regex so a guest upgrading to a real user can
# keep this name without special-casing the validator. Password is 32
# random URL-safe chars; the user never sees it (only used to satisfy
# users.password_hash NOT NULL). Upgrading rotates it to whatever the
# user chose.

def generate_guest_username(prefix: str = "guest") -> str:
    """Returns `<prefix><8 hex chars>`. 32 bits of randomness — collision
    is theoretically possible but the caller retries on UNIQUE constraint
    violation, so collisions are handled at the DB layer."""
    return prefix + secrets.token_hex(4)


def generate_guest_password() -> str:
    """Random unguessable password. Never displayed; upgrading rotates
    it to a user-chosen value. Length matches our regular max (well
    under bcrypt's 72-byte truncation point)."""
    return secrets.token_urlsafe(32)
