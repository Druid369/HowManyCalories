"""Transactional email — Unisender Go REST API.

One public function: `send_email()`. Two transports behind it:

  - "log"  — dev default. Logs the email payload to stderr instead of
             sending. Lets the auth flows be tested end-to-end without
             real network or burning provider quota.
  - "api"  — production. POSTs to Unisender Go's transactional endpoint.

The transport is selected by the EMAIL_TRANSPORT env var (read from
config.py at import time, so changing it requires a restart — same as
every other env in this codebase). The API key is read from
UNISENDER_API_KEY and never appears in logs, error messages, or
exception traces. If the key is missing in api mode the call fails
fast with a logged error rather than hitting the API with an empty key.

This module is intentionally thin: it knows how to format the request
and handle retries, nothing else. Templates (HTML + plain text bodies)
live in `_email_templates.py`. Token generation lives in
`_email_tokens.py`. Endpoints orchestrate the three.
"""

import httpx

from server.config import (
    EMAIL_TRANSPORT, UNISENDER_API_KEY, UNISENDER_API_ENDPOINT,
    UNISENDER_FROM_EMAIL, UNISENDER_FROM_NAME,
)
from server.logging_config import get_logger

logger = get_logger(__name__)


async def send_email(
    to:      str,
    subject: str,
    html:    str,
    text:    str,
) -> bool:
    """Send a transactional email. Returns True on success, False on
    any failure (no exceptions propagated — caller decides whether a
    failed send should be user-visible).

    `to`      — single recipient email address
    `subject` — short line, no transformation
    `html`    — full HTML body (caller assembles from template)
    `text`    — plain-text alternative (REQUIRED for deliverability —
                anti-spam scoring penalises HTML-only mail)
    """
    if not to or "@" not in to:
        logger.error("email_send_invalid_recipient", extra={"to_present": bool(to)})
        return False

    if EMAIL_TRANSPORT == "log":
        return _send_log(to, subject, html, text)
    if EMAIL_TRANSPORT == "api":
        return await _send_api(to, subject, html, text)

    logger.error("email_send_unknown_transport", extra={"transport": EMAIL_TRANSPORT})
    return False


# ── log transport ─────────────────────────────────────────────────────────


def _send_log(to: str, subject: str, html: str, text: str) -> bool:
    """Dev transport — write the email payload to logs, no network call.
    The text body is truncated to 400 chars in the log line so a 50-line
    welcome email doesn't blow up log volume; the full body is still
    available via the `text_full_bytes` field for sanity-checking
    template length."""
    text_preview = (text or "").strip()
    truncated = len(text_preview) > 400
    if truncated:
        text_preview = text_preview[:400] + "…"
    logger.info("email_send_log", extra={
        "to":              to,
        "subject":         subject,
        "from":            f"{UNISENDER_FROM_NAME} <{UNISENDER_FROM_EMAIL}>",
        "text_preview":    text_preview,
        "text_full_bytes": len(text or ""),
        "html_bytes":      len(html or ""),
        "transport":       "log",
    })
    return True


# ── api transport ─────────────────────────────────────────────────────────


# One retry on transient (network / 5xx) errors. Stays well under the
# 5-second budget the calling endpoints typically have.
_REQUEST_TIMEOUT_SEC = 8.0
_MAX_ATTEMPTS = 2


async def _send_api(to: str, subject: str, html: str, text: str) -> bool:
    """Real send — POST to Unisender Go's transactional email endpoint.

    Request shape per Unisender Go docs:
        POST https://go1.unisender.ru/ru/transactional/api/v1/email/send.json
        Headers:
            X-API-KEY: <key>
            Content-Type: application/json
        Body:
            { "message": {
                "recipients":  [{"email": "..."}],
                "body":        {"html": "...", "plaintext": "..."},
                "subject":     "...",
                "from_email":  "noreply@myfork.ru",
                "from_name":   "FORK"
            }}

    Response 200 ⇒ accepted. Anything else ⇒ failure. We do NOT log the
    response body — Unisender sometimes echoes parts of the auth header
    on error and we never want a key fragment in our logs."""
    if not UNISENDER_API_KEY:
        logger.error("email_send_no_api_key", extra={
            "transport": "api",
            "hint":      "set UNISENDER_API_KEY env var, or use EMAIL_TRANSPORT=log",
        })
        return False

    payload = {
        "message": {
            "recipients": [{"email": to}],
            "body":       {"html": html, "plaintext": text},
            "subject":    subject,
            "from_email": UNISENDER_FROM_EMAIL,
            "from_name":  UNISENDER_FROM_NAME,
        }
    }
    headers = {
        "X-API-KEY":    UNISENDER_API_KEY,
        "Content-Type": "application/json",
    }

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT_SEC) as client:
                resp = await client.post(
                    UNISENDER_API_ENDPOINT,
                    json=payload,
                    headers=headers,
                )
        except httpx.RequestError as e:
            # Network-level error — DNS failure, connection refused,
            # timeout. Worth one retry; second failure is logged and
            # surfaced to the caller.
            if attempt < _MAX_ATTEMPTS:
                logger.warning("email_send_retry_network", extra={
                    "attempt": attempt, "error": str(e)[:200],
                })
                continue
            logger.error("email_send_network_error", extra={
                "attempts": attempt, "error": str(e)[:200],
            })
            return False

        # Don't include resp.text or resp.headers in logs — both can
        # contain echoed-back auth fragments on some 4xx responses.
        if resp.status_code == 200:
            logger.info("email_send_api_ok", extra={
                "to":      to,
                "subject": subject,
                "attempt": attempt,
            })
            return True

        if resp.status_code >= 500 and attempt < _MAX_ATTEMPTS:
            logger.warning("email_send_retry_5xx", extra={
                "attempt": attempt, "status": resp.status_code,
            })
            continue

        logger.error("email_send_failed", extra={
            "to":       to,
            "status":   resp.status_code,
            "attempts": attempt,
        })
        return False

    return False
