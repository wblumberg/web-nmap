"""Database helpers for ingesting VAD observations into ``profiles``.

The VAD parser intentionally lives in :mod:`vad_ingest`; this module only
defines the row passed between the parser and database layer and performs the
batched, idempotent insert.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

from sqlalchemy import text

from backend.api.db.engine import get_engine


BATCH_SIZE = 2_000


@dataclass(frozen=True)
class ProfileRow:
    """A single vertical profile observation ready for database insertion."""

    source_id: str
    station_id: str | None
    valid_time: datetime
    lat: float
    lon: float
    profile_json: str
    metadata_json: str | None = None


def _utc(value: datetime) -> datetime:
    """Return a timezone-aware UTC datetime suitable for asyncpg."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _validate_row(row: ProfileRow) -> ProfileRow:
    """Validate row."""
    if not row.source_id:
        raise ValueError("ProfileRow.source_id must not be empty")
    if not -90.0 <= float(row.lat) <= 90.0:
        raise ValueError(f"Invalid profile latitude: {row.lat}")
    if not -180.0 <= float(row.lon) <= 180.0:
        raise ValueError(f"Invalid profile longitude: {row.lon}")

    # Fail before opening a transaction and provide a clearer error than a
    # PostgreSQL JSONB cast failure.
    json.loads(row.profile_json)
    if row.metadata_json is not None:
        json.loads(row.metadata_json)

    return ProfileRow(
        source_id=row.source_id,
        station_id=row.station_id,
        valid_time=_utc(row.valid_time),
        lat=float(row.lat),
        lon=float(row.lon),
        profile_json=row.profile_json,
        metadata_json=row.metadata_json,
    )


async def _ingest_rows(
    rows: Iterable[ProfileRow],
    dry_run: bool = False,
) -> int:
    """Insert profile rows that are not already present.

    A profile is identified by ``(source_id, station_id, valid_time)``. Exact
    duplicate keys in the input are collapsed, and keys already in the table
    are skipped. The function returns the number of rows inserted (or that
    would be inserted during a dry run).
    """
    unique: dict[tuple[str, str | None, datetime], ProfileRow] = {}
    for raw_row in rows:
        row = _validate_row(raw_row)
        unique[(row.source_id, row.station_id, row.valid_time)] = row

    pending = list(unique.values())
    if not pending:
        return 0
    if dry_run:
        return len(pending)

    select_existing_sql = text(
        """
        SELECT station_id, valid_time
        FROM profiles
        WHERE source_id = :source_id
          AND valid_time BETWEEN :start_time AND :end_time
        """
    )
    insert_sql = text(
        """
        INSERT INTO profiles (
          source_id, station_id, valid_time, geom, profile, metadata
        ) VALUES (
          :source_id, :station_id, :valid_time,
          ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
          CAST(:profile_json AS JSONB),
          CAST(:metadata_json AS JSONB)
        )
        """
    )

    engine = get_engine()
    async with engine.begin() as conn:
        existing: set[tuple[str, str | None, datetime]] = set()
        source_rows: dict[str, list[ProfileRow]] = {}
        for row in pending:
            source_rows.setdefault(row.source_id, []).append(row)

        for source_id, grouped_rows in source_rows.items():
            result = await conn.execute(
                select_existing_sql,
                {
                    "source_id": source_id,
                    "start_time": min(row.valid_time for row in grouped_rows),
                    "end_time": max(row.valid_time for row in grouped_rows),
                },
            )
            for station_id, valid_time in result.fetchall():
                existing.add((source_id, station_id, _utc(valid_time)))

        to_insert = [
            row
            for row in pending
            if (row.source_id, row.station_id, row.valid_time) not in existing
        ]

        for offset in range(0, len(to_insert), BATCH_SIZE):
            batch = to_insert[offset : offset + BATCH_SIZE]
            await conn.execute(
                insert_sql,
                [
                    {
                        "source_id": row.source_id,
                        "station_id": row.station_id,
                        "valid_time": row.valid_time,
                        "lon": row.lon,
                        "lat": row.lat,
                        "profile_json": row.profile_json,
                        "metadata_json": row.metadata_json,
                    }
                    for row in batch
                ],
            )

    return len(to_insert)


# Public spelling for callers that do not need to treat this as an internal
# helper. ``vad_ingest.py`` historically imports the underscored name.
ingest_rows = _ingest_rows


__all__ = ["ProfileRow", "ingest_rows", "_ingest_rows"]
