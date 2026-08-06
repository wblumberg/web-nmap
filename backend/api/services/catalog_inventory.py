"""Short-lived, request-coalescing cache for source inventory scans."""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime
from typing import Any

DEFAULT_TTL_SECONDS = float(os.getenv("WEBNMAP_CATALOG_CACHE_SECONDS", "30"))

_cache: dict[tuple[Any, ...], tuple[float, tuple[Any, ...]]] = {}
_inflight: dict[tuple[Any, ...], asyncio.Task] = {}
_lock = asyncio.Lock()


def _cache_key(
    source: Any,
    after: datetime | None,
    before: datetime | None,
    limit: int,
    params: dict[str, Any] | None,
) -> tuple[Any, ...]:
    """Build a stable key for an inventory cache entry."""
    frozen_params = json.dumps(
        params or {}, sort_keys=True, separators=(",", ":"), default=str
    )
    return (
        source.source_id,
        after.isoformat() if after else None,
        before.isoformat() if before else None,
        limit,
        frozen_params,
    )


async def list_times_cached(
    source: Any,
    *,
    after: datetime | None = None,
    before: datetime | None = None,
    limit: int = 200,
    params: dict[str, Any] | None = None,
    refresh: bool = False,
) -> list[Any]:
    """Return a cached inventory and coalesce identical concurrent scans.

    A tuple is stored internally so callers cannot mutate the cached collection.
    The contained ``AvailableTime`` records are treated as immutable throughout
    the catalog code.
    """
    key = _cache_key(source, after, before, limit, params)
    now = time.monotonic()

    async with _lock:
        cached = _cache.get(key)
        if not refresh and cached is not None and cached[0] > now:
            return list(cached[1])

        task = _inflight.get(key)
        creator = task is None
        if task is None:
            task = asyncio.create_task(
                source.list_times(
                    after=after, before=before, limit=limit, params=params
                )
            )
            _inflight[key] = task

    try:
        result = await asyncio.shield(task)
    except BaseException:
        if creator:
            async with _lock:
                _inflight.pop(key, None)
        raise

    if creator:
        async with _lock:
            _cache[key] = (
                time.monotonic() + max(0.0, DEFAULT_TTL_SECONDS),
                tuple(result),
            )
            _inflight.pop(key, None)
    return list(result)


async def most_recent_cached(
    source: Any, *, params: dict[str, Any] | None = None
) -> Any | None:
    """Return the most recent cached inventory entry for a source."""
    times = await list_times_cached(source, limit=1, params=params)
    return times[0] if times else None


async def clear_catalog_inventory_cache(source_id: str | None = None) -> None:
    """Clear all cached scans, or only scans belonging to one source."""
    async with _lock:
        if source_id is None:
            _cache.clear()
            return
        for key in [key for key in _cache if key[0] == source_id]:
            _cache.pop(key, None)
