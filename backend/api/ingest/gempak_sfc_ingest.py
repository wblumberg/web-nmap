#!/usr/bin/env python3
"""Ingest GEMPAK surface observation files into the `points` hypertable.

Handles two data types, both read via MetPy's GempakSurface:

  SHIP  — hourly ship/marine observations
          /data/gempak/ship/YYYYMMDDHH_sb.gem
          source_id = "SHIP"

  SAO   — synoptic / ASOS surface observations (daily files, many time steps)
          /data/gempak/surface/YYYYMMDD_sao.gem
          source_id = "SAO"

Usage
-----
  # Ingest all SHIP files in the default directory:
  python -m backend.api.ingest.gempak_sfc_ingest --type ship

  # Ingest all SAO files in the default directory:
  python -m backend.api.ingest.gempak_sfc_ingest --type sao

  # Override the directory:
  python -m backend.api.ingest.gempak_sfc_ingest --type ship --dir /data/gempak/ship

  # Ingest a single explicit file:
  python -m backend.api.ingest.gempak_sfc_ingest --type ship /data/gempak/ship/2026040717_sb.gem

  # Re-ingest (skip deduplication check, force-insert everything):
  python -m backend.api.ingest.gempak_sfc_ingest --type sao --force

  # Dry-run (parse + report counts, no DB writes):
  python -m backend.api.ingest.gempak_sfc_ingest --type ship --dry-run

Environment
-----------
  TIMESCALE_CONN   Override default DSN (see db/engine.py).

Notes
-----
  GEMPAK missing-value sentinel is -9999.0.  Those values are stored as
  NULL in the database so downstream queries can filter cleanly.
  Station metadata (id, elevation, state, country) is stored alongside
  the observation values inside the properties JSONB column.
"""

import argparse
import asyncio
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

from backend.api.db.engine import get_engine

# ── Constants ─────────────────────────────────────────────────────────────────

SHIP_DIR = Path("/data/gempak/ship")
SAO_DIR  = Path("/data/gempak/surface")

SHIP_GLOB = "*_sb.gem"
SAO_GLOB  = "*_sao.gem"

SHIP_SOURCE_ID = "SHIP"
SAO_SOURCE_ID  = "SAO"

BATCH_SIZE = 500           # rows per INSERT batch
GEMPAK_MISSING = -9999.0   # sentinel value — stored as NULL


# ── Helpers ───────────────────────────────────────────────────────────────────

def _nullify(v):
    """Return None for GEMPAK missing-value sentinel, otherwise the original."""
    if isinstance(v, float) and math.isclose(v, GEMPAK_MISSING, rel_tol=0, abs_tol=0.5):
        return None
    return v


def _obs_to_row(obs: dict, source_id: str) -> tuple | None:
    """
    Convert a single sfjson() record to an insert-ready tuple:
        (source_id, valid_time, lon, lat, properties_json)

    Returns None if the record lacks required fields.
    """
    props_meta = obs.get("properties", {})
    values     = obs.get("values", {})

    try:
        lat = float(props_meta["latitude"])
        lon = float(props_meta["longitude"])
    except (KeyError, TypeError, ValueError):
        return None

    # GEMPAK date_time is already a naive datetime; treat it as UTC
    raw_dt = props_meta.get("date_time")
    if isinstance(raw_dt, datetime):
        valid_time = raw_dt.replace(tzinfo=timezone.utc) if raw_dt.tzinfo is None else raw_dt
    else:
        return None

    # Build properties: station metadata + observed values (missing → null)
    props = {
        "station_id":     props_meta.get("station_id", ""),
        "station_number": props_meta.get("station_number"),
        "elevation":      props_meta.get("elevation"),
        "state":          props_meta.get("state", ""),
        "country":        props_meta.get("country", ""),
    }
    for k, v in values.items():
        props[k] = _nullify(v)

    # Extract station_id as a direct column; keep it as None if absent or empty
    station_id = props_meta.get("station_id") or None

    return (source_id, valid_time, lon, lat, json.dumps(props, default=str), station_id)


# ── Deduplication helper ──────────────────────────────────────────────────────

async def _existing_keys(conn, source_id: str, t_min: datetime, t_max: datetime) -> set:
    """
    Return a set of (round(lon,4), round(lat,4), valid_time_str) tuples that
    already exist in the DB for this source and time window.
    """
    res = await conn.execute(
        text(
            "SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, valid_time "
            "FROM points "
            "WHERE source_id = :sid AND valid_time BETWEEN :tmin AND :tmax"
        ),
        {"sid": source_id, "tmin": t_min, "tmax": t_max},
    )
    existing: set = set()
    for row in res.fetchall():
        try:
            rlon = round(float(row[0]), 4)
            rlat = round(float(row[1]), 4)
            rt   = row[2]
            if hasattr(rt, "astimezone"):
                rt = rt.astimezone(timezone.utc).replace(microsecond=0)
            existing.add((rlon, rlat, rt.strftime("%Y-%m-%dT%H:%M:%SZ")))
        except Exception:
            continue
    return existing


def _row_key(row: tuple) -> tuple:
    """(round_lon, round_lat, valid_time_str) key for deduplication."""
    _, valid_time, lon, lat, *_ = row
    vt = valid_time
    if hasattr(vt, "astimezone"):
        vt = vt.astimezone(timezone.utc).replace(microsecond=0)
    return (round(lon, 4), round(lat, 4), vt.strftime("%Y-%m-%dT%H:%M:%SZ"))


# ── Core ingest function ──────────────────────────────────────────────────────

async def ingest_file(
    path: Path,
    source_id: str,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> tuple[int, int]:
    """
    Parse a single GEMPAK surface file and insert new observations.

    Returns (inserted, skipped).
    """
    try:
        from metpy.io import GempakSurface
    except ImportError:
        print("ERROR: MetPy is not installed.  Run: pip install metpy", file=sys.stderr)
        sys.exit(1)

    print(f"[{source_id}] Reading {path.name} …", end=" ", flush=True)
    try:
        ds  = GempakSurface(str(path))
        obs = ds.sfjson()
    except Exception as e:
        print(f"\nFAILED to parse {path}: {e}")
        return 0, 0

    print(f"{len(obs)} records", flush=True)

    # Convert to insert rows, dropping bad records
    rows = []
    for rec in obs:
        row = _obs_to_row(rec, source_id)
        if row is not None:
            rows.append(row)

    if not rows:
        print(f"  → 0 valid rows, skipping.")
        return 0, 0

    if dry_run:
        print(f"  [dry-run] Would insert up to {len(rows)} rows.")
        return len(rows), 0

    t_min = min(r[1] for r in rows)
    t_max = max(r[1] for r in rows)

    engine    = get_engine()
    insert_sql = text(
        "INSERT INTO points (source_id, valid_time, geom, properties, station_id) VALUES "
        "(:source_id, :valid_time, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), :properties, :station_id)"
    )

    async with engine.begin() as conn:
        if force:
            existing: set = set()
        else:
            existing = await _existing_keys(conn, source_id, t_min, t_max)

        to_insert = [r for r in rows if _row_key(r) not in existing] if not force else rows

        skipped  = len(rows) - len(to_insert)
        inserted = 0

        # Batched inserts
        for i in range(0, len(to_insert), BATCH_SIZE):
            batch = to_insert[i : i + BATCH_SIZE]
            params = [
                {"source_id": r[0], "valid_time": r[1], "lon": r[2], "lat": r[3], "properties": r[4], "station_id": r[5]}
                for r in batch
            ]
            for p in params:
                await conn.execute(insert_sql, p)
            inserted += len(batch)
            print(f"  … {inserted}/{len(to_insert)} inserted", end="\r", flush=True)

    print(f"  → {inserted} inserted, {skipped} skipped (already present)        ")
    return inserted, skipped


async def ingest_directory(
    directory: Path,
    glob: str,
    source_id: str,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> tuple[int, int]:
    """Ingest all matching files in a directory, newest first."""
    files = sorted(directory.glob(glob), reverse=True)
    if not files:
        print(f"No files matching '{glob}' found in {directory}")
        return 0, 0

    print(f"Found {len(files)} file(s) in {directory}")
    total_ins = total_skip = 0
    for path in files:
        ins, skip = await ingest_file(path, source_id, force=force, dry_run=dry_run)
        total_ins  += ins
        total_skip += skip

    print(f"\nTotal: {total_ins} inserted, {total_skip} skipped.")
    return total_ins, total_skip


# ── CLI ───────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    """Build parser."""
    p = argparse.ArgumentParser(
        prog="gempak_sfc_ingest.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--type", "-t",
        choices=["ship", "sao"],
        required=True,
        help="Data type: 'ship' for marine obs, 'sao' for surface/ASOS obs",
    )
    p.add_argument(
        "--dir", "-d",
        type=Path,
        default=None,
        help="Directory to scan (default: /data/gempak/ship or /data/gempak/surface)",
    )
    p.add_argument(
        "--source-id",
        default=None,
        help="Override the source_id stored in the DB (default: SHIP or SAO)",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Skip deduplication check and insert all records",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse files and report counts without writing to the DB",
    )
    p.add_argument(
        "files",
        nargs="*",
        type=Path,
        help="Explicit file path(s) to ingest instead of scanning a directory",
    )
    return p


def main() -> None:
    """Run the command-line entry point."""
    parser = _build_parser()
    args   = parser.parse_args()

    if args.type == "ship":
        default_dir = SHIP_DIR
        glob        = SHIP_GLOB
        source_id   = args.source_id or SHIP_SOURCE_ID
    else:
        default_dir = SAO_DIR
        glob        = SAO_GLOB
        source_id   = args.source_id or SAO_SOURCE_ID

    directory = args.dir or default_dir

    if args.files:
        # Explicit file list
        async def run_files():
            """Run files."""
            total_ins = total_skip = 0
            for path in args.files:
                ins, skip = await ingest_file(
                    path, source_id, force=args.force, dry_run=args.dry_run
                )
                total_ins  += ins
                total_skip += skip
            print(f"\nTotal: {total_ins} inserted, {total_skip} skipped.")
        asyncio.run(run_files())
    else:
        asyncio.run(
            ingest_directory(
                directory, glob, source_id,
                force=args.force, dry_run=args.dry_run,
            )
        )


if __name__ == "__main__":
    main()
