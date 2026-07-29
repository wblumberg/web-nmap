#!/usr/bin/env python3
"""Ingest hurricane reconnaissance (URNT/HDOB) observations into the `points` hypertable.

Fetches HDOB bulletins from https://tgftp.nws.noaa.gov/data/raw/ur/, parses them
using the existing recon parsing library, and writes each observation as a row in
the TimescaleDB `points` table with source_id = "RECON".

Schema written per row
----------------------
  source_id   → "RECON"
  valid_time  → obs_time (UTC)
  geom        → ST_MakePoint(longitude_deg, latitude_deg, 4326)
  station_id  → mission_id (e.g. "AF301", "NOAA2")
  properties  → JSONB with all met/QC fields (see _obs_to_props)
  cycle       → NULL  (not applicable)
  fhr         → NULL  (not applicable)

Deduplication
-------------
  Before inserting, existing rows for the same source_id and time window are
  fetched.  Dedup key is (round(lon,4), round(lat,4), valid_time_str).  For
  recon data the aircraft rarely revisits the exact same point at the same
  second, so this is a safe key.

Usage
-----
  # Fetch last 30 min from server, retain 6 h in cache, insert new obs:
  python -m backend.api.ingest.recon_ingest

  # Ingest from an existing cache file without hitting the server:
  python -m backend.api.ingest.recon_ingest --cache-only --cache-file /path/to/recon_cache.jsonl

  # Dry-run (parse + report counts, no DB writes):
  python -m backend.api.ingest.recon_ingest --dry-run

  # Force re-insert (skip deduplication):
  python -m backend.api.ingest.recon_ingest --force

  # Keep all QC (including questionable obs):
  python -m backend.api.ingest.recon_ingest --keep-all

Environment
-----------
  TIMESCALE_CONN   DSN for the TimescaleDB instance (see db/engine.py).
                   e.g. postgresql+asyncpg://user:pass@host:5432/dbname
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import text

# ── Import recon parsing library ───────────────────────────────────────────────
# The existing ingest_obs.py lives outside this package tree; add its directory
# to sys.path so we can import its helpers without duplication.

_RECON_SCRIPT = Path(__file__).parents[5] / "ingest" / "obs" / "recon" / "ingest_obs.py"
if _RECON_SCRIPT.parent.as_posix() not in sys.path:
    sys.path.insert(0, str(_RECON_SCRIPT.parent))

from ingest_obs import (  # noqa: E402  (intentional late import after path fix)
    HDOBObservation,
    URDirectoryClient,
    apply_qc_filter,
    decode_urnt_file,
    filter_recent,
    load_cache,
    merge_and_prune_cache,
    parse_index_timestamps_into_metas,
    save_cache,
)

from backend.api.db.engine import get_engine  # noqa: E402

# ── Constants ──────────────────────────────────────────────────────────────────

SOURCE_ID  = "RECON"
BATCH_SIZE = 500

DEFAULT_CACHE_FILE   = Path(__file__).parents[4] / "recon_cache.jsonl"
DEFAULT_RETAIN_HOURS = 6.0
DEFAULT_FETCH_HOURS  = 0.5
DEFAULT_REGEN_HOURS  = 6.0

# ── Observation → DB row helpers ───────────────────────────────────────────────

def _obs_to_props(o: HDOBObservation) -> dict:
    """Build the JSONB properties dict from an HDOBObservation."""
    return {
        # Identification
        "mission_id":   o.mission_id,
        "source_file":  o.source_file,
        "wmo_header":   o.wmo_header,
        # Position / altitude
        "flight_level_pressure_mb":     o.flight_level_pressure_mb,
        "geopotential_height_m":        o.geopotential_height_m,
        "extrap_sfc_pres_dvalue_mb":    o.extrap_sfc_pres_dvalue_tenths,
        # Thermodynamics
        "flight_level_temp_c":          o.flight_level_temp_c,
        "flight_level_dewpoint_c":      o.flight_level_dewpoint_c,
        # Wind
        "wind_dir_deg":                 o.wind_dir_deg,
        "wind_speed_kt":                o.wind_speed_kt,
        "max_10s_flt_wind_kt":          o.max_10s_flt_wind_kt,
        "max_10s_sfc_wind_kt":          o.max_10s_sfc_wind_kt,
        # SFMR
        "sfmr_rain_rate_mm_per_hr":     o.sfmr_rain_rate_mm_per_hr,
        # QC
        "qc_flags":                     o.qc_flags,
        "qc_pos_code":                  o.qc_pos_code,
        "qc_met_code":                  o.qc_met_code,
        "qc_pos_desc":                  o.qc_pos_desc,
        "qc_met_desc":                  o.qc_met_desc,
        "qc_any_questionable":          o.qc_any_questionable,
    }


def _obs_to_row(o: HDOBObservation) -> tuple | None:
    """
    Convert an HDOBObservation to an insert-ready tuple:
        (source_id, valid_time, lon, lat, properties_json, station_id)

    Returns None if lat/lon/time are missing.
    """
    if o.latitude_deg is None or o.longitude_deg is None or o.obs_time is None:
        return None
    valid_time = o.obs_time
    if valid_time.tzinfo is None:
        valid_time = valid_time.replace(tzinfo=timezone.utc)
    station_id = (o.mission_id or "HDOB")[:8]
    props_json = json.dumps(_obs_to_props(o), default=str)
    return (SOURCE_ID, valid_time, o.longitude_deg, o.latitude_deg, props_json, station_id)


# ── Deduplication ──────────────────────────────────────────────────────────────

async def _existing_keys(conn, t_min: datetime, t_max: datetime) -> set:
    res = await conn.execute(
        text(
            "SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, valid_time "
            "FROM points "
            "WHERE source_id = :sid AND valid_time BETWEEN :tmin AND :tmax"
        ),
        {"sid": SOURCE_ID, "tmin": t_min, "tmax": t_max},
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
    _, valid_time, lon, lat, *_ = row
    vt = valid_time
    if hasattr(vt, "astimezone"):
        vt = vt.astimezone(timezone.utc).replace(microsecond=0)
    return (round(lon, 4), round(lat, 4), vt.strftime("%Y-%m-%dT%H:%M:%SZ"))


# ── Core ingest function ───────────────────────────────────────────────────────

async def ingest_observations(
    observations: list[HDOBObservation],
    *,
    force: bool = False,
    dry_run: bool = False,
) -> tuple[int, int]:
    """Insert HDOBObservations into the `points` table.

    Returns (inserted, skipped).
    """
    rows = []
    for o in observations:
        row = _obs_to_row(o)
        if row is not None:
            rows.append(row)

    if not rows:
        logging.warning("No valid rows to insert.")
        return 0, 0

    if dry_run:
        print(f"  [dry-run] Would insert up to {len(rows)} rows.")
        return len(rows), 0

    t_min = min(r[1] for r in rows)
    t_max = max(r[1] for r in rows)

    engine = get_engine()
    insert_sql = text(
        "INSERT INTO points (source_id, valid_time, geom, properties, station_id) VALUES "
        "(:source_id, :valid_time, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), :properties, :station_id)"
    )

    async with engine.begin() as conn:
        existing: set = set() if force else await _existing_keys(conn, t_min, t_max)
        to_insert = [r for r in rows if _row_key(r) not in existing]

        skipped  = len(rows) - len(to_insert)
        inserted = 0

        for i in range(0, len(to_insert), BATCH_SIZE):
            batch = to_insert[i : i + BATCH_SIZE]
            params = [
                {
                    "source_id":  r[0],
                    "valid_time": r[1],
                    "lon":        r[2],
                    "lat":        r[3],
                    "properties": r[4],
                    "station_id": r[5],
                }
                for r in batch
            ]
            for p in params:
                await conn.execute(insert_sql, p)
            inserted += len(batch)
            print(f"  … {inserted}/{len(to_insert)} inserted", end="\r", flush=True)

    print(f"  → {inserted} inserted, {skipped} skipped (already present)        ")
    return inserted, skipped


# ── Fetch + parse pipeline ─────────────────────────────────────────────────────

def fetch_and_parse(
    *,
    fetch_hours: float,
    max_workers: int,
    no_head: bool,
    limit: int | None,
    allow_pos: set[str],
    allow_met: set[str],
    keep_all: bool,
) -> list[HDOBObservation]:
    """Hit tgftp.nws.noaa.gov, download recent URNT files, decode & QC-filter."""
    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    client = URDirectoryClient()

    logging.info("Fetching URNT directory listing …")
    html = client.fetch_directory_listing()
    metas = client.parse_file_list(html)
    logging.info("Found %d URNT candidate files.", len(metas))

    if not no_head:
        logging.info("Resolving Last-Modified via HEAD requests …")
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
            for _ in concurrent.futures.as_completed(
                [ex.submit(client.enrich_with_head, m) for m in metas]
            ):
                pass

    parse_index_timestamps_into_metas(html, metas)
    recent = filter_recent(metas, fetch_hours, now)

    if limit:
        recent = sorted(recent, key=lambda m: m.last_modified or now, reverse=True)[:limit]

    logging.info("Recent files (<= %.2f h): %d", fetch_hours, len(recent))
    if not recent:
        logging.warning("No recent URNT files found on server.")
        return []

    logging.info("Downloading %d file(s) …", len(recent))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        for _ in concurrent.futures.as_completed(
            [ex.submit(client.download_content, m) for m in recent]
        ):
            pass

    all_obs: list[HDOBObservation] = []
    for meta in recent:
        all_obs.extend(decode_urnt_file(meta, ref_time=now))

    logging.info("Decoded %d observations (pre-QC).", len(all_obs))
    filtered = apply_qc_filter(all_obs, allow_pos, allow_met, keep_all)
    kept = sum(1 for o in filtered if o.kept)
    logging.info("Kept after QC: %d of %d.", kept, len(all_obs))
    return filtered


# ── CLI ────────────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="recon_ingest.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--hours", type=float, default=DEFAULT_FETCH_HOURS,
        help="Lookback window for server fetch (hours, default %(default)s).",
    )
    p.add_argument(
        "--retain-hours", type=float, default=DEFAULT_RETAIN_HOURS,
        help="Cache retention window (hours, default %(default)s).",
    )
    p.add_argument(
        "--cache-file", type=Path, default=DEFAULT_CACHE_FILE,
        help="Path to JSONL rolling cache file (default: %(default)s).",
    )
    p.add_argument(
        "--cache-only", action="store_true",
        help="Skip server fetch; ingest only what is already in the cache file.",
    )
    p.add_argument(
        "--no-cache-update", action="store_true",
        help="Do not read or write the cache file (one-shot fetch + ingest).",
    )
    p.add_argument(
        "--force", action="store_true",
        help="Skip deduplication check and insert all records.",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Parse + report counts without writing to the DB.",
    )
    p.add_argument(
        "--keep-all", action="store_true",
        help="Disable QC filtering (ingest all obs regardless of QC flags).",
    )
    p.add_argument(
        "--allow-pos-qc", default="0",
        help="Allowed positional QC codes, comma-separated (default: '0').",
    )
    p.add_argument(
        "--allow-met-qc", default="0",
        help="Allowed meteorological QC codes, comma-separated (default: '0').",
    )
    p.add_argument(
        "--max-workers", type=int, default=8,
        help="Thread-pool size for parallel HTTP requests.",
    )
    p.add_argument(
        "--no-head", action="store_true",
        help="Skip HEAD requests for Last-Modified timestamps.",
    )
    p.add_argument(
        "--limit", type=int, default=None,
        help="Limit number of recent URNT files decoded.",
    )
    p.add_argument(
        "--verbose", action="store_true",
        help="Enable DEBUG logging.",
    )
    return p


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    now = datetime.utcnow().replace(tzinfo=timezone.utc)
    allow_pos = {x.strip() for x in args.allow_pos_qc.split(",") if x.strip()}
    allow_met = {x.strip() for x in args.allow_met_qc.split(",") if x.strip()}

    # ── 1. Fetch (unless cache-only) ─────────────────────────────────────────
    new_obs: list[HDOBObservation] = []
    if not args.cache_only:
        new_obs = fetch_and_parse(
            fetch_hours=args.hours,
            max_workers=args.max_workers,
            no_head=args.no_head,
            limit=args.limit,
            allow_pos=allow_pos,
            allow_met=allow_met,
            keep_all=args.keep_all,
        )

    # ── 2. Cache merge ────────────────────────────────────────────────────────
    if args.no_cache_update:
        obs_to_ingest = new_obs
    else:
        cached = load_cache(str(args.cache_file))
        merged = merge_and_prune_cache(cached, new_obs, args.retain_hours, now)
        save_cache(str(args.cache_file), merged)
        # Only ingest obs that passed QC (kept=True) from the merged set
        obs_to_ingest = [o for o in merged if o.kept]

    logging.info("Observations to ingest: %d", len(obs_to_ingest))
    if not obs_to_ingest:
        logging.warning("Nothing to ingest.")
        return 0

    # ── 3. DB ingest ──────────────────────────────────────────────────────────
    inserted, skipped = asyncio.run(
        ingest_observations(obs_to_ingest, force=args.force, dry_run=args.dry_run)
    )
    logging.info("Done. Inserted: %d, Skipped: %d.", inserted, skipped)
    return 0


if __name__ == "__main__":
    sys.exit(main())
