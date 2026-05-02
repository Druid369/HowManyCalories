"""Shared httpx.AsyncClient with HTTP keep-alive across service calls.

Reusing one client lets the underlying TCP connection (and TLS handshake) be
reused between USDA / OpenFoodFacts requests, saving ~50-150ms per call after
the first.

Lifecycle: opened on FastAPI startup, closed on shutdown — see main.lifespan.
"""

import httpx

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    if _client is None:
        raise RuntimeError("http client not initialized — did lifespan run?")
    return _client


async def open_client() -> None:
    global _client
    if _client is None:
        limits = httpx.Limits(max_connections=20, max_keepalive_connections=10)
        _client = httpx.AsyncClient(timeout=8.0, limits=limits)


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
