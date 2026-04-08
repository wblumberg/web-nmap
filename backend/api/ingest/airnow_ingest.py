#!/usr/bin/env python3
"""Ingest AirNow hourly CSV observations into the `points` hypertable.

Usage:
  export TIMESCALE_CONN='postgresql+asyncpg://user:pass@host:5432/wxdata'
  python -m backend.api.ingest.airnow_ingest /path/to/output_dir_or_url_dir

This is a lightweight adapter of the original ingest that also writes
point observations into `points` with simple deduplication.
"""
import asyncio
import io
import json
import os
from pathlib import Path
from datetime import datetime, timezone, timedelta
import requests
import pandas as pd
from sqlalchemy import text

from backend.api.db.engine import get_engine

PATH2DATA = "https://files.airnowtech.org/airnow/{year}/{ymd}/HourlyAQObs_{ymdh}.dat"


def make_url(dt):
    return PATH2DATA.format(year=dt.strftime("%Y"), ymd=dt.strftime("%Y%m%d"), ymdh=dt.strftime("%Y%m%d%H"))


def fetch_hour_data(dt, session, timeout=30):
    url = make_url(dt)
    resp = session.get(url, timeout=timeout, stream=True)
    try:
        resp.raise_for_status()
        return resp.content.decode("utf-8")
    finally:
        resp.close()


async def ingest_text_to_db(csv_text, source_id: str = "AIRNOW"):
    # parse CSV
    df = pd.read_csv(io.StringIO(csv_text))
    if df.empty:
        return 0, 0

    rows = []
    for _, row in df.iterrows():
        try:
            lat = float(row.get('Latitude'))
            lon = float(row.get('Longitude'))
        except Exception:
            continue
        date = row.get('ValidDate')
        time = row.get('ValidTime')
        try:
            dt = datetime.strptime(f"{date} {time}", "%m/%d/%Y %H:%M").replace(tzinfo=timezone.utc)
        except Exception:
            dt = datetime.now(timezone.utc)

        # convert NaN -> None so JSONB binding succeeds
        props = {}
        for k in ('PM25', 'PM10', 'OZONE', 'NO2', 'CO', 'SO2', 'Elevation', 'AQSID'):
            v = row.get(k)
            if pd.isna(v):
                v = None
            props[k] = v

        # store properties as JSON string for robust DB binding
        rows.append((source_id, dt, float(lon), float(lat), json.dumps(props, default=str)))

    if not rows:
        return 0, 0

    t_min = min(r[1] for r in rows)
    t_max = max(r[1] for r in rows)

    engine = get_engine()
    insert_sql = text(
        "INSERT INTO points (source_id, valid_time, geom, properties) VALUES "
        "(:source_id, :valid_time, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), :properties)"
    )

    async with engine.begin() as conn:
        existing_q = text(
            "SELECT ST_X(geom) AS lon, ST_Y(geom) AS lat, valid_time FROM points "
            "WHERE source_id = :source_id AND valid_time BETWEEN :tmin AND :tmax"
        )
        res = await conn.execute(existing_q, {"source_id": source_id, "tmin": t_min, "tmax": t_max})
        existing_rows = res.fetchall()

        existing_set = set()
        for er in existing_rows:
            try:
                elon = round(float(er[0]), 6)
                elat = round(float(er[1]), 6)
                et = er[2]
                if hasattr(et, 'astimezone'):
                    et_u = et.astimezone(timezone.utc).replace(microsecond=0)
                else:
                    et_u = et.replace(microsecond=0)
                et_s = et_u.strftime("%Y-%m-%dT%H:%M:%SZ")
                existing_set.add((elon, elat, et_s))
            except Exception:
                continue

        to_insert = []
        for r in rows:
            try:
                rt = r[1]
                if hasattr(rt, 'astimezone'):
                    rt_u = rt.astimezone(timezone.utc).replace(microsecond=0)
                else:
                    rt_u = rt.replace(microsecond=0)
                rt_s = rt_u.strftime("%Y-%m-%dT%H:%M:%SZ")
            except Exception:
                rt_s = str(r[1])
            key = (round(float(r[2]), 6), round(float(r[3]), 6), rt_s)
            if key in existing_set:
                continue
            to_insert.append(r)

        for r in to_insert:
            params = {"source_id": r[0], "valid_time": r[1], "lon": r[2], "lat": r[3], "properties": r[4]}
            await conn.execute(insert_sql, params)

    return len(to_insert), len(rows) - len(to_insert)


async def ingest_hours(start_dt: datetime, hours: int, verbose: bool = False):
    import requests
    with requests.Session() as session:
        for i in range(hours):
            dt = start_dt - timedelta(hours=i)
            if verbose:
                print(f"Fetching {dt:%Y-%m-%d %H}:00 UTC")
            try:
                csv_text = fetch_hour_data(dt, session)
            except Exception as e:
                if verbose:
                    print(f"  fetch error: {e}")
                continue
            inserted, skipped = await ingest_text_to_db(csv_text, source_id='AIRNOW')
            if verbose:
                print(f"  Inserted {inserted}, skipped {skipped} for {dt}")


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--hours", "-n", type=int, default=1)
    p.add_argument("--start-utc", default=None)
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args()

    if args.start_utc:
        start = datetime.strptime(args.start_utc, "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
    else:
        start = datetime.now(timezone.utc)

    asyncio.run(ingest_hours(start, args.hours, verbose=args.verbose))


if __name__ == '__main__':
    main()
