"""Simple ingestion script: read acad lightning files and insert into DB.

Usage (dev):
  export TIMESCALE_CONN="postgresql+asyncpg://user:pass@localhost:5432/webnmap"
  python -m backend.api.ingest.lightning_ingest /path/to/lightning/dir

This is a prototype: it does basic batching and inserts points with
their properties as JSONB. It avoids duplicate handling — add unique
constraints or dedupe logic as needed for production.
"""
import asyncio
import sys
import os
from pathlib import Path
import json
from sqlalchemy import text

from backend.api.db.engine import get_engine
from backend.api.readers.acad_ltng_reader import AcadLtngReader
from datetime import datetime, timezone, timedelta


BATCH_SIZE = 1000


async def ingest_dir(dirpath: Path, source_id: str = "LIGHTNING",
                     stop_after_all_skipped: int = 3):
    """Ingest lightning files from `dirpath` (newest-first).

    Parameters
    ----------
    stop_after_all_skipped:
        Stop early when this many consecutive files have zero new rows inserted
        (i.e., all data was already in the DB).  Set to 0 to disable early exit.
    """
    engine = get_engine()
    reader = AcadLtngReader()

    consecutive_all_skipped = 0
    files = sorted(dirpath.glob("*.txt"))[::-1] # newest first
    for path in files:
        try:
            result = await reader.read_points(path, {})
        except Exception as e:
            print(f"Failed to read {path}: {e}")
            continue

        points = result.points
        # Batch insert; build per-point timestamps using nanosecond if present
        rows = []
        for pt in points:
            lat = float(pt['lat'])
            lon = float(pt['lon'])
            props = {k: v for k, v in pt.items() if k not in ('lat', 'lon')}
            
            # Derive polarity from peak_current (positive kA → '+', negative → '-', absent → None) and submit as property for easier frontend use
            peak_current = props.get('peak_current')
            if peak_current is not None:
                try:
                    props['polarity'] = '+' if float(peak_current) >= 0 else '-'
                except (TypeError, ValueError):
                    props['polarity'] = None
                    
            # Ensure valid_time is a datetime instance (asyncpg expects datetime, not ISO string)
            valid_time = result.valid_time
            if isinstance(valid_time, str):
                try:
                    # Expecting ISO format like 2026-04-01T18:56:00Z
                    valid_time = datetime.strptime(valid_time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
                except Exception:
                    # Fallback: try fromisoformat (may not accept trailing Z)
                    try:
                        valid_time = datetime.fromisoformat(valid_time)
                        if valid_time.tzinfo is None:
                            valid_time = valid_time.replace(tzinfo=timezone.utc)
                    except Exception:
                        valid_time = datetime.now(timezone.utc)

            # incorporate nanoseconds into per-point timestamp if available
            ns = None
            if 'nanosecond' in pt:
                try:
                    ns = int(pt.get('nanosecond') or 0)
                except Exception:
                    ns = 0
            if ns:
                # convert nanoseconds to microseconds (Postgres precision)
                usec = ns // 1000
                per_pt_time = valid_time + timedelta(microseconds=usec)
            else:
                per_pt_time = valid_time

            rows.append((source_id, per_pt_time, lon, lat, json.dumps(props)))

        if not rows:
            continue

        # Deduplicate: fetch existing points in the file's time window and skip inserts that already exist
        t_min = min(r[1] for r in rows)
        t_max = max(r[1] for r in rows)

        insert_sql = text(
            "INSERT INTO points (source_id, valid_time, geom, properties, station_id) VALUES "
            "(:source_id, :valid_time, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), :properties, NULL)"
        )

        async with engine.begin() as conn:
            # fetch existing points for this source and time window
            existing_q = text(
                "SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, valid_time FROM points "
                "WHERE source_id = :source_id AND valid_time BETWEEN :tmin AND :tmax"
            )
            res = await conn.execute(existing_q, {"source_id": source_id, "tmin": t_min, "tmax": t_max})
            existing_rows = res.fetchall()

            # build a set of existing (rounded lon, rounded lat, valid_time_str) for quick lookup
            existing_set = set()
            for er in existing_rows:
                try:
                    # Use positional access in case the Row doesn't support mapping by name
                    elon = round(float(er[0]), 6)
                    elat = round(float(er[1]), 6)
                    et = er[2]
                    # normalize to UTC ISO seconds string for stable comparison
                    if hasattr(et, 'astimezone'):
                        et_u = et.astimezone(timezone.utc).replace(microsecond=0)
                    else:
                        et_u = et.replace(microsecond=0)
                    et_s = et_u.strftime("%Y-%m-%dT%H:%M:%SZ")
                    existing_set.add((elon, elat, et_s))
                except Exception:
                    continue

            # filter rows to only those not in existing_set
            to_insert = []
            for r in rows:
                # normalize per-row time to UTC ISO seconds string for matching
                row_time = r[1]
                try:
                    if hasattr(row_time, 'astimezone'):
                        rt = row_time.astimezone(timezone.utc).replace(microsecond=0)
                    else:
                        rt = row_time.replace(microsecond=0)
                    rt_s = rt.strftime("%Y-%m-%dT%H:%M:%SZ")
                except Exception:
                    rt_s = str(row_time)
                key = (round(float(r[2]), 6), round(float(r[3]), 6), rt_s)
                if key in existing_set:
                    continue
                to_insert.append(r)

            # perform inserts for new rows only
            for r in to_insert:
                params = {"source_id": r[0], "valid_time": r[1], "lon": r[2], "lat": r[3], "properties": r[4]}
                await conn.execute(insert_sql, params)

        print(f"Inserted {len(to_insert)} new points from {path} (skipped {len(rows)-len(to_insert)})")

        if len(to_insert) == 0 and len(rows) > 0:
            consecutive_all_skipped += 1
            if stop_after_all_skipped > 0 and consecutive_all_skipped >= stop_after_all_skipped:
                print(f"{consecutive_all_skipped} consecutive all-skipped files — stopping early.")
                break
        else:
            consecutive_all_skipped = 0


if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('dirpath', type=Path)
    p.add_argument(
        '--stop-after-all-skipped', type=int, default=3, metavar='N',
        help='Stop early after N consecutive files where all rows were already in the DB (0 = disable)',
    )
    args = p.parse_args()
    if not args.dirpath.exists():
        print('Directory not found:', args.dirpath)
        sys.exit(1)
    asyncio.run(ingest_dir(args.dirpath, stop_after_all_skipped=args.stop_after_all_skipped))
