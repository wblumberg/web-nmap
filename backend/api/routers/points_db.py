"""
routers/points_db.py — DB-backed point observation endpoints

Serves point data from the `points` TimescaleDB hypertable (lightning,
AirNow, and any other source ingested via the ingest pipeline).

─── Endpoint ────────────────────────────────────────────────────────────────

GET /api/v1/db-points/{source_id}
    Returns a time-windowed set of point observations.

    Query params:
        center          ISO 8601 or YYYYMMDD_HHMM — centre of the time window.
                        Defaults to the most recently ingested valid_time.
        window_minutes  Window ± around centre (default 60, max 1440).
        start / end     Explicit ISO 8601 UTC range (overrides center+window).
        bbox            lon_min,lat_min,lon_max,lat_max
        limit           Max rows (default 100 000, hard cap 500 000).
        format          "proto" (default) or "geojson".

    Responses:
        proto   → StreamingResponse  application/x-protobuf  PointResponse
        geojson → JSONResponse        application/json        GeoJSON FeatureCollection

─── Protobuf layout ─────────────────────────────────────────────────────────

    PointResponse {
        source_id, start_time, end_time, count,
        points: [ PointObs { lat, lon, valid_time,
                              variables: {float fields},
                              metadata:  {str fields} }, ... ],
        metadata: { window_minutes, bbox, ... }
    }

Numeric properties from the JSONB `properties` column go into
``PointObs.variables``; everything else goes into ``PointObs.metadata``.

TODO: Require SOURCE_ID to essential to finding the points.
TODO: Add obs binning capability to return most recent obs per station using a time window (with defaults).
TODO: Add a query filter to pull only points with certain variable keys (e.g. "peak_current_ka" for lightning).
TODO: Add the ability to also return the age of each observation in minutes (relative to the reference time) as a variable.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from ..services.points_sql import query_points, most_recent_time
from ..utils.time_helper import _parse_key_to_dt

# ─── Protobuf imports ─────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'proto'))
from wxdata_pb2 import PointObs, PointResponse   # noqa: E402

router = APIRouter(tags=["DB Points"])

_ISO_FMT = "%Y-%m-%dT%H:%M:%SZ"


def _to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime(_ISO_FMT)


def _parse_bbox(bbox_str: Optional[str]) -> Optional[tuple]:
    if not bbox_str:
        return None
    try:
        parts = [float(x) for x in bbox_str.split(",")]
        if len(parts) != 4:
            return None
        return tuple(parts)   # (lon_min, lat_min, lon_max, lat_max)
    except ValueError:
        return None


def _split_properties(props: dict) -> tuple[dict, dict]:
    """Split a properties dict into numeric (variables) and string (metadata) maps."""
    variables: dict[str, float] = {}
    metadata:  dict[str, str]   = {}
    for k, v in props.items():
        if isinstance(v, (int, float)) and v == v:   # exclude NaN
            variables[str(k)] = float(v)
        elif v is not None:
            metadata[str(k)] = str(v)
    return variables, metadata


def _rows_to_protobuf(
    rows: list[dict],
    source_id: str,
    start: datetime,
    end: datetime,
    extra_meta: dict[str, str] | None = None,
) -> bytes:
    pb = PointResponse(
        source_id=source_id,
        start_time=_to_iso(start),
        end_time=_to_iso(end),
        count=len(rows),
    )
    if extra_meta:
        for k, v in extra_meta.items():
            pb.metadata[k] = v

    for row in rows:
        variables, meta = _split_properties(row["properties"])
        vt = row["valid_time"]
        vt_str = _to_iso(vt) if isinstance(vt, datetime) else str(vt)
        obs = PointObs(
            lat=row["lat"],
            lon=row["lon"],
            valid_time=vt_str,
        )
        obs.variables.update(variables)
        obs.metadata.update(meta)
        pb.points.append(obs)

    return pb.SerializeToString()


def _rows_to_geojson(
    rows: list[dict],
    source_id: str,
    start: datetime,
    end: datetime,
    extra_meta: dict[str, str] | None = None,
) -> dict:
    features = []
    for row in rows:
        vt = row["valid_time"]
        vt_str = _to_iso(vt) if isinstance(vt, datetime) else str(vt)
        props = {"valid_time": vt_str, **row["properties"]}
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
            "properties": props,
        })
    return {
        "type": "FeatureCollection",
        "metadata": {
            "source_id": source_id,
            "start_time": _to_iso(start),
            "end_time": _to_iso(end),
            "count": len(rows),
            **(extra_meta or {}),
        },
        "features": features,
    }


### Endpoint to get the data from the TimescaleDB
@router.get("/{source_id}")
async def get_db_points(
    request        : Request,
    source_id      : str,
    center         : Optional[str] = Query(None,
                        description="Centre of the time window. "
                                    "ISO 8601 or YYYYMMDD_HHMM. Defaults to most recent."),
    window_minutes : int = Query(60, ge=1, le=1440,
                        description="Half-width of the time window in minutes."),
    start          : Optional[str] = Query(None,
                        description="Explicit window start (ISO 8601 UTC). "
                                    "Overrides center+window_minutes."),
    end            : Optional[str] = Query(None,
                        description="Explicit window end (ISO 8601 UTC). "
                                    "Overrides center+window_minutes."),
    bbox           : Optional[str] = Query(None,
                        description="Spatial filter: lon_min,lat_min,lon_max,lat_max"),
    limit          : int = Query(100_000, ge=1, le=500_000,
                        description="Maximum number of points to return."),
    fmt            : Optional[str] = Query(None, alias="format",
                        description="Response format: 'proto' (default) or 'geojson'."),
):
    """Return time-windowed point observations from the TimescaleDB `points` table."""

    # ── Resolve time window ───────────────────────────────────────────────────
    if start and end:
        t_start = _parse_key_to_dt(start)
        t_end   = _parse_key_to_dt(end)
        if t_start is None or t_end is None:
            raise HTTPException(422, "Cannot parse start/end times")
    else:
        if center:
            center_dt = _parse_key_to_dt(center)
            if center_dt is None:
                raise HTTPException(422, f"Cannot parse center time '{center}'")
        else:
            center_dt = await most_recent_time(source_id)
            if center_dt is None:
                raise HTTPException(404, f"No data in DB for source '{source_id}'")
        delta   = timedelta(minutes=window_minutes)
        t_start = center_dt - delta
        t_end   = center_dt + delta

    # ── Spatial filter ────────────────────────────────────────────────────────
    parsed_bbox = _parse_bbox(bbox)

    # ── Query DB ──────────────────────────────────────────────────────────────
    try:
        rows = await query_points(
            source_id=source_id.upper(),
            start=t_start,
            end=t_end,
            bbox=parsed_bbox,
            limit=limit,
        )
    except Exception as e:
        raise HTTPException(500, f"DB query failed: {e}")

    extra_meta = {
        "window_minutes": str(window_minutes),
        "bbox": bbox or "none",
    }

    # ── Format response ───────────────────────────────────────────────────────
    use_proto = (fmt or "proto").lower() == "proto"
    # Also honour Accept header for content negotiation
    if "application/x-protobuf" in request.headers.get("accept", ""):
        use_proto = True
    if fmt and fmt.lower() == "geojson":
        use_proto = False

    if use_proto:
        payload = _rows_to_protobuf(rows, source_id, t_start, t_end, extra_meta)
        return StreamingResponse(
            iter([payload]),
            media_type="application/x-protobuf",
            headers={
                "X-Point-Count": str(len(rows)),
                "X-Source-Id": source_id,
            },
        )
    else:
        return JSONResponse(
            _rows_to_geojson(rows, source_id, t_start, t_end, extra_meta),
            headers={"X-Point-Count": str(len(rows))},
        )
