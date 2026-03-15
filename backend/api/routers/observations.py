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
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..sources.registry import get_source

router = APIRouter(tags=["Observations"])


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
