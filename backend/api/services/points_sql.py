"""Async query service for the `points` TimescaleDB hypertable.

Returns rows as plain dicts ready for protobuf or GeoJSON serialization.
All spatial filtering is pushed down to PostGIS.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import text

from ..db.engine import get_engine

# Maximum rows returned in a single request (protobuf blobs grow fast)
_DEFAULT_LIMIT = 100_000
_HARD_LIMIT    = 500_000


async def query_points(
    source_id: str,
    start: datetime,
    end: datetime,
    bbox: Optional[tuple[float, float, float, float]] = None,
    limit: int = _DEFAULT_LIMIT,
) -> list[dict]:
    """Query the `points` hypertable and return a list of dicts.

    Each dict has keys:
        lat, lon, valid_time (datetime), properties (dict)

    Args:
        source_id: Matches the ``source_id`` column (e.g. "LIGHTNING", "AIRNOW").
        start:     Inclusive start of the valid_time window (timezone-aware).
        end:       Inclusive end of the valid_time window (timezone-aware).
        bbox:      Optional spatial filter (lon_min, lat_min, lon_max, lat_max).
        limit:     Maximum rows to return.
    """
    limit = min(limit, _HARD_LIMIT)

    # Ensure timezone-aware datetimes for asyncpg
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    bbox_clause = ""
    params: dict = {
        "source_id": source_id,
        "start": start,
        "end": end,
        "limit": limit,
    }

    if bbox is not None:
        lon_min, lat_min, lon_max, lat_max = bbox
        bbox_clause = (
            "AND ST_Within(geom, ST_MakeEnvelope(:lon_min, :lat_min, :lon_max, :lat_max, 4326))"
        )
        params.update(lon_min=lon_min, lat_min=lat_min, lon_max=lon_max, lat_max=lat_max)

    sql = text(f"""
        SELECT
            ST_Y(geom)   AS lat,
            ST_X(geom)   AS lon,
            valid_time,
            properties
        FROM points
        WHERE source_id = :source_id
          AND valid_time BETWEEN :start AND :end
          {bbox_clause}
        ORDER BY valid_time DESC
        LIMIT :limit
    """)

    engine = get_engine()
    async with engine.connect() as conn:
        res = await conn.execute(sql, params)
        rows = res.fetchall()

    result = []
    for row in rows:
        lat, lon, valid_time, props = row[0], row[1], row[2], row[3]
        if isinstance(props, str):
            import json
            props = json.loads(props)
        result.append({
            "lat": float(lat),
            "lon": float(lon),
            "valid_time": valid_time,
            "properties": props or {},
        })
    return result


async def list_source_times(
    source_id: str,
    limit: int = 200,
) -> list[datetime]:
    """Return distinct valid_times for a source, newest first."""
    sql = text("""
        SELECT DISTINCT valid_time
        FROM points
        WHERE source_id = :source_id
        ORDER BY valid_time DESC
        LIMIT :limit
    """)
    engine = get_engine()
    async with engine.connect() as conn:
        res = await conn.execute(sql, {"source_id": source_id, "limit": limit})
        rows = res.fetchall()
    return [r[0] for r in rows]


async def most_recent_time(source_id: str) -> Optional[datetime]:
    """Return the most recent valid_time for a source, or None if empty."""
    sql = text("""
        SELECT MAX(valid_time) FROM points WHERE source_id = :source_id
    """)
    engine = get_engine()
    async with engine.connect() as conn:
        result = await conn.scalar(sql, {"source_id": source_id})
    return result
