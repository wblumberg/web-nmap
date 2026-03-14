import os
from pathlib import Path

from api.routers.points import _parse_key_to_dt
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from ..sources.registry import get_source
from api.readers import AcadLtngReader
from typing import Optional

from datetime import timedelta, datetime

router = APIRouter(tags=["Lightning"])


@router.get("/strikes")
async def get_strikes(
    key: Optional[str] = Query(None, description="Valid time key, e.g. 20250302_1800. Defaults to most recent."),
    reference_time: Optional[str] = Query(None, description="Reference time for age calculation. Defaults to `key`."),
    max_age_minutes: int = Query(60, ge=1, le=360, description="Only include strikes younger than this"),
):
    source = get_source("LIGHTNING")

    # ── Compute reference time ───────────────────────────────────────────
    if reference_time is not None:
        ref_dt = _parse_key_to_dt(reference_time)
        if ref_dt is None:
            raise HTTPException(422, f"Cannot parse reference_time '{reference_time}'")
    else:
        # Use latest key if not provided
        if key is None:
            latest = await source.most_recent()
            if latest is None:
                raise HTTPException(404, "No lightning data available")
            key = latest.key
        ref_dt = _parse_key_to_dt(key)
    ref_epoch = ref_dt.timestamp()

    # ── List all files in lightning directory ────────────────────────────
    print("Finding strikes between: ", ref_dt - timedelta(minutes=max_age_minutes), "and", ref_dt)
    times = await source.list_times(before=ref_dt, after=ref_dt - timedelta(minutes=max_age_minutes))  # Populate cache
    print("Found ", len(times), "files in lightning directory")
    #print(files)
    features = []
    total_count = 0
    
    reader = AcadLtngReader()

    for t in times:
        print(t)

        var_map = {
            "peak_current_ka": "peak_current",
            "polarity": "multiplicity",
            "time": "second",
        }
        result = await reader.read_points(t.path, var_map)
        total_count += len(result.points)

        for pt in result.points:
            #print(pt)
            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [pt["lon"], pt["lat"]],
                },
                "properties": {
                    #"time": t.valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "peak_current_ka": pt.get("peak_current"),
                    #"polarity": pt.get("multiplicity"),
                    "age_minutes": round(pt.get('time'), 1),
                }
            })
    print("Building JSON Response")
    print("Total strikes in window:", len(features))
    print("Total strikes in all files:", total_count)
    return JSONResponse({
        "type": "FeatureCollection",
        "metadata": {
            "reference_time": ref_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "max_age_minutes": max_age_minutes,
            "total_strikes": total_count,
            "strikes_in_window": len(features),
        },
        "features": features,
    })
