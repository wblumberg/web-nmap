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

GET /api/v1/geometries/spc_outlook/day/{day_number}
    → SPC convective outlook for day 1, 2, or 3 (specialized endpoint)
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Path, Query
from fastapi.responses import JSONResponse

from ..sources.registry import get_source
from ..readers import get_reader

router = APIRouter(tags=["Geometry Data"])


@router.get("/{source_id}/features")
async def get_geometry_features(
    source_id    : str,
    key          : Optional[str] = Query(None, description="Valid time key"),
    bbox         : Optional[str] = Query(None, description="lon_min,lat_min,lon_max,lat_max"),
    event_type   : Optional[str] = Query(None,
                                  description="Filter by event type, e.g. 'Tornado Warning'"),
    simplify_deg : Optional[float] = Query(None, ge=0.0001, le=1.0,
                                  description="Simplify polygon vertices to this tolerance "
                                              "in degrees. Reduces payload size for small screens."),
):
    """
    Return a GeoJSON FeatureCollection of polygon/polyline geometries.

    Works for watches/warnings, SPC outlooks, fronts, and any other
    source registered as a 'geometry' type.

    The `simplify_deg` parameter is useful when serving to mobile devices
    or when overlaying many polygons at low zoom — it reduces the number
    of vertices without changing the visual appearance significantly.
    A value of 0.01 (≈1km) is a good default for most use cases.
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

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
    source_id  : str,
    type_name  : str           = Query(..., description="e.g. 'Tornado Warning', 'moderate'"),
    key        : Optional[str] = Query(None),
    bbox       : Optional[str] = Query(None),
):
    """
    Return only geometries matching a specific type.

    Shortcut for: GET /features?event_type={type_name}
    """
    return await get_geometry_features(
        source_id  = source_id,
        key        = key,
        bbox       = bbox,
        event_type = type_name,
    )


@router.get("/spc_outlook/day/{day_number}")
async def get_spc_outlook(
    day_number : int            = Path(..., ge=1, le=3),
    risk_type  : Optional[str]  = Query(None,
                                  description="'categorical','tornado','wind','hail'"),
    key        : Optional[str]  = Query(None),
):
    """
    Return SPC Convective Outlook polygons for day 1, 2, or 3.

    risk_type options for day 1:
        categorical: TSTM, MRGL, SLGT, ENH, MDT, HIGH
        tornado:     0.02, 0.05, 0.10, 0.15, 0.30, 0.45, 0.60, sig (hatching)
        wind:        0.05, 0.15, 0.25, 0.35, 0.45, 0.60, sig
        hail:        0.05, 0.15, 0.25, 0.35, 0.45, 0.60, sig

    This is the specialized endpoint for SPC probabilistic forecasts
    — the kind of products you want to replicate in WebNMAP's product
    generation system.
    """
    source_id = f"SPC_DAY{day_number}_OUTLOOK"
    try:
        source = get_source(source_id)
    except KeyError:
        raise HTTPException(
            404,
            f"SPC Day {day_number} outlook source not configured. "
            f"Add '{source_id}' to api/sources/registry.py"
        )

    return await get_geometry_features(
        source_id  = source_id,
        key        = key,
        bbox       = None,
        event_type = risk_type,
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
