#!/usr/bin/env python3
"""Ingest ATCF A-deck records into the `atcf_tracks` TimescaleDB hypertable.

This script reads ATCF `.dat` files (for example files downloaded by
`backend/api/ingest/ingest_atcf.py`), parses forecast points, and writes rows
into `atcf_tracks` with `source_id = ATCF_TRACKS` by default.

ATCF parsing notes
------------------
The parser uses the standard comma-separated A-deck layout:
  0 basin, 1 storm number, 2 cycle yyyymmddhh, 3 advisory/tech number,
  4 model/technique, 5 forecast hour (tau), 6 lat token, 7 lon token,
  8 max wind (kt), 9 min pressure (mb), and remaining fields are preserved
  in `raw_record` JSONB.

Deduplication strategy
----------------------
Before inserts, rows are deleted per (source_id, cycle_time, basin, storm_id,
model) group represented in the incoming records. This makes repeated ingest
idempotent for a model cycle while allowing updated values to replace older
ones.

Usage
-----
  python -m backend.api.ingest.atcf_db_ingest --input-dir /data/gempak/atcf
  python -m backend.api.ingest.atcf_db_ingest --input-file backend/api/ingest/a-deck.example --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from sqlalchemy import text

from backend.api.db.engine import get_engine


DEFAULT_SOURCE_ID = "ATCF_TRACKS"
DEFAULT_INPUT_DIR = Path("/data/gempak/atcf")
DEFAULT_GLOB = "*.dat"
BATCH_SIZE = 2000


@dataclass(frozen=True)
class AtcfPoint:
    """Represent atcf point."""
    source_id: str
    basin: str
    storm_id: str
    storm_name: str | None
    cycle_time: datetime
    valid_time: datetime
    fhr: int
    model: str
    advisory_num: int | None
    max_wind_kt: int | None
    min_pressure_mb: int | None
    lat: float
    lon: float
    raw_record: dict


def _to_int(value: str | None) -> int | None:
    """Convert the input to int."""
    if value is None:
        return None
    s = value.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _parse_cycle(value: str) -> datetime | None:
    """Parse cycle."""
    s = value.strip()
    if len(s) != 10 or not s.isdigit():
        return None
    try:
        return datetime.strptime(s, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _parse_latlon(token: str) -> float | None:
    """Parse latlon."""
    s = token.strip().upper()
    if len(s) < 2:
        return None
    hemi = s[-1]
    numeric = s[:-1]
    if hemi not in {"N", "S", "E", "W"}:
        return None
    try:
        if "." in numeric:
            value = float(numeric)
        else:
            value = float(int(numeric)) / 10.0
    except ValueError:
        return None

    if hemi in {"S", "W"}:
        value = -value
    return value


def _parse_line(line: str, source_id: str) -> AtcfPoint | None:
    # Keep raw comma tokenization because optional trailing fields are common.
    """Parse line."""
    cols = [c.strip() for c in line.split(",")]
    if len(cols) < 8:
        return None

    basin = cols[0].upper()
    storm_num = cols[1].zfill(2)
    cycle_time = _parse_cycle(cols[2])
    advisory_num = _to_int(cols[3])
    model = cols[4].upper() if len(cols) > 4 and cols[4] else "UNKNOWN"
    fhr = _to_int(cols[5])
    lat = _parse_latlon(cols[6])
    lon = _parse_latlon(cols[7])
    max_wind_kt = _to_int(cols[8]) if len(cols) > 8 else None
    min_pressure_mb = _to_int(cols[9]) if len(cols) > 9 else None
    storm_name = cols[27].strip() if len(cols) > 27 and cols[27].strip() else None

    if cycle_time is None or fhr is None or lat is None or lon is None:
        return None

    valid_time = cycle_time + timedelta(hours=fhr)
    storm_id = f"{basin}{storm_num}"

    raw_record = {
        "line": line.rstrip("\n"),
        "columns": cols,
    }

    return AtcfPoint(
        source_id=source_id,
        basin=basin,
        storm_id=storm_id,
        storm_name=storm_name,
        cycle_time=cycle_time,
        valid_time=valid_time,
        fhr=fhr,
        model=model,
        advisory_num=advisory_num,
        max_wind_kt=max_wind_kt,
        min_pressure_mb=min_pressure_mb,
        lat=lat,
        lon=lon,
        raw_record=raw_record,
    )


def _iter_files(input_dir: Path, glob_pattern: str, explicit_files: list[Path]) -> list[Path]:
    """Iterate over files."""
    files = []
    for p in explicit_files:
        if p.exists() and p.is_file():
            files.append(p)
    if input_dir.exists() and input_dir.is_dir():
        files.extend(sorted(input_dir.glob(glob_pattern)))

    # Keep deterministic order while removing duplicates.
    deduped = []
    seen = set()
    for f in files:
        rp = f.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        deduped.append(rp)
    return deduped


def _parse_files(files: Iterable[Path], source_id: str) -> tuple[list[AtcfPoint], int]:
    """Parse files."""
    points: list[AtcfPoint] = []
    bad_lines = 0

    for path in files:
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                s = line.strip()
                if not s:
                    continue
                p = _parse_line(s, source_id)
                if p is None:
                    bad_lines += 1
                    continue
                points.append(p)

    return points, bad_lines


async def _ingest_points(points: list[AtcfPoint], dry_run: bool) -> tuple[int, int]:
    """Ingest points."""
    if not points:
        return 0, 0

    # De-duplicate exact points in-memory before DB operations.
    unique = {}
    for p in points:
        key = (
            p.source_id,
            p.cycle_time,
            p.basin,
            p.storm_id,
            p.model,
            p.fhr,
            round(p.lat, 4),
            round(p.lon, 4),
        )
        unique[key] = p
    dedup_points = list(unique.values())
    skipped = len(points) - len(dedup_points)

    if dry_run:
        return len(dedup_points), skipped

    engine = get_engine()
    delete_sql = text(
        """
        DELETE FROM atcf_tracks
        WHERE source_id = :source_id
          AND cycle_time = :cycle_time
          AND basin = :basin
          AND storm_id = :storm_id
          AND model = :model
        """
    )
    insert_sql = text(
        """
        INSERT INTO atcf_tracks (
          source_id, cycle_time, valid_time, fhr, basin, storm_id, storm_name,
          model, advisory_num, max_wind_kt, min_pressure_mb, geom, raw_record
        ) VALUES (
          :source_id, :cycle_time, :valid_time, :fhr, :basin, :storm_id, :storm_name,
          :model, :advisory_num, :max_wind_kt, :min_pressure_mb,
          ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
          CAST(:raw_record AS JSONB)
        )
        """
    )

    purge_groups = {
        (p.source_id, p.cycle_time, p.basin, p.storm_id, p.model)
        for p in dedup_points
    }

    async with engine.begin() as conn:
        for source_id, cycle_time, basin, storm_id, model in purge_groups:
            await conn.execute(
                delete_sql,
                {
                    "source_id": source_id,
                    "cycle_time": cycle_time,
                    "basin": basin,
                    "storm_id": storm_id,
                    "model": model,
                },
            )

        for i in range(0, len(dedup_points), BATCH_SIZE):
            batch = dedup_points[i:i + BATCH_SIZE]
            params = [
                {
                    "source_id": p.source_id,
                    "cycle_time": p.cycle_time,
                    "valid_time": p.valid_time,
                    "fhr": p.fhr,
                    "basin": p.basin,
                    "storm_id": p.storm_id,
                    "storm_name": p.storm_name,
                    "model": p.model,
                    "advisory_num": p.advisory_num,
                    "max_wind_kt": p.max_wind_kt,
                    "min_pressure_mb": p.min_pressure_mb,
                    "lon": p.lon,
                    "lat": p.lat,
                    "raw_record": json.dumps(p.raw_record),
                }
                for p in batch
            ]
            await conn.execute(insert_sql, params)

    return len(dedup_points), skipped


def _build_parser() -> argparse.ArgumentParser:
    """Build parser."""
    p = argparse.ArgumentParser(description="Ingest ATCF A-deck .dat files into atcf_tracks")
    p.add_argument("--input-dir", type=Path, default=DEFAULT_INPUT_DIR)
    p.add_argument("--glob", default=DEFAULT_GLOB, help="Glob within --input-dir (default: %(default)s)")
    p.add_argument("--input-file", action="append", type=Path, default=[], help="Explicit file path(s)")
    p.add_argument("--source-id", default=DEFAULT_SOURCE_ID)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--max-files", type=int, default=0, help="Limit number of files processed (0 = no limit)")
    return p


async def _run(args: argparse.Namespace) -> int:
    """Run ATCF parsing and ingestion with parsed CLI arguments."""
    files = _iter_files(args.input_dir, args.glob, args.input_file)
    if args.max_files and args.max_files > 0:
        files = files[:args.max_files]

    if not files:
        print("No input files found.")
        return 1

    print(f"Processing {len(files)} file(s) ...")
    points, bad_lines = _parse_files(files, args.source_id)
    print(f"Parsed {len(points)} point records; skipped {bad_lines} unparseable line(s).")

    inserted, skipped = await _ingest_points(points, args.dry_run)
    if args.dry_run:
        print(f"[dry-run] Would insert {inserted} rows (in-memory skipped duplicates: {skipped}).")
    else:
        print(f"Inserted {inserted} rows (in-memory skipped duplicates: {skipped}).")

    return 0


def main() -> None:
    """Run the command-line entry point."""
    args = _build_parser().parse_args()
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
