"""Concurrent, cached health checks for every registered dataset."""
from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Any

from ..metrics import (
    DATASET_AGE,
    DATASET_AVAILABLE,
    DATASET_CHECK_DURATION,
    DATASET_HEALTH,
    DATASET_LATEST_TIMESTAMP,
)
from ..sources.registry import SOURCES

DEFAULT_TIMEOUT_SECONDS = float(os.getenv("WEBNMAP_STATUS_TIMEOUT_SECONDS", "5"))
DEFAULT_CACHE_SECONDS = float(os.getenv("WEBNMAP_STATUS_CACHE_SECONDS", "30"))
DEFAULT_OBSERVATION_MAX_AGE_MINUTES = int(
    os.getenv("WEBNMAP_STATUS_OBS_MAX_AGE_MINUTES", "180")
)
DEFAULT_FORECAST_MAX_AGE_MINUTES = int(
    os.getenv("WEBNMAP_STATUS_FORECAST_MAX_AGE_MINUTES", "720")
)

_cache: dict[str, Any] | None = None
_cache_monotonic = 0.0
_refresh_lock = asyncio.Lock()


def _max_age_minutes(source: Any) -> int:
    configured = getattr(source, "status_max_age_minutes", None)
    if configured is not None:
        return int(configured)
    if getattr(source, "cycle_regex", None) is not None:
        return DEFAULT_FORECAST_MAX_AGE_MINUTES
    return DEFAULT_OBSERVATION_MAX_AGE_MINUTES


def _metric_labels(source: Any) -> dict[str, str]:
    return {
        "source_id": source.source_id,
        "label": source.label,
        "data_category": getattr(source, "data_category", "unknown"),
    }


async def _check_source(source: Any, now: datetime) -> dict[str, Any]:
    started = time.perf_counter()
    max_age = _max_age_minutes(source)
    labels = _metric_labels(source)
    result: dict[str, Any] = {
        **labels,
        "source_type": getattr(source, "source_type", "unknown"),
        "source_group": getattr(source, "source_group", source.source_id),
        "status": "unavailable",
        "latest_time": None,
        "latest_cycle": None,
        "age_minutes": None,
        "expected_max_age_minutes": max_age,
        "response_ms": None,
        "message": None,
    }

    try:
        if getattr(source, "cycle_regex", None) is not None:
            inventory = await asyncio.wait_for(
                source.list_times(limit=500), timeout=DEFAULT_TIMEOUT_SECONDS
            )
            cycle_items = [item for item in inventory if item.cycle is not None]
            latest = max(cycle_items, key=lambda item: item.cycle) if cycle_items else None
        else:
            latest = await asyncio.wait_for(
                source.most_recent(), timeout=DEFAULT_TIMEOUT_SECONDS
            )
        if latest is None:
            result["status"] = "empty"
            result["message"] = "Inventory check succeeded, but no data was found."
        else:
            # Forecast valid times can be in the future. The production cycle is
            # the correct signal for whether ingest is still operating.
            valid_time = _as_utc_datetime(latest.valid_time, "valid_time")
            cycle_time = (
                _as_utc_datetime(latest.cycle, "cycle")
                if latest.cycle is not None
                else None
            )
            freshness_time = cycle_time or valid_time
            age_seconds = max(0.0, (now - freshness_time).total_seconds())
            result["latest_time"] = _iso_utc(valid_time)
            result["latest_cycle"] = (
                _iso_utc(cycle_time)
                if cycle_time else None
            )
            result["age_minutes"] = round(age_seconds / 60, 1)
            result["status"] = (
                "healthy" if age_seconds <= max_age * 60 else "stale"
            )
            DATASET_LATEST_TIMESTAMP.labels(**labels).set(freshness_time.timestamp())
            DATASET_AGE.labels(**labels).set(age_seconds)
    except asyncio.TimeoutError:
        result["message"] = f"Inventory check timed out after {DEFAULT_TIMEOUT_SECONDS:g}s."
    except Exception as exc:  # A failed source must not hide all other statuses.
        result["message"] = f"{type(exc).__name__}: {exc}"

    duration = time.perf_counter() - started
    result["response_ms"] = round(duration * 1000, 1)
    health = {"healthy": 1.0, "stale": 0.5}.get(result["status"], 0.0)
    available = 1.0 if result["status"] in {"healthy", "stale"} else 0.0
    DATASET_HEALTH.labels(**labels).set(health)
    DATASET_AVAILABLE.labels(**labels).set(available)
    DATASET_CHECK_DURATION.labels(**labels).set(duration)
    return result


def _as_utc_datetime(value: Any, field_name: str = "timestamp") -> datetime:
    """Normalize source timestamps at the health-check boundary.

    ``AvailableTime`` declares datetime fields, but legacy filesystem forecast
    sources return compact cycle strings. Accept the formats used by the source
    registry so one legacy source cannot fail the whole status calculation.
    """
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        raw = value.strip()
        if not raw:
            raise ValueError(f"{field_name} is empty")
        parsed = None
        # Parse known compact catalog formats first. ``fromisoformat`` accepts
        # some separator-free strings but can interpret them unexpectedly.
        compact_formats = {
            10: "%Y%m%d%H",
            12: "%Y%m%d%H%M",
            14: "%Y%m%d%H%M%S",
        }
        if raw.isdigit() and len(raw) in compact_formats:
            parsed = datetime.strptime(raw, compact_formats[len(raw)])
        elif len(raw) == 13 and raw[8] == "_":
            parsed = datetime.strptime(raw, "%Y%m%d_%H%M")
        if parsed is None:
            iso_value = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
            try:
                parsed = datetime.fromisoformat(iso_value)
            except ValueError:
                pass
        if parsed is None:
            raise ValueError(
                f"{field_name} has unsupported datetime value {value!r}"
            )
    else:
        raise TypeError(
            f"{field_name} must be a datetime or string, got {type(value).__name__}"
        )

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _iso_utc(value: datetime) -> str:
    value = _as_utc_datetime(value)
    return value.isoformat().replace("+00:00", "Z")


async def get_dataset_status(force: bool = False) -> dict[str, Any]:
    """Return a cached snapshot, refreshing every source concurrently."""
    global _cache, _cache_monotonic
    if not force and _cache and time.monotonic() - _cache_monotonic < DEFAULT_CACHE_SECONDS:
        return _cache

    async with _refresh_lock:
        if not force and _cache and time.monotonic() - _cache_monotonic < DEFAULT_CACHE_SECONDS:
            return _cache
        now = datetime.now(timezone.utc)
        sources = await asyncio.gather(
            *(_check_source(source, now) for source in SOURCES.values())
        )
        order = {"unavailable": 0, "empty": 1, "stale": 2, "healthy": 3}
        sources.sort(key=lambda item: (order[item["status"]], item["label"].lower()))
        counts = {name: 0 for name in ("healthy", "stale", "empty", "unavailable")}
        for item in sources:
            counts[item["status"]] += 1
        _cache = {
            "checked_at": now.isoformat().replace("+00:00", "Z"),
            "summary": {**counts, "total": len(sources)},
            "sources": sources,
        }
        _cache_monotonic = time.monotonic()
        return _cache


async def status_refresh_loop(interval_seconds: float = 60) -> None:
    """Keep gauges current even when nobody has the status panel open."""
    while True:
        try:
            await get_dataset_status(force=True)
        except Exception as exc:
            print(f"[dataset-status] refresh failed: {exc}")
        await asyncio.sleep(interval_seconds)
