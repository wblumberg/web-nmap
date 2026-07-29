"""DB-backed profile observation endpoints.

Serves vertical profile observations from the `profiles` TimescaleDB hypertable.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse

from ..sources.registry import SOURCES
from ..services.profiles_sql import query_profiles, most_recent_time
from ..utils.time_helper import _parse_key_to_dt

router = APIRouter(tags=["DB Profiles"])


def _parse_bbox(bbox_str: Optional[str]) -> Optional[tuple[float, float, float, float]]:
    if not bbox_str:
        return None
    try:
        parts = [float(x) for x in bbox_str.split(",")]
        if len(parts) != 4:
            return None
        return tuple(parts)  # type: ignore[return-value]
    except ValueError:
        return None


def _to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@router.get("/{source_id}")
async def get_db_profiles(
    source_id: str,
    center: Optional[str] = Query(None, description="ISO 8601 or YYYYMMDD_HHMM center time"),
    window_minutes: Optional[int] = Query(None, ge=1, le=4320),
    before_minutes: Optional[int] = Query(None, ge=0, le=4320),
    after_minutes: Optional[int] = Query(None, ge=0, le=4320),
    start: Optional[str] = Query(None, description="Explicit start datetime"),
    end: Optional[str] = Query(None, description="Explicit end datetime"),
    bbox: Optional[str] = Query(None, description="lon_min,lat_min,lon_max,lat_max"),
    limit: int = Query(5000, ge=1, le=200000),
):
    """Return profile observations in a time window as JSON."""

    src = SOURCES.get(source_id.upper())
    src_before = getattr(src, "before_minutes", None)
    src_after = getattr(src, "after_minutes", None)
    src_use_most_recent = getattr(src, "use_most_recent_filter", False)
    src_most_recent_by = getattr(src, "most_recent_by", "station_id")

    if start and end:
        t_start = _parse_key_to_dt(start)
        t_end = _parse_key_to_dt(end)
        if t_start is None or t_end is None:
            raise HTTPException(422, "Cannot parse start/end times")
    else:
        if center:
            center_dt = _parse_key_to_dt(center)
            if center_dt is None:
                raise HTTPException(422, f"Cannot parse center time '{center}'")
        else:
            center_dt = await most_recent_time(source_id.upper())
            if center_dt is None:
                raise HTTPException(404, f"No profile data for source '{source_id}'")

        if center_dt.tzinfo is None:
            center_dt = center_dt.replace(tzinfo=timezone.utc)

        # Priority:
        # 1) explicit before/after query params
        # 2) symmetric window_minutes query param
        # 3) source defaults (before_minutes/after_minutes)
        # 4) final fallback to symmetric +/-180
        if before_minutes is not None or after_minutes is not None:
            b = before_minutes if before_minutes is not None else (src_before if src_before is not None else 180)
            a = after_minutes if after_minutes is not None else (src_after if src_after is not None else 0)
            t_start = center_dt - timedelta(minutes=b)
            t_end = center_dt + timedelta(minutes=a)
        elif window_minutes is not None:
            delta = timedelta(minutes=window_minutes)
            t_start = center_dt - delta
            t_end = center_dt + delta
        elif src_before is not None or src_after is not None:
            b = src_before if src_before is not None else 180
            a = src_after if src_after is not None else 0
            t_start = center_dt - timedelta(minutes=b)
            t_end = center_dt + timedelta(minutes=a)
        else:
            delta = timedelta(minutes=180)
            t_start = center_dt - delta
            t_end = center_dt + delta

    parsed_bbox = _parse_bbox(bbox)

    try:
        rows = await query_profiles(
            source_id=source_id.upper(),
            start=t_start,
            end=t_end,
            bbox=parsed_bbox,
            limit=limit,
            most_recent_only=bool(src_use_most_recent),
            most_recent_by=src_most_recent_by,
        )
    except Exception as exc:
        raise HTTPException(500, f"DB query failed: {exc}")

    features = []
    for row in rows:
        vt = row["valid_time"]
        vt_str = _to_iso(vt) if isinstance(vt, datetime) else str(vt)
        props = {
            "station_id": row.get("station_id"),
            "valid_time": vt_str,
            "profile": row.get("profile", {}),
            **(row.get("metadata", {}) or {}),
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
            "properties": props,
        })

    return JSONResponse({
        "type": "FeatureCollection",
        "metadata": {
            "source_id": source_id.upper(),
            "start_time": _to_iso(t_start),
            "end_time": _to_iso(t_end),
            "count": len(features),
            "window_minutes": window_minutes,
            "before_minutes": before_minutes if before_minutes is not None else src_before,
            "after_minutes": after_minutes if after_minutes is not None else src_after,
            "most_recent_only": bool(src_use_most_recent),
            "most_recent_by": src_most_recent_by,
            "bbox": bbox or "none",
        },
        "features": features,
    })
