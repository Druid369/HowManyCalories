"""Tiny in-memory TTL cache with bounded size and oldest-first eviction.

Used by the USDA and OpenFoodFacts clients. Generic over the value type; just
construct one per backend so cache keys never collide across services.
"""

import time
from typing import Generic, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    def __init__(self, ttl_seconds: int = 3600, max_size: int = 200) -> None:
        self._ttl = ttl_seconds
        self._max = max_size
        self._store: dict[str, tuple[float, T]] = {}

    def get(self, key: str) -> T | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        ts, value = entry
        if time.time() - ts >= self._ttl:
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: T) -> None:
        if len(self._store) >= self._max and key not in self._store:
            oldest = min(self._store, key=lambda k: self._store[k][0])
            del self._store[oldest]
        self._store[key] = (time.time(), value)
