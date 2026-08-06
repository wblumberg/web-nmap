"""Expose FastAPI endpoints for time-windowed lightning strikes."""

import os
from pathlib import Path
from datetime import timedelta, datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse
from ..sources.registry import get_source
from ..readers import AcadLtngReader
from ..services.points_sql import query_points, most_recent_time
from ..utils.time_helper import _parse_key_to_dt

router = APIRouter(tags=["Lightning"])

_LIGHTNING_SOURCE = "LIGHTNING"


@router.get("/strikes")
async def get_strikes(
    key: Optional[str] = Query(None, description="Valid time key, e.g. 20250302_1800. Defaults to most recent."),
    reference_time: Optional[str] = Query(None, description="Reference time for age calculation. Defaults to `key`."),
    max_age_minutes: int = Query(60, ge=1, le=360, description="Only include strikes younger than this"),
    source: str = Query("db", description="Data source: 'db' (TimescaleDB, default) or 'file' (flat files)."),
):
    # ── Compute reference time ───────────────────────────────────────────
    """Retrieve strikes."""
    if reference_time is not None:
        ref_dt = _parse_key_to_dt(reference_time)
        if ref_dt is None:
            raise HTTPException(422, f"Cannot parse reference_time '{reference_time}'")
    elif key is not None:
        ref_dt = _parse_key_to_dt(key)
        if ref_dt is None:
            raise HTTPException(422, f"Cannot parse key '{key}'")
    else:
        ref_dt = None   # resolve below per source

    if source.lower() == "db":
        return await _strikes_from_db(ref_dt, max_age_minutes)
    else:
        return await _strikes_from_files(ref_dt, key, max_age_minutes)


async def _strikes_from_db(ref_dt: Optional[datetime], max_age_minutes: int) -> JSONResponse:
    """Serve lightning strikes from the TimescaleDB `points` hypertable."""
    if ref_dt is None:
        ref_dt = await most_recent_time(_LIGHTNING_SOURCE)
        if ref_dt is None:
            raise HTTPException(404, "No lightning data in DB")

    t_end   = ref_dt
    t_start = ref_dt - timedelta(minutes=max_age_minutes)

    print(f"[DB] Lightning query: {t_start} → {t_end}")
    rows = await query_points(
        source_id=_LIGHTNING_SOURCE,
        start=t_start,
        end=t_end,
    )
    print(f"[DB] Returned {len(rows)} strikes")

    features = []
    for row in rows:
        vt = row["valid_time"]
        if isinstance(vt, datetime):
            if vt.tzinfo is None:
                vt = vt.replace(tzinfo=timezone.utc)
            age_min = (ref_dt.astimezone(timezone.utc) - vt.astimezone(timezone.utc)).total_seconds() / 60.0
        else:
            age_min = None

        props = row["properties"]
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
            "properties": {
                "peak_current_ka": props.get("peak_current_ka") or props.get("peak_current"),
                "age_minutes": round(age_min, 1) if age_min is not None else None,
            },
        })

    return JSONResponse({
        "type": "FeatureCollection",
        "metadata": {
            "reference_time": ref_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "max_age_minutes": max_age_minutes,
            "strikes_in_window": len(features),
            "data_source": "db",
        },
        "features": features,
    })


async def _strikes_from_files(ref_dt: Optional[datetime], key: Optional[str], max_age_minutes: int) -> JSONResponse:
    """Serve lightning strikes by reading flat files (original behaviour)."""
    file_source = get_source(_LIGHTNING_SOURCE)

    if ref_dt is None:
        if key is None:
            latest = await file_source.most_recent()
            if latest is None:
                raise HTTPException(404, "No lightning data available")
            key = latest.key
        ref_dt = _parse_key_to_dt(key)

    print(f"[file] Finding strikes between: {ref_dt - timedelta(minutes=max_age_minutes)} and {ref_dt}")
    times = await file_source.list_times(
        before=ref_dt,
        after=ref_dt - timedelta(minutes=max_age_minutes),
    )
    print(f"[file] Found {len(times)} files")

    features = []
    total_count = 0
    reader = AcadLtngReader()

    for t in times:
        var_map = {
            "peak_current_ka": "peak_current",
            "polarity": "multiplicity",
            "time": "second",
        }
        result = await reader.read_points(t.path, var_map)
        total_count += len(result.points)
        for pt in result.points:
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [pt["lon"], pt["lat"]]},
                "properties": {
                    "peak_current_ka": pt.get("peak_current"),
                    "age_minutes": round(pt.get("time"), 1),
                },
            })

    print(f"[file] Strikes in window: {len(features)}, total in files: {total_count}")
    return JSONResponse({
        "type": "FeatureCollection",
        "metadata": {
            "reference_time": ref_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "max_age_minutes": max_age_minutes,
            "total_strikes": total_count,
            "strikes_in_window": len(features),
            "data_source": "file",
        },
        "features": features,
    })
