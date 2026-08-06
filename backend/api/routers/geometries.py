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
from ..sources.types.db_source import (
    AlertSource, AircraftTrackDBSource, CycloneTrackDBSource,
)
from ..readers import get_reader
from ..utils.time_helper import _parse_key_to_dt
from ..services.alerts_sql import (
    ALERT_PHEN_LABELS,
    query_alerts_geojson, query_alerts_geojson_unioned, resolve_phen,
)
from ..services.atcf_sql import query_atcf_tracks_geojson
from ..services.aircraft_sql import query_aircraft_tracks_geojson
from ..services.aircraft_sql import MAJOR_CARRIER_CODES

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
    cycle        : Optional[str] = Query(None, description="Cycle key for track sources (YYYYMMDDHH or ISO datetime)."),
    fhr          : Optional[int] = Query(None, description="Forecast hour filter for track sources."),
    storm_id     : Optional[str] = Query(None, description="Storm identifier filter for track sources."),
    basin        : Optional[str] = Query(None, description="Basin filter for track sources (e.g. AL, EP, WP)."),
    model        : Optional[str] = Query(None, description="Model filter for track sources (e.g. OFCL, HWRF)."),
    model_prefix : Optional[str] = Query(None, description="Model prefix filter for track sources (e.g. 'AP' matches AP00, AP01 …)."),
    exclude_best : bool           = Query(False, description="When true, exclude the BEST track from ATCF results."),
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
    window_minutes: int = Query(30, ge=1, le=180,
                                  description="Trailing window for aircraft tracks."),
    airports      : Optional[str] = Query(None,
                                  description="Comma-separated ICAO/IATA airport identifiers."),
    carriers      : Optional[str] = Query(None,
                                  description="Comma-separated ICAO carrier codes, or 'major'."),
    operation     : str = Query("both",
                                  description="Aircraft filter: arrival, departure, or both."),
    max_positions : int = Query(250_000, ge=1_000, le=500_000,
                                  description="Maximum aircraft positions considered."),
    max_implied_speed_kt: float = Query(750.0, ge=100, le=2000,
                                  description="Split aircraft tracks above this implied speed."),
    max_gap_minutes: int = Query(10, ge=1, le=60,
                                  description="Split aircraft tracks across larger time gaps."),
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
    if isinstance(source, AlertSource):
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

    # ── DB-backed FAA aircraft tracks ────────────────────────────────────
    if isinstance(source, AircraftTrackDBSource):
        parsed_bbox = _parse_bbox(bbox)
        if at is not None:
            end_dt = _parse_key_to_dt(at)
        elif key is not None:
            end_dt = _parse_key_to_dt(key)
        else:
            latest = await source.most_recent()
            end_dt = latest.valid_time if latest else None
        if end_dt is None:
            raise HTTPException(404, f"No track data for '{source_id}'")

        airport_list = None
        if airports:
            airport_list = []
            for airport in airports.split(","):
                normalized = airport.strip().upper()
                if not normalized:
                    continue
                if not (3 <= len(normalized) <= 4 and normalized.isalnum()):
                    raise HTTPException(
                        422, f"Invalid airport identifier {airport!r}"
                    )
                airport_list.append(normalized)
            airport_list = list(dict.fromkeys(airport_list))

        carrier_list = None
        if carriers:
            if carriers.strip().lower() == "major":
                carrier_list = sorted(MAJOR_CARRIER_CODES)
            else:
                carrier_list = []
                for carrier in carriers.split(","):
                    normalized = carrier.strip().upper()
                    if not normalized:
                        continue
                    if len(normalized) != 3 or not normalized.isalnum():
                        raise HTTPException(
                            422, f"Invalid ICAO carrier code {carrier!r}"
                        )
                    carrier_list.append(normalized)
                carrier_list = list(dict.fromkeys(carrier_list))

        try:
            fc = await query_aircraft_tracks_geojson(
                end=end_dt,
                window_minutes=window_minutes,
                airports=airport_list,
                carriers=carrier_list,
                operation=operation,
                bbox=parsed_bbox,
                max_positions=max_positions,
                max_implied_speed_kt=max_implied_speed_kt,
                max_gap_minutes=max_gap_minutes,
            )
        except ValueError as error:
            raise HTTPException(422, str(error))
        except Exception as error:
            raise HTTPException(500, f"DB query error: {error}")
        return JSONResponse(fc)

    # ── DB-backed ATCF track sources ─────────────────────────────────────
    if isinstance(source, CycloneTrackDBSource):
        parsed_bbox = _parse_bbox(bbox)

        cycle_dt = _parse_cycle_param(cycle)
        if cycle_dt is None and key and "_f" in key:
            cycle_dt = _parse_cycle_param(key.split("_f", 1)[0])

        fhr_effective = fhr
        if fhr_effective is None and key and "_f" in key:
            try:
                fhr_effective = int(key.split("_f", 1)[1][:3])
            except ValueError:
                fhr_effective = None

        if cycle_dt is None:
            latest = await source.most_recent()
            if latest is None:
                raise HTTPException(404, f"No track data for '{source_id}'")
            cycle_dt = _parse_cycle_param(latest.key)

        if cycle_dt is None:
            raise HTTPException(400, "Could not resolve a cycle time for ATCF track query")

        try:
            fc = await query_atcf_tracks_geojson(
                source_id=source.source_id,
                cycle_time=cycle_dt,
                fhr=fhr_effective,
                storm_id=storm_id,
                basin=basin,
                model=model,
                model_prefix=model_prefix,
                exclude_best=exclude_best,
                bbox=parsed_bbox,
            )
        except Exception as e:
            raise HTTPException(500, f"DB query error: {e}")

        if simplify_deg is not None:
            fc["features"] = [
                _simplify_feature(f, simplify_deg) for f in fc["features"]
            ]
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
    if isinstance(source, AlertSource):
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
    """Parse a comma-separated geographic bounding box."""
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


def _parse_cycle_param(value: str | None) -> datetime | None:
    """Parse cycle param."""
    if value is None:
        return None
    s = value.strip()
    if len(s) == 10 and s.isdigit():
        return datetime.strptime(s, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    return _parse_key_to_dt(s)
