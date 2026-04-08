#!/usr/bin/env python3
"""Ingest LSR GeoJSON reports into `points` hypertable.

This adapts the existing `lsr` ingest to also persist reports into the DB.
"""
import asyncio
import json
from datetime import datetime, timezone
from typing import List
DEFAULT_LSR_URL = (
    "https://mapservices.weather.noaa.gov/vector/rest/services/obs/"
    "nws_local_storm_reports/MapServer/2/query?outFields=*&where=1%3D1&f=geojson"
)
from sqlalchemy import text

from backend.api.db.engine import get_engine


def parse_valid_time(vt: str) -> datetime:
    # expected format: 'YYYY-mm-dd HH:MM:SS+00'
    try:
        return datetime.strptime(vt, "%Y-%m-%d %H:%M:%S+00").replace(tzinfo=timezone.utc)
    except Exception:
        # try ISO fallback
        try:
            return datetime.fromisoformat(vt).astimezone(timezone.utc)
        except Exception:
            return datetime.now(timezone.utc)


async def ingest_features(features: List[dict], source_id: str = 'LSR'):
    rows = []
    for feat in features:
        props = feat.get('properties', {}) or {}
        geom = feat.get('geometry', {}) or {}
        coords = geom.get('coordinates')
        if not coords or len(coords) < 2:
            continue
        lon, lat = float(coords[0]), float(coords[1])
        vt = props.get('valid_time')
        if not vt:
            continue
        dt = parse_valid_time(vt)
        # include select props
        keep = {k: props.get(k) for k in ('descript', 'magnitude', 'units', 'event') if k in props}
        rows.append((source_id, dt, lon, lat, json.dumps(keep)))

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


def main_from_geojson(geojson: dict, dry_run: bool = False):
    # This function is synchronous wrapper that calls async ingest
    features = geojson.get('features', [])
    return asyncio.run(ingest_features(features))


if __name__ == '__main__':
    import argparse, requests
    p = argparse.ArgumentParser()
    p.add_argument('--url', default=DEFAULT_LSR_URL, help='LSR GeoJSON URL')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()

    with requests.Session() as s:
        r = s.get(args.url, timeout=60)
        r.raise_for_status()
        data = r.json()
    inserted, skipped = main_from_geojson(data, dry_run=args.dry_run)
    print(f'Inserted {inserted}, skipped {skipped}')
