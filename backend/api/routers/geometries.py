"""
routers/geometries.py — Geometry (Polygon/Polyline) Endpoints

Serves vector geometry datasets:
  - NWS Watches, Warnings, Advisories (polygon FeatureCollections)
  - SPC Convective Outlooks (tornado/wind/hail, day 1-3)
  - Surface frontal analysis (line FeatureCollections)
  - NHC tropical cyclone track/cone (line + polygon)
  - CPC climate outlooks (polygon FeatureCollections)
  - Mesoscale discussion polygons (SPC, WPC)
  - Political/geographic boundaries (state lines, county borders)
  - User-drawn product generation polygons (NMAP2-style products)

─── Endpoints ───────────────────────────────────────────────────────────────

GET /api/v1/geometries/{source_id}/features
    → GeoJSON FeatureCollection (latest or by key)

GET /api/v1/geometries/{source_id}/by_type
    → Filter by geometry/event type (e.g. only TORNADO WARNING)

"""

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import JSONResponse

from ..sources.registry import get_source
from ..readers import get_reader
from ..utils.time_helper import _parse_key_to_dt
from ..services.alerts_sql import (
    ALERT_PHEN_LABELS,
    query_alerts_geojson, query_alerts_geojson_unioned, resolve_phen,
)

router = APIRouter(tags=["Geometry Data"])


@router.get("/alerts/types", summary="List available alert phenomenon types")
async def list_alert_types():
    """Return all VTEC phenomenon codes and their human-readable labels.

    Use the ``phen`` slug or 2-letter code as the ``?phen=`` query parameter
    on the ``/features`` endpoint to filter a watch/warning/advisory source
    to a specific phenomenon type.

    Example: ``GET /geometries/alerts_warnings/features?at=...&phen=tornado``
    """
    return {
        code: {
            "label": label,
            "slug":  label.lower().replace(" ", "_"),
        }
        for code, label in sorted(ALERT_PHEN_LABELS.items())
    }


@router.get("/{source_id}/features")
async def get_geometry_features(
    source_id    : str,
    key          : Optional[str] = Query(None, description="Valid time key (filesystem sources)"),
    bbox         : Optional[str] = Query(None, description="lon_min,lat_min,lon_max,lat_max"),
    event_type   : Optional[str] = Query(None,
                                  description="Filter by event type, e.g. 'Tornado Warning' "
                                              "(filesystem sources only)"),
    at           : Optional[str] = Query(None,
                                  description="ISO-8601 valid time for DB alert sources. "
                                              "Defaults to current UTC time. "
                                              "E.g. 2026-04-07T22:00:00Z"),
    phen         : Optional[str] = Query(None,
                                  description="Filter alert source by phenomenon type. "
                                              "Accepts a 2-letter VTEC code (e.g. 'TO') or a "
                                              "slug (e.g. 'tornado', 'severe_thunderstorm'). "
                                              "See GET /geometries/alerts/types for the full list."),
    simplify_deg : Optional[float] = Query(None, ge=0.0001, le=1.0,
                                  description="Simplify polygon vertices to this tolerance "
                                              "in degrees. Reduces payload size for small screens."),
):
    """
    Return a GeoJSON FeatureCollection of polygon/polyline geometries.

    **DB-backed alert sources** (``alerts_warnings``, ``alerts_watches``,
    ``alerts_advisories``): query by valid time and optionally filter to a
    specific phenomenon type. See ``GET /geometries/alerts/types`` for the
    list of available phenomenon slugs.

    **Filesystem sources** (SPC outlooks, fronts, etc.): use ``key`` to
    select a time step, or omit for the most recent.
    """
    # ── Resolve source ────────────────────────────────────────────────────
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # ── DB-backed alert sources ───────────────────────────────────────────
    if getattr(source, "source_type", None) == "MISC":
        sig = source.sig
        parsed_bbox = _parse_bbox(bbox)

        if at is not None:
            try:
                at_dt = datetime.fromisoformat(at.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(400, f"Invalid 'at' datetime: {at!r}")
        elif key is not None:
            at_dt = _parse_key_to_dt(key)
            if at_dt is None:
                raise HTTPException(400, f"Cannot parse 'key' as a datetime: {key!r}")
        else:
            at_dt = datetime.now(timezone.utc)

        # For DB alert sources, event_type (forwarded from by_type's type_name)
        # is the same concept as phen.  Fall back to it when phen isn't set.
        phen_effective = phen if phen is not None else event_type
        try:
            phen_code = resolve_phen(phen_effective)
        except ValueError as e:
            raise HTTPException(400, str(e))

        try:
            fc = await query_alerts_geojson(
                sig=sig, at=at_dt, phen=phen_code, bbox=parsed_bbox
            )
        except Exception as e:
            raise HTTPException(500, f"DB query error: {e}")

        if simplify_deg is not None:
            fc["features"] = [
                _simplify_feature(f, simplify_deg) for f in fc["features"]
            ]
        print(fc)
        return JSONResponse(fc)

    # ── Filesystem-backed sources (existing logic) ────────────────────────

    if key is None:
        latest = await source.most_recent()
        if latest is None:
            raise HTTPException(404, f"No data for '{source_id}'")
        key = latest.key

    path = await source.get_path(key)
    if path is None:
        raise HTTPException(404, f"No file for '{source_id}' key '{key}'")

    parsed_bbox = _parse_bbox(bbox)
    var_map     = getattr(source, 'variable_map', {})

    reader = get_reader(path)
    try:
        result = await reader.read_geometries(
            path    = path,
            var_map = var_map,
            bbox    = parsed_bbox,
        )
    except NotImplementedError:
        raise HTTPException(400, f"Source '{source_id}' does not support geometry reads")
    except Exception as e:
        raise HTTPException(500, f"Read error: {e}")

    # Filter by event type
    if event_type is not None:
        et_lower = event_type.lower()
        result.features = [
            f for f in result.features
            if et_lower in str(f.get("properties", {}).get("event", "")).lower()
            or et_lower in str(f.get("properties", {}).get("type",  "")).lower()
        ]

    # Simplify geometries if requested
    if simplify_deg is not None:
        result.features = [_simplify_feature(f, simplify_deg)
                           for f in result.features]

    return JSONResponse(result.as_geojson())


@router.get("/{source_id}/by_type")
async def get_geometries_by_type(
    source_id    : str,
    type_name    : str            = Query(..., description="e.g. 'Tornado Warning', 'moderate'"),
    key          : Optional[str]  = Query(None),
    at           : Optional[str]  = Query(None),
    phen         : Optional[str]  = Query(None),
    bbox         : Optional[str]  = Query(None),
    simplify_deg : Optional[float] = Query(None, ge=0.0001, le=1.0,
                                   description="Simplify tolerance in degrees."),
):
    """
    Return only geometries matching a specific type.

    For DB-backed alert sources (WATCHES, WARNINGS, ADVISORIES), all CWA
    polygons sharing the same event number (etn) are unioned via PostGIS
    ``ST_MakeValid(ST_Union(geom))``, returning one clean feature per event.
    This avoids self-touching rings that break WebGL ear-clip triangulation.

    For filesystem sources (SPC outlooks, fronts, etc.) the call falls back
    to the standard ``/features?event_type=`` filter.
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # ── DB-backed alert sources: union in PostGIS ─────────────────────────
    if getattr(source, "source_type", None) == "MISC":
        sig         = source.sig
        parsed_bbox = _parse_bbox(bbox)

        if at is not None:
            try:
                at_dt = datetime.fromisoformat(at.replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(400, f"Invalid 'at' datetime: {at!r}")
        elif key is not None:
            at_dt = _parse_key_to_dt(key)
            if at_dt is None:
                raise HTTPException(400, f"Cannot parse 'key' as a datetime: {key!r}")
        else:
            at_dt = datetime.now(timezone.utc)

        # type_name doubles as the phen filter for alert sources
        phen_effective = phen if phen is not None else type_name
        try:
            phen_code = resolve_phen(phen_effective)
        except ValueError as e:
            raise HTTPException(400, str(e))

        try:
            fc = await query_alerts_geojson_unioned(
                sig=sig, at=at_dt, phen=phen_code, bbox=parsed_bbox,
            )
        except Exception as e:
            raise HTTPException(500, f"DB query error: {e}")

        if simplify_deg is not None:
            fc["features"] = [
                _simplify_feature(f, simplify_deg) for f in fc["features"]
            ]

        return JSONResponse(fc)

    # ── Filesystem sources: delegate to /features with event_type filter ──
    return await get_geometry_features(
        source_id  = source_id,
        key        = key,
        at         = at,
        phen       = phen,
        bbox       = bbox,
        event_type = type_name,
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _parse_bbox(bbox_str: str | None):
    if bbox_str is None:
        return None
    try:
        parts = [float(x) for x in bbox_str.split(",")]
        return tuple(parts) if len(parts) == 4 else None
    except ValueError:
        return None


def _simplify_feature(feature: dict, tolerance: float) -> dict:
    """
    Simplify the geometry of a GeoJSON Feature using the Ramer-Douglas-Peucker
    algorithm. Requires the 'shapely' package (optional dependency).
    Falls back to returning the original feature unchanged if shapely is absent.
    """
    try:
        from shapely.geometry import shape, mapping
        geom = shape(feature["geometry"])
        simplified = geom.simplify(tolerance, preserve_topology=True)
        return {**feature, "geometry": mapping(simplified)}
    except Exception:
        return feature
