"""Async query service for profile-style observations in the `profiles` hypertable.

A profile observation is a single point/time with vertical arrays encoded in
JSONB (for example VAD wind profile levels).
"""
from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Optional

from sqlalchemy import text

from ..db.engine import get_engine

_DEFAULT_LIMIT = 50_000
_HARD_LIMIT = 200_000


async def query_profiles(
    source_id: str,
    start: datetime,
    end: datetime,
    bbox: Optional[tuple[float, float, float, float]] = None,
    limit: int = _DEFAULT_LIMIT,
    most_recent_only: bool = False,
    most_recent_by: str = "station_id",
) -> list[dict]:
    """Return profile rows for a source/time window as JSON-ready dicts.
    
    If most_recent_only=True, returns only the most recent profile per station_id.
    """
    limit = min(limit, _HARD_LIMIT)

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

    if most_recent_only:
        # Guard identifier interpolation used by DISTINCT ON / ORDER BY.
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", most_recent_by):
            raise ValueError(f"Invalid most_recent_by column: {most_recent_by!r}")

        # Use DISTINCT ON to return only the most recent profile per station_id
        sql = text(f"""
            SELECT DISTINCT ON ({most_recent_by})
                station_id,
                valid_time,
                ST_Y(geom) AS lat,
                ST_X(geom) AS lon,
                profile,
                metadata
            FROM profiles
            WHERE source_id = :source_id
              AND valid_time BETWEEN :start AND :end
              {bbox_clause}
            ORDER BY {most_recent_by}, valid_time DESC
            LIMIT :limit
        """)
    else:
        sql = text(f"""
            SELECT
                station_id,
                valid_time,
                ST_Y(geom) AS lat,
                ST_X(geom) AS lon,
                profile,
                metadata
            FROM profiles
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
        result.append({
            "station_id": row[0],
            "valid_time": row[1],
            "lat": float(row[2]),
            "lon": float(row[3]),
            "profile": row[4] or {},
            "metadata": row[5] or {},
        })
    return result


async def most_recent_time(source_id: str) -> Optional[datetime]:
    """Return latest valid_time for one profile source."""
    sql = text("""
        SELECT MAX(valid_time)
        FROM profiles
        WHERE source_id = :source_id
    """)
    engine = get_engine()
    async with engine.connect() as conn:
        return await conn.scalar(sql, {"source_id": source_id})
