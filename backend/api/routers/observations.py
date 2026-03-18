"""
routers/observations.py — Surface Observation Endpoints

Handles time-windowed observation queries.

For surface METARs, we often want ALL observations within a ±N-minute
window of a valid time (not just one snapshot), because individual station
reports arrive at different times throughout the hour.

─── Endpoints ───────────────────────────────────────────────────────────────

GET /api/v1/observations/surface
    → Observations for the closest available time
    → Query params: key, window_minutes

GET /api/v1/observations/surface/window
    → All observations within a time window (union of multiple files)
    → Query params: center, window_minutes
"""

import gzip
import json
import os
from time import perf_counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..services.obs_sql import ObservationSQLStore, parse_time_like
from ..sources.registry import get_source

router = APIRouter(tags=["Observations"])

OBS_DB_PATH = Path(
    os.environ.get(
        "WEBNMAP_OBS_DB",
        str("/data/store/point/observations.sqlite"),
    )
)
OBS_SQL = ObservationSQLStore(OBS_DB_PATH)
OBS_SQL.initialize()


@router.get("/surface")
async def get_surface_obs(
    key            : Optional[str] = Query(None, description="Valid time key. Defaults to most recent."),
    window_minutes : int           = Query(0,  ge=0, le=120,
                                          description="If > 0, merge obs from multiple files within ±window_minutes"),
):
    """
    Return surface observations for a given time.

    With window_minutes=0 (default): returns one file's worth of obs.
    With window_minutes=30: merges all observation files within ±30 minutes,
    keeping the most recent observation per station (by ICAO id).

    The merged mode is useful when looping through time — instead of seeing
    empty plots during gap periods between synoptic hours, you always have
    a full surface chart.

    Response format:
        {
          "metadata": { ... },
          "observations": [
            { "id": "KOKC", "lat": 35.39, "lon": -97.60,
              "data": { "tmpf": 72, "dwpf": 58, "wind": [180, 15], ... }
            },
            ...
          ]
        }
    """
    source = get_source("SURFACE_OBS")

    if key is None:
        latest = await source.most_recent()
        if latest is None:
            raise HTTPException(404, "No surface obs data available")
        key = latest.key

    if window_minutes == 0:
        # Simple case: load exactly one file
        obs = await _load_obs_file(source, key)
        return JSONResponse({
            "metadata": {
                "key"   : key,
                "mode"  : "single",
                "count" : len(obs),
            },
            "observations": obs,
        })
    else:
        # Merge mode: load all files within the window
        center_dt = _parse_key_to_dt(key)
        if center_dt is None:
            raise HTTPException(422, f"Cannot parse key '{key}'")

        window     = timedelta(minutes=window_minutes)
        times      = await source.list_times(
            after  = center_dt - window,
            before = center_dt + window,
            limit  = 50,
        )

        # Load all the files and merge, keeping most-recent per station
        merged: dict[str, dict] = {}  # station_id → observation dict
        for t in times:
            try:
                obs_list = await _load_obs_file(source, t.key)
            except Exception:
                continue

            for ob in obs_list:
                sid = ob.get("id") or ob.get("station_id")
                if not sid:
                    continue
                # Keep the observation closest in time to the center
                existing = merged.get(sid)
                if existing is None:
                    merged[sid] = ob
                else:
                    # Pick whichever ob is closer to the center time
                    existing_dt = _parse_key_to_dt(existing.get("_key", key))
                    new_dt      = _parse_key_to_dt(ob.get("_key", t.key))
                    if existing_dt and new_dt:
                        if abs((new_dt - center_dt).total_seconds()) < \
                           abs((existing_dt - center_dt).total_seconds()):
                            merged[sid] = ob

        obs_list = list(merged.values())
        return JSONResponse({
            "metadata": {
                "key"            : key,
                "mode"           : "merged",
                "window_minutes" : window_minutes,
                "files_merged"   : len(times),
                "count"          : len(obs_list),
            },
            "observations": obs_list,
        })


@router.get("/sql/times")
async def list_sql_times(
    obs_types : Optional[str] = Query(
        None,
        description="Comma-separated obs types (e.g. METAR,SHIP,RECON,LIGHTNING,AIR_QUALITY).",
    ),
    limit: int = Query(200, ge=1, le=5000),
):
    """
    List unique observation datetimes currently available in the SQL store.
    """
    t_total_start = perf_counter()

    t_parse_start = perf_counter()
    parsed_types = _parse_obs_types(obs_types)
    t_parse_end = perf_counter()

    t_sql_start = perf_counter()
    rows = OBS_SQL.list_unique_times(obs_types=parsed_types, limit=limit)
    t_sql_end = perf_counter()

    t_build_start = perf_counter()
    payload = {
        "metadata": {
            "db_path": str(OBS_DB_PATH),
            "obs_types": parsed_types,
            "count": len(rows),
            "limit": limit,
        },
        "times": rows,
    }

    timing = {
        "parse_obs_types_ms": _elapsed_ms(t_parse_start, t_parse_end),
        "sql_list_times_ms": _elapsed_ms(t_sql_start, t_sql_end),
        "response_build_ms": 0.0,
        "total_ms": 0.0,
    }
    payload["metadata"]["timing"] = timing

    t_build_end = perf_counter()
    timing["response_build_ms"] = _elapsed_ms(t_build_start, t_build_end)
    timing["total_ms"] = _elapsed_ms(t_total_start, t_build_end)

    headers = {"Server-Timing": _server_timing_header(timing)}

    return JSONResponse(payload, headers=headers)


@router.get("/sql/query")
async def query_sql_observations(
    obs_types        : Optional[str] = Query(
        None,
        description="Comma-separated obs types to include. Omit for all types in DB.",
    ),
    center           : Optional[str] = Query(
        None,
        description="Reference time (ISO or key like 20260301_1800). Defaults to latest time in DB.",
    ),
    minutes_before   : int = Query(0, ge=0, le=10080),
    minutes_after    : int = Query(0, ge=0, le=10080),
    latest_only      : bool = Query(False, description="If true, return one snapshot per obs_type."),
    prefer_most_data : bool = Query(
        True,
        description="In latest_only mode, choose the snapshot with the most rows in window and fall back to densest available snapshot.",
    ),
    bin_minutes      : int = Query(0, ge=0, le=1440),
    parameters       : Optional[str] = Query(
        None,
        description="Comma-separated payload parameter names to include (e.g. tmpf,dwpf,wind_speed).",
    ),
    max_rows         : int = Query(50000, ge=1, le=200000),
):
    """
    Query SQL-backed observations with time windowing, latest-only mode,
    optional most-data fallback, and optional time binning.
    """
    t_total_start = perf_counter()

    t_parse_center_start = perf_counter()
    center_dt = _parse_any_time(center) if center else None
    t_parse_center_end = perf_counter()
    if center is not None and center_dt is None:
        raise HTTPException(422, f"Cannot parse center time '{center}'")

    t_parse_types_start = perf_counter()
    parsed_types = _parse_obs_types(obs_types)
    t_parse_types_end = perf_counter()

    t_parse_params_start = perf_counter()
    param_names = [p.strip() for p in parameters.split(",") if p.strip()] if parameters else None
    t_parse_params_end = perf_counter()

    t_sql_start = perf_counter()
    payload = OBS_SQL.query_observations(
        obs_types=parsed_types,
        center_time=center_dt,
        minutes_before=minutes_before,
        minutes_after=minutes_after,
        latest_only=latest_only,
        prefer_most_data=prefer_most_data,
        parameter_names=param_names,
        bin_minutes=bin_minutes,
        max_rows=max_rows,
    )
    t_sql_end = perf_counter()

    t_build_start = perf_counter()
    metadata = payload.setdefault("metadata", {})
    timing = {
        "parse_center_ms": _elapsed_ms(t_parse_center_start, t_parse_center_end),
        "parse_obs_types_ms": _elapsed_ms(t_parse_types_start, t_parse_types_end),
        "parse_parameters_ms": _elapsed_ms(t_parse_params_start, t_parse_params_end),
        "sql_query_ms": _elapsed_ms(t_sql_start, t_sql_end),
        "response_build_ms": 0.0,
        "total_ms": 0.0,
    }
    metadata["timing"] = timing

    t_build_end = perf_counter()
    timing["response_build_ms"] = _elapsed_ms(t_build_start, t_build_end)
    timing["total_ms"] = _elapsed_ms(t_total_start, t_build_end)

    headers = {"Server-Timing": _server_timing_header(timing)}
    return JSONResponse(payload, headers=headers)


async def _load_obs_file(source, key: str) -> list[dict]:
    path = await source.get_path(key)
    if path is None:
        raise HTTPException(404, f"No obs data for key '{key}'")
    try:
        raw = path.read_bytes()
        if path.suffix == ".gz":
            raw = gzip.decompress(raw)
        return json.loads(raw)
    except Exception as e:
        raise HTTPException(500, f"Failed to load obs file: {e}")


def _parse_key_to_dt(key: str) -> datetime | None:
    if not key:
        return None
    k = key.replace("_", "")
    for fmt in ("%Y%m%d%H%M", "%Y%m%d%H"):
        try:
            return datetime.strptime(k, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _parse_obs_types(obs_types: str | None) -> list[str] | None:
    if not obs_types:
        return None
    values = [v.strip().upper() for v in obs_types.split(",") if v.strip()]
    return values or None


def _parse_any_time(raw: str | None) -> datetime | None:
    if raw is None:
        return None

    dt = parse_time_like(raw)
    if dt is not None:
        return dt

    return _parse_key_to_dt(raw)


def _elapsed_ms(start: float, end: float) -> float:
    return round((end - start) * 1000.0, 3)


def _server_timing_header(timing: dict[str, float]) -> str:
    parts: list[str] = []
    for key, value in timing.items():
        if not key.endswith("_ms"):
            continue
        metric_name = key[:-3].replace("-", "_")
        parts.append(f"{metric_name};dur={value:.3f}")
    return ", ".join(parts)
