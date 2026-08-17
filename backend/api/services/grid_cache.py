"""
services/grid_cache.py — In-memory LRU cache for serialized gridded responses.

Caches serialized protobuf bytes keyed by (source_id, key, variables, level,
precision).  This avoids re-reading Zarr data and re-serializing protobuf on
repeat requests (e.g. multiple users viewing the same cycle, or frame looping).

The cache tracks total byte size and evicts the oldest entries when the
configured maximum is exceeded.

─── Bypass ──────────────────────────────────────────────────────────────────
Pass ``?nocache=1`` or ``Cache-Control: no-cache`` on the HTTP request to
skip both reading from and writing to the cache.  Useful for benchmarking.

─── Metrics ─────────────────────────────────────────────────────────────────
Two Prometheus counters are exported:  grid_cache_hits_total  and
grid_cache_misses_total.  Use these to monitor cache effectiveness.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

from ..metrics import REGISTRY
from prometheus_client import Counter

# ── Prometheus counters ────────────────────────────────────────────────────────
CACHE_HITS = Counter(
    "grid_cache_hits_total",
    "Number of grid cache hits.",
)
CACHE_MISSES = Counter(
    "grid_cache_misses_total",
    "Number of grid cache misses.",
)

# Default maximum cache size: 512 MiB
_DEFAULT_MAX_BYTES = 512 * 1024 * 1024
# Default TTL: 1 hour (seconds)
_DEFAULT_TTL_S = 3600


class GridCache:
    """
    Thread-safe, byte-size-bounded LRU cache for serialized grid payloads.

    Keys are arbitrary hashable tuples.  Values are ``bytes`` objects
    (typically serialised protobuf ``GridResponse`` messages).
    """

    def __init__(self, max_bytes: int = _DEFAULT_MAX_BYTES):
        """Initialize the instance."""
        self._max_bytes = max_bytes
        self._lock = threading.Lock()
        self._store: OrderedDict[Any, bytes] = OrderedDict()
        self._total_bytes = 0

    # ── Public API ────────────────────────────────────────────────────────

    def get(self, key) -> bytes | None:
        """Return cached bytes for *key*, or ``None`` on a miss."""
        with self._lock:
            if key in self._store:
                # Move to end (most recently used)
                self._store.move_to_end(key)
                CACHE_HITS.inc()
                return self._store[key]
            CACHE_MISSES.inc()
            return None

    def put(self, key, value: bytes) -> None:
        """Insert *value* into the cache, evicting old entries if needed."""
        size = len(value)
        if size > self._max_bytes:
            # Single entry larger than cache — skip silently
            return

        with self._lock:
            # If key already present, remove old entry first
            if key in self._store:
                self._total_bytes -= len(self._store.pop(key))

            # Evict oldest entries until there is room
            while self._total_bytes + size > self._max_bytes and self._store:
                _, evicted = self._store.popitem(last=False)
                self._total_bytes -= len(evicted)

            self._store[key] = value
            self._total_bytes += size

    def clear(self) -> None:
        """Drop all cached entries."""
        with self._lock:
            self._store.clear()
            self._total_bytes = 0

    @property
    def current_bytes(self) -> int:
        """Return the number of bytes currently held by the cache."""
        return self._total_bytes

    @property
    def entry_count(self) -> int:
        """Return the number of entries currently held by the cache."""
        return len(self._store)

    @property
    def max_bytes(self) -> int:
        """Return the configured byte limit."""
        return self._max_bytes

    def __repr__(self) -> str:
        """Return a diagnostic string representation of the instance."""
        return (
            f"GridCache(entries={self.entry_count}, "
            f"bytes={self._total_bytes:,}/{self._max_bytes:,})"
        )


# ── Module-level singleton ─────────────────────────────────────────────────────
grid_cache = GridCache()
