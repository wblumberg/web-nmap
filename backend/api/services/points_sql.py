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
    most_recent: bool = False,
    most_recent_by: str = 'geom',
    fields: Optional[list[str]] = None,
    cursor: Optional[tuple[datetime, int]] = None,
) -> list[dict]:
    """Query the `points` hypertable and return a list of dicts.

    Each dict has keys:
        lat, lon, valid_time (datetime), station_id, properties (dict)

    Args:
        source_id:      Matches the ``source_id`` column (e.g. "LIGHTNING", "AIRNOW").
        start:          Inclusive start of the valid_time window (timezone-aware).
        end:            Inclusive end of the valid_time window (timezone-aware).
        bbox:           Optional spatial filter (lon_min, lat_min, lon_max, lat_max).
        limit:          Maximum rows to return.
        most_recent:    If True, return only the most recent observation per station.
        most_recent_by: Column to deduplicate on when most_recent=True.
                        ``'station_id'`` — use for networks with stable station IDs
                        (SAO, SHIP, SYNOPTIC).  Groups by the station_id text column
                        and uses the partial index for best performance.
                        ``'geom'`` (default) — use for moving sources or sources
                        without station IDs (AIRNOW by coordinates, LIGHTNING).
        fields:         Optional list of property keys to include in each point's
                        ``properties`` dict.  When None, all properties are returned.
    """
    limit = min(limit, _HARD_LIMIT)

    # Ensure timezone-aware datetimes for asyncpg
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)

    bbox_clause = ""
    cursor_clause = ""
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

    if cursor is not None:
        cursor_time, cursor_row_id = cursor
        if cursor_time.tzinfo is None:
            cursor_time = cursor_time.replace(tzinfo=timezone.utc)
        cursor_clause = (
            "AND (valid_time, id) < (:cursor_time, :cursor_row_id)"
        )
        params.update(
            cursor_time=cursor_time,
            cursor_row_id=cursor_row_id,
        )

    if most_recent:
        if most_recent_by == 'station_id':
            # Deduplicate by station_id — correct for networks with stable station
            # identifiers (SAO, SHIP, SYNOPTIC).  Rows that lack a station_id are
            # excluded; the partial index on (source_id, station_id, valid_time DESC)
            # makes this fast.
            sql = text(f"""
                SELECT DISTINCT ON (station_id)

                    ST_Y(geom)   AS lat,
                    ST_X(geom)   AS lon,
                    valid_time,
                    station_id,
                    properties,
                    id
                FROM points
                WHERE source_id = :source_id
                  AND valid_time BETWEEN :start AND :end
                  AND station_id IS NOT NULL
                  {bbox_clause}
                  {cursor_clause}
                ORDER BY station_id, valid_time DESC
                LIMIT :limit
            """)
        else:
            # Deduplicate by geometry — for stationary networks without station IDs
            # or for moving sources where position is the identity.
            sql = text(f"""
                SELECT DISTINCT ON (geom)
                    ST_Y(geom)   AS lat,
                    ST_X(geom)   AS lon,
                    valid_time,
                    station_id,
                    properties,
                    id
                FROM points
                WHERE source_id = :source_id
                  AND valid_time BETWEEN :start AND :end
                  {bbox_clause}
                  {cursor_clause}
                ORDER BY geom, valid_time DESC
                LIMIT :limit
            """)
    else:
        sql = text(f"""
            SELECT
                ST_Y(geom)   AS lat,
                ST_X(geom)   AS lon,
                valid_time,
                station_id,
                properties,
                id
            FROM points
            WHERE source_id = :source_id
              AND valid_time BETWEEN :start AND :end
              {bbox_clause}
              {cursor_clause}
            ORDER BY valid_time DESC, id DESC
            LIMIT :limit
        """)

    engine = get_engine()
    async with engine.connect() as conn:
        res = await conn.execute(sql, params)
        rows = res.fetchall()

    # Build a set of requested field names for O(1) lookup
    _fields_set: Optional[frozenset] = frozenset(fields) if fields else None

    result = []
    for row in rows:
        lat, lon, valid_time, station_id, props, row_id = row
        if isinstance(props, str):
            import json
            props = json.loads(props)
        props = props or {}
        if _fields_set is not None:
            props = {k: v for k, v in props.items() if k in _fields_set}
        result.append({
            "lat": float(lat),
            "lon": float(lon),
            "valid_time": valid_time,
            "station_id": station_id,
            "properties": props,
            "_row_id": int(row_id),
        })
    return result


async def list_source_times(
    source_id: str,
    limit: int = 200,
) -> list[datetime]:
    """Return distinct valid_times for a source, newest first."""
    # Truncate to the second to collapse microsecond-level duplicates
    # (lightning inserts can create many rows with nearly-identical timestamps).
    sql = text("""
        SELECT time_bucket('1 minute', valid_time) AS valid_time
        FROM points
        WHERE source_id = :source_id
        GROUP BY time_bucket('1 minute', valid_time)
        ORDER BY valid_time DESC
        LIMIT :limit
    """)
    engine = get_engine()
    async with engine.connect() as conn:
        res = await conn.execute(sql, {"source_id": source_id, "limit": limit})
        rows = res.fetchall()
    print(rows)
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
