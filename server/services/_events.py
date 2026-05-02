"""Per-request SSE event emitter, ContextVar-bound.

Pipeline code calls `await emit(event, data)` from anywhere down the
call tree. If the current ContextVar has an emitter bound (set by the
/api/analyze/stream endpoint via bind_emitter), the call forwards.
Otherwise it's a free no-op — which is what the legacy /api/analyze
handler relies on so the same pipeline functions can serve both
streaming and non-streaming callers without a parameter explosion.

ContextVar propagation: asyncio.create_task captures the current
context at task-creation time. The endpoint binds the emitter BEFORE
launching the pipeline task, so all child awaits (Sonnet call, Opus
call, asyncio.gather over enrich_item) inherit the binding. Tasks
created in parallel (asyncio.gather inside _pipeline_stages_2_and_3)
all share the same ContextVar value.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from typing import Awaitable, Callable

# (event_name, data_dict) → Awaitable[None]. The dict must be JSON-
# serialisable; the endpoint serialises before writing to the SSE wire.
EmitFn = Callable[[str, dict], Awaitable[None]]

_EMITTER: ContextVar[EmitFn | None] = ContextVar(
    "fork_event_emitter", default=None,
)


async def emit(event: str, data: dict) -> None:
    """Emit an SSE event if an emitter is bound for this request, else no-op.

    Pipeline code uses this freely. Errors raised by the underlying
    emitter (e.g. queue.put on a closed queue) are swallowed here so a
    transport-side failure can't crash the pipeline. The endpoint is
    responsible for surfacing transport errors via its own logging.
    """
    fn = _EMITTER.get()
    if fn is None:
        return
    try:
        await fn(event, data)
    except Exception:
        pass


def bind_emitter(fn: EmitFn) -> Token:
    """Bind `fn` as the active emitter for the current ContextVar context.

    Returns a Token to pass to unbind_emitter for cleanup.
    """
    return _EMITTER.set(fn)


def unbind_emitter(token: Token) -> None:
    _EMITTER.reset(token)
