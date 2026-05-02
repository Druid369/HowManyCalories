"""Structured JSON logging for HowManyCalories.

Every log line is a JSON object written to stdout, which Railway captures.
A ContextVar threads the request_id through async call stacks without
explicit parameter passing.

Usage:
    from server.logging_config import get_logger
    logger = get_logger(__name__)
    logger.info("stage1_complete", extra={"items": 3, "duration_ms": 1200})
"""

import json
import logging
import sys
import time
from contextvars import ContextVar

_request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_SKIP_FIELDS = frozenset({
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "message", "taskName",
})


class _JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data: dict = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname,
            "request_id": _request_id_var.get(),
            "event": record.getMessage(),
        }
        for key, val in record.__dict__.items():
            if key not in _SKIP_FIELDS:
                data[key] = val
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data, ensure_ascii=False, default=str)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_JSONFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    for noisy in ("uvicorn.access", "httpx", "httpcore", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def set_request_id(rid: str) -> None:
    _request_id_var.set(rid)


def get_request_id() -> str:
    return _request_id_var.get()
