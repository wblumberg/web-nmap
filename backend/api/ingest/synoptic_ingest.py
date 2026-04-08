#!/usr/bin/env python3
"""Ingest synoptic / mesonet observations into the `points` hypertable.

Adapted from the user's synoptic ingest script; this writes per-station
rows into `points` with deduplication by time+location.
"""
import asyncio
import json
from datetime import datetime, timezone
from sqlalchemy import text

from backend.api.db.engine import get_engine


async def ingest_station_rows(station_rows, source_id: str = 'SYNOPTIC'):
    rows = []
    for station in station_rows:
        try:
            slat = float(station.get('latitude'))
            slon = float(station.get('longitude'))
        except Exception:
            continue
        mid = station.get('stid') or station.get('mid')
        dt_raw = station.get('utc') or station.get('time') or station.get('datetime')
        try:
            dt = datetime.strptime(dt_raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except Exception:
            dt = datetime.now(timezone.utc)

        props = {k: station.get(k) for k in station.keys() if k not in ('latitude', 'longitude', 'utc', 'stid', 'mid')}
        props['STID'] = mid

        rows.append((source_id, dt, slon, slat, json.dumps(props)))

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
                et_s = et_u.strftime('%Y-%m-%dT%H:%M:%SZ')
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
                rt_s = rt_u.strftime('%Y-%m-%dT%H:%M:%SZ')
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


def main_from_rows(rows):
    return asyncio.run(ingest_station_rows(rows))


if __name__ == '__main__':
    import glob, json
    # Example usage: point these scripts at a JSON file or a glob of JSON files
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument('files', nargs='+')
    args = p.parse_args()

    all_rows = []
    for f in args.files:
        with open(f, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        # expect list of station dicts under 'results' or top-level list
        if isinstance(data, dict) and 'results' in data:
            st = data['results']
        elif isinstance(data, list):
            st = data
        else:
            # try to find a top-level key containing list
            st = []
            for v in data.values():
                if isinstance(v, list):
                    st = v
                    break
        all_rows.extend(st)

    inserted, skipped = main_from_rows(all_rows)
    print(f'Inserted {inserted}, skipped {skipped}')
