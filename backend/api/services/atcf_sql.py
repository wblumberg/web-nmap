"""DB query helpers for ATCF cyclone forecast tracks.

Rows are stored as forecast points in the `atcf_tracks` hypertable.
This service can return either:
- LineString features per storm/model/cycle (default)
- Point features for a specific forecast hour (fhr)
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from sqlalchemy import text

from ..db.engine import get_engine


def _build_bbox_clause() -> str:
    """Build bbox clause."""
    return (
        "AND ST_Intersects(geom, ST_MakeEnvelope(:xmin, :ymin, :xmax, :ymax, 4326))\n"
    )


async def query_atcf_tracks_geojson(
    source_id: str,
    cycle_time: datetime,
    fhr: Optional[int] = None,
    storm_id: Optional[str] = None,
    basin: Optional[str] = None,
    model: Optional[str] = None,
    model_prefix: Optional[str] = None,
    exclude_best: bool = False,
    bbox: Optional[tuple[float, float, float, float]] = None,
    engine=None,
) -> dict:
    """Return ATCF track features for one cycle.

    If `fhr` is provided, returns point features for that forecast hour.
    Otherwise returns one LineString per (storm_id, basin, model, cycle_time).

    ``model`` performs an exact-match filter.
    ``model_prefix`` matches any model whose name starts with the given prefix
    (e.g. ``model_prefix="AP"`` matches AP00, AP01, …).
    ``exclude_best`` removes the BEST track from the results.
    """
    if engine is None:
        engine = get_engine()

    params: dict = {
        "source_id": source_id,
        "cycle_time": cycle_time,
    }

    filter_sql = """
        WHERE source_id = :source_id
          AND cycle_time = :cycle_time
          AND geom IS NOT NULL
    """

    if fhr is not None:
        filter_sql += " AND fhr = :fhr\n"
        params["fhr"] = int(fhr)
    if storm_id:
        filter_sql += " AND storm_id = :storm_id\n"
        params["storm_id"] = storm_id
    if basin:
        filter_sql += " AND basin = :basin\n"
        params["basin"] = basin
    if model:
        filter_sql += " AND model = :model\n"
        params["model"] = model
    if model_prefix:
        filter_sql += " AND model LIKE :model_prefix\n"
        params["model_prefix"] = model_prefix.rstrip("%") + "%"
    if exclude_best:
        filter_sql += " AND model != 'BEST'\n"
    if bbox:
        xmin, ymin, xmax, ymax = bbox
        filter_sql += _build_bbox_clause()
        params.update({"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax})

    if fhr is not None:
        sql = text(
            """
            SELECT
                storm_id,
                basin,
                storm_name,
                model,
                advisory_num,
                cycle_time,
                valid_time,
                fhr,
                max_wind_kt,
                min_pressure_mb,
                ST_AsGeoJSON(geom) AS geom_json
            FROM atcf_tracks
            """
            + filter_sql
            + "ORDER BY storm_id, model, fhr, valid_time"
        )

        features = []
        async with engine.begin() as conn:
            result = await conn.execute(sql, params)
            for row in result.mappings():
                features.append({
                    "type": "Feature",
                    "geometry": json.loads(row["geom_json"]),
                    "properties": {
                        "storm_id": row["storm_id"],
                        "basin": row["basin"],
                        "storm_name": row["storm_name"],
                        "model": row["model"],
                        "advisory_num": row["advisory_num"],
                        "cycle_time": row["cycle_time"].isoformat() if row["cycle_time"] else None,
                        "valid_time": row["valid_time"].isoformat() if row["valid_time"] else None,
                        "fhr": row["fhr"],
                        "max_wind_kt": row["max_wind_kt"],
                        "min_pressure_mb": row["min_pressure_mb"],
                    },
                })

        return {"type": "FeatureCollection", "features": features}

    sql = text(
        """
        SELECT
            storm_id,
            basin,
            storm_name,
            model,
            cycle_time,
            MIN(valid_time) AS start_valid_time,
            MAX(valid_time) AS end_valid_time,
            MIN(fhr) AS fhr_min,
            MAX(fhr) AS fhr_max,
            MAX(max_wind_kt) AS max_wind_kt,
            MIN(min_pressure_mb) AS min_pressure_mb,
            COUNT(*) AS point_count,
            array_to_json(
                array_agg(max_wind_kt ORDER BY fhr ASC, valid_time ASC)
            ) AS wind_kt_array,
            ST_AsGeoJSON(ST_MakeLine(geom ORDER BY fhr ASC, valid_time ASC)) AS geom_json
        FROM atcf_tracks
        """
        + filter_sql
        + """
        GROUP BY storm_id, basin, storm_name, model, cycle_time
        ORDER BY storm_id, model
        """
    )

    features = []
    async with engine.begin() as conn:
        result = await conn.execute(sql, params)
        for row in result.mappings():
            wind_kt_raw = row["wind_kt_array"]
            if isinstance(wind_kt_raw, str):
                wind_kt_raw = json.loads(wind_kt_raw)
            wind_kt_array = [float(v) if v is not None else None for v in (wind_kt_raw or [])]
            features.append({
                "type": "Feature",
                "geometry": json.loads(row["geom_json"]),
                "properties": {
                    "storm_id": row["storm_id"],
                    "basin": row["basin"],
                    "storm_name": row["storm_name"],
                    "model": row["model"],
                    "cycle_time": row["cycle_time"].isoformat() if row["cycle_time"] else None,
                    "start_valid_time": row["start_valid_time"].isoformat() if row["start_valid_time"] else None,
                    "end_valid_time": row["end_valid_time"].isoformat() if row["end_valid_time"] else None,
                    "fhr_min": row["fhr_min"],
                    "fhr_max": row["fhr_max"],
                    "max_wind_kt": row["max_wind_kt"],
                    "min_pressure_mb": row["min_pressure_mb"],
                    "point_count": int(row["point_count"]),
                    "wind_kt_array": wind_kt_array,
                },
            })

    return {"type": "FeatureCollection", "features": features}
