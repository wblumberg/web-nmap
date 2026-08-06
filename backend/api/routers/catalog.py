"""
routers/catalog.py — Data Catalog Endpoints  (expanded)

New endpoints added:
  GET /api/v1/catalog/{source_id}/cycles
      → List available model init cycles (e.g. 2025030200, 2025030206, ...)

  GET /api/v1/catalog/{source_id}/cycles/latest
      → The most recent available cycle

  GET /api/v1/catalog/{source_id}/cycles/{cycle}/fhrs
      → List forecast hours available on disk for a specific cycle

  GET /api/v1/catalog/{source_id}/cycles/{cycle}/fhrs/range
      → First fhr, last fhr, and step for a cycle (compact summary)

  GET /api/v1/catalog/{source_id}/grid_info
      → The grid descriptor for a source (so JS never has to hardcode ni/nj/dx/dy)

  GET /api/v1/catalog/{source_id}/times          (unchanged)
  GET /api/v1/catalog/{source_id}/times/latest   (unchanged)
  GET /api/v1/catalog/{source_id}/times/nearest  (unchanged)
  GET /api/v1/catalog/sources                    (unchanged)
"""

from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request

from ..readers import get_reader
from ..sources.registry import SOURCES, get_source
from ..services.catalog_inventory import list_times_cached, most_recent_cached
from ..services.dataset_status import get_dataset_status

router = APIRouter(tags=["Catalog"])


# ─── Source listing ───────────────────────────────────────────────────────────

@router.get("/status")
async def dataset_status(
    refresh: bool = Query(False, description="Bypass the short-lived status cache"),
):
    """Check availability and freshness of every configured dataset."""
    return await get_dataset_status(force=refresh)

@router.get("/sources")
async def list_sources():
    """
    List all configured data sources with their metadata.

    Returns source_id, label, data_category, and whether cycles/fhrs apply.
    The JavaScript side calls this once on startup to populate the source
    selection UI and to know which endpoints to use for each source.
    """
    return {
        "sources": [
            {
                "source_id"    : src.source_id,
                "label"        : src.label,
                "data_category": getattr(src, 'data_category', 'unknown'),
                "source_type"  : getattr(src, 'source_type', 'unknown'),
                "has_cycles"   : src.cycle_regex is not None,
                "has_fhrs"     : src.fhr_regex   is not None,
                "default_selected": getattr(src, 'default_selected', False),
                "timeline_hours": getattr(src, 'timeline_hours', None),
                "regions": getattr(src, 'regions', []),
                "source_group"  : getattr(src, 'source_group', src.source_id),  # for UI grouping, defaults to source_id
                "endpoint_type" : getattr(src, 'endpoint_type', 'gridded'),
                "zarr_transport": getattr(src, 'zarr_transport', False),
                "binflag": getattr(src, 'binflag', False),
                "before_minutes": getattr(src, 'before_minutes', None),
                "after_minutes": getattr(src, 'after_minutes', None),
                "use_most_recent_filter": getattr(src, 'use_most_recent_filter', False),
                "most_recent_by": getattr(src, 'most_recent_by', 'geom'),
                "return_age": getattr(src, 'return_age', False),
                # variable_map lets the zarr client resolve generic product key names
                # (e.g. "mean_MSLMA") to the on-disk zarr array names without a
                # server round-trip.  Empty dict means identity (name == zarr name).
                "variable_map"  : getattr(src, 'variable_map', {}),
            }
            for src in SOURCES.values()
        ]
    }


# ─── Valid-time listing (analysis / observation sources) ──────────────────────

@router.get("/{source_id}/times")
async def list_times(
    request   : Request,
    source_id : str,
    after     : Optional[str] = Query(None, description="ISO datetime lower bound"),
    before    : Optional[str] = Query(None, description="ISO datetime upper bound"),
    limit     : int           = Query(200, ge=1, le=2000),
):
    """
    List available valid times for a source, newest first.

    Use this for analysis / observation sources (MRMS, surface obs, lightning)
    that have no concept of model cycle or forecast hour.
    For NWP forecast sources use /cycles and /fhrs instead.
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    after_dt  = _parse_datetime(after)  if after  else None
    before_dt = _parse_datetime(before) if before else None
    passthrough = _extract_passthrough_query_params(
        request,
        exclude_keys={"after", "before", "limit"},
    )
    times = await list_times_cached(
        source,
        after=after_dt,
        before=before_dt,
        limit=limit,
        params=passthrough,
    )
    return {
        "source_id": source_id,
        "count"    : len(times),
        "times"    : [t.as_dict() for t in times],
    }


@router.get("/{source_id}/times/latest")
async def latest_time(request: Request, source_id: str):
    """Return the most recent available valid time for a source."""
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    passthrough = _extract_passthrough_query_params(request)
    latest = await most_recent_cached(source, params=passthrough)
    if latest is None:
        raise HTTPException(404, f"No data found for source '{source_id}'")

    return {"source_id": source_id, "latest": latest.as_dict()}


@router.get("/{source_id}/times/nearest")
async def nearest_time(
    request      : Request,
    source_id    : str,
    target       : str   = Query(..., description="Target key, e.g. 20250302_1800"),
    window_hours : float = Query(3.0),
):
    """Find the available time closest to `target`."""
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    target_dt = _parse_key(target)
    if target_dt is None:
        raise HTTPException(422, f"Cannot parse target key '{target}'")

    window = timedelta(hours=window_hours)
    passthrough = _extract_passthrough_query_params(
        request,
        exclude_keys={"target", "window_hours"},
    )
    times = await list_times_cached(
        source,
        after=target_dt - window,
        before=target_dt + window,
        limit=500,
        params=passthrough,
    )
    if not times:
        raise HTTPException(404, f"No times within ±{window_hours}h of {target}")

    target_ts = target_dt.timestamp()
    best      = min(times, key=lambda t: abs(t.valid_time.timestamp() - target_ts))
    delta_sec = abs(best.valid_time.timestamp() - target_ts)

    return {
        "source_id"     : source_id,
        "requested_key" : target,
        "matched_key"   : best.key,
        "matched_time"  : best.valid_time.isoformat() + "Z",
        "delta_minutes" : round(delta_sec / 60, 1),
    }


# ─── Cycle listing (NWP forecast sources) ────────────────────────────────────

@router.get("/{source_id}/cycles")
async def list_cycles(
    request   : Request,
    source_id : str,
    after     : Optional[str] = Query(None),
    before    : Optional[str] = Query(None),
    limit     : int           = Query(10, ge=1, le=100,
                                description="Max number of cycles to return (most-recent first)"),
):
    """
    List available model init cycles for a forecast source.

    A 'cycle' is a model initialization time — e.g. the GFS runs at
    00Z, 06Z, 12Z, and 18Z so there are up to 4 cycles per day.

    Each cycle has a set of forecast hours (fhrs) available on disk.
    Use the /fhrs endpoint to get the complete list for a given cycle.

    Example response:
        {
          "source_id": "RAP",
          "count": 3,
          "cycles": [
            { "cycle": "2025030218", "cycle_time": "2025-03-02T18:00:00Z",
              "fhr_count": 22, "fhr_min": 0, "fhr_max": 21 },
            { "cycle": "2025030212", "cycle_time": "2025-03-02T12:00:00Z",
              "fhr_count": 22, "fhr_min": 0, "fhr_max": 21 },
            { "cycle": "2025030206", "cycle_time": "2025-03-02T06:00:00Z",
              "fhr_count": 22, "fhr_min": 0, "fhr_max": 21 }
          ]
        }
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    if source.cycle_regex is None:
        raise HTTPException(
            400,
            f"Source '{source_id}' is not a forecast source (no cycle_regex configured). "
            f"Use /times instead."
        )

    #print(after, before)
    after_dt = _parse_datetime(after) if after else None  # after should be None or str, not Query
    before_dt = _parse_datetime(before) if before else None
    passthrough = _extract_passthrough_query_params(
        request,
        exclude_keys={"after", "before", "limit"},
    )

    # Get all available times — we'll group them by cycle
    all_times = await list_times_cached(
        source,
        after=after_dt,
        before=before_dt,
        limit=5000,
        params=passthrough,
    )
    ##print(f"Found {len(all_times)} times for source '{source_id}'")

    # Group by cycle string
    from collections import defaultdict
    by_cycle: dict[str, list] = defaultdict(list)
    for t in all_times:
        if t.cycle is not None:
            by_cycle[t.cycle].append(t)

    # Sort cycles newest-first and apply limit
    sorted_cycles = sorted(by_cycle.keys(), reverse=True)[:limit]

    cycles_out = []
    for cycle_str in sorted_cycles:
        fhrs = sorted([
            t.fhr for t in by_cycle[cycle_str] if t.fhr is not None
        ])
        if not fhrs:
            fhrs = await _infer_fhrs_for_cycle(source, cycle_str, by_cycle[cycle_str])
        cycle_dt = _parse_cycle(cycle_str)
        cycles_out.append({
            "cycle"      : cycle_str,
            "cycle_time" : cycle_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if cycle_dt else cycle_str,
            "fhr_count"  : len(fhrs),
            "fhr_min"    : min(fhrs) if fhrs else None,
            "fhr_max"    : max(fhrs) if fhrs else None,
            "fhrs"       : fhrs,      # full list included here so /fhrs is one fewer call
        })

    return {
        "source_id": source_id,
        "count"    : len(cycles_out),
        "cycles"   : cycles_out,
    }


@router.get("/{source_id}/cycles/latest")
async def latest_cycle(request: Request, source_id: str):
    """
    Return the most recently available model cycle and its forecast hours.

    This is what the JavaScript ViewManager calls when a forecast source
    is added — it needs to know which cycle to display and what fhrs
    are available to build the loop.

    Example response:
        {
          "source_id": "GFS",
          "cycle": "2025030212",
          "cycle_time": "2025-03-02T12:00:00Z",
          "fhrs": [0, 1, 2, 3, 6, 9, 12, 15, 18, 21, 24, ...],
          "fhr_min": 0,
          "fhr_max": 120,
          "fhr_count": 41
        }
    """
    result = await list_cycles(
        request=request,
        source_id=source_id,
        after=None,
        before=None,
        limit=1,
    )
    if not result["cycles"]:
        raise HTTPException(404, f"No cycles found for '{source_id}'")

    c = result["cycles"][0]
    return {
        "source_id" : source_id,
        "cycle"     : c["cycle"],
        "cycle_time": c["cycle_time"],
        "fhrs"      : c["fhrs"],
        "fhr_min"   : c["fhr_min"],
        "fhr_max"   : c["fhr_max"],
        "fhr_count" : c["fhr_count"],
    }


@router.get("/{source_id}/cycles/{cycle}/fhrs")
async def list_fhrs(
    request   : Request,
    source_id : str,
    cycle     : str,
    fhr_min   : Optional[int] = Query(None, description="Only return fhrs >= this value"),
    fhr_max   : Optional[int] = Query(None, description="Only return fhrs <= this value"),
):
    """
    List forecast hours available on disk for a specific model cycle.

    This is the endpoint that replaces hardcoded `available_fhrs` lists
    in views.js. Instead of:
        available_fhrs: [0, 1, 2, 3, 6, 9, 12, ...]

    The JavaScript side calls:
        GET /api/v1/catalog/RAP/cycles/2025030218/fhrs
    and gets back the real list of what is actually on disk.

    Query parameters `fhr_min` and `fhr_max` let the caller restrict the
    range — e.g. to only show the first 12 hours of a long-range model.

    Example response:
        {
          "source_id": "RAP",
          "cycle": "2025030218",
          "cycle_time": "2025-03-02T18:00:00Z",
          "fhrs": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
                   13, 14, 15, 16, 17, 18, 19, 20, 21],
          "fhr_min": 0,
          "fhr_max": 21,
          "fhr_count": 22,
          "keys": ["2025030218_f000", "2025030218_f001", ...]
        }
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    if source.cycle_regex is None:
        raise HTTPException(400, f"'{source_id}' is not a forecast source")

    # Fetch all times and filter to this cycle
    passthrough = _extract_passthrough_query_params(
        request,
        exclude_keys={"fhr_min", "fhr_max"},
    )
    all_times = await list_times_cached(source, limit=5000, params=passthrough)

    # The issue here with loading the GEM_RAP dataset is that the forecast hours are None because
    # all of the forecast data is kept in each file
    cycle_entries = [t for t in all_times if t.cycle == cycle]
    cycle_times = [t for t in cycle_entries if t.fhr is not None]

    if cycle_times:
        # Apply fhr range filter
        if fhr_min is not None:
            cycle_times = [t for t in cycle_times if t.fhr >= fhr_min]
        if fhr_max is not None:
            cycle_times = [t for t in cycle_times if t.fhr <= fhr_max]

        cycle_times.sort(key=lambda t: t.fhr)
        fhrs = [t.fhr for t in cycle_times]
        keys = [t.key for t in cycle_times]
    else:
        fhrs = await _infer_fhrs_for_cycle(source, cycle, cycle_entries)
        if not fhrs:
            raise HTTPException(404, f"No data found for '{source_id}' cycle '{cycle}'")

        if fhr_min is not None:
            fhrs = [h for h in fhrs if h >= fhr_min]
        if fhr_max is not None:
            fhrs = [h for h in fhrs if h <= fhr_max]

        keys = [f"{cycle}_f{str(h).zfill(3)}" for h in fhrs]
    cycle_dt   = _parse_cycle(cycle)

    return {
        "source_id" : source_id,
        "cycle"     : cycle,
        "cycle_time": cycle_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if cycle_dt else cycle,
        "fhrs"      : fhrs,
        "fhr_min"   : min(fhrs) if fhrs else None,
        "fhr_max"   : max(fhrs) if fhrs else None,
        "fhr_count" : len(fhrs),
        "keys"      : keys,
    }


@router.get("/{source_id}/cycles/{cycle}/fhrs/range")
async def fhr_range(
    request   : Request,
    source_id : str,
    cycle     : str,
):
    """
    Compact summary: first fhr, last fhr, count.

    Lighter-weight version of /fhrs for the UI to determine slider range
    without receiving the full fhr list.
    """
    result = await list_fhrs(request=request, source_id=source_id, cycle=cycle)
    return {
        "source_id" : source_id,
        "cycle"     : cycle,
        "fhr_min"   : result["fhr_min"],
        "fhr_max"   : result["fhr_max"],
        "fhr_count" : result["fhr_count"],
    }


# ─── Grid info ────────────────────────────────────────────────────────────────

@router.get("/{source_id}/grid_info")
async def get_grid_info(
    request   : Request,
    source_id : str,
    key       : Optional[str] = Query(None, description="Valid time key to inspect. "
                                            "Defaults to most recent."),
    variable  : Optional[str] = Query(None, description="Variable to inspect. "
                                            "Defaults to first variable in source."),
    cycle     : Optional[str] = Query(None, description="Model cycle (for forecast sources)"),
    fhr       : Optional[int] = Query(None, description="Forecast hour (for forecast sources)"),
):
    """
    Return the grid descriptor for a source.

    This keeps all grid geometry on the server side — the JavaScript
    ViewManager calls this once per source and uses the returned GridInfo
    to construct the autumnplot-gl Grid object.  No hardcoded ni/nj/dx/dy
    in views.js or any JS file.

    Example response:
        {
          "source_id": "RAP",
          "key": "2025030218_f000",
          "grid": {
            "grid_type":   "lambert",
            "ni":          451,
            "nj":          337,
            "lat_min":     21.14,
            "lat_max":     47.84,
            "lon_min":    -122.72,
            "lon_max":    -60.92,
            "dx":          13.545,
            "dy":          13.545,
            "proj_params": {
              "lat_0": 25.0,
              "lon_0": -95.0,
              "lat_1": 25.0,
              "lat_2": 25.0
            }
          }
        }

    The JavaScript side uses this like:
        const info = await fetchGridInfo('RAP');
        const grid = makeApglGrid(info.grid);  // in your grid factory helper
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    passthrough = _extract_passthrough_query_params(
        request,
        exclude_keys={"key", "variable", "cycle", "fhr"},
    )

    await list_times_cached(source, params=passthrough)

    # Resolve key
    if key is None and cycle is not None and fhr is not None:
        key = f"{cycle}_f{str(fhr).zfill(3)}"
    if key is None:
        latest = await most_recent_cached(source, params=passthrough)
        if latest is None:
            raise HTTPException(404, f"No data for '{source_id}'")
        key = latest.key

    path = await source.get_path(key)
    if path is None:
        # Try cycle key as fallback
        if cycle:
            path = await source.get_path(cycle)
    if path is None:
        raise HTTPException(404, f"No file for '{source_id}' key '{key}'")

    # Use the first mapped variable, or a default
    var_map  = getattr(source, 'variable_map', {})
    var_list = list(var_map.keys())
    if variable:
        var_list = [variable]
    elif not var_list:
        var_list = ['__first__']

    from ..readers import get_reader
    reader = get_reader(path)

    if variable is None:
        results = await reader.read_grid_info(path)
        print(results)
        return {
            "source_id": source_id,
            "key"      : key,
            "variable" : 'None',
            "grid"     : results.as_dict(),
        }

    try:
        # Read just one variable to extract grid info — don't decode data
        results = await reader.read_gridded(
            path    = path,
            var_map = {var_list[0]: var_map.get(var_list[0], var_list[0])},
            fhr     = fhr,
        )
    except NotImplementedError:
        raise HTTPException(400, f"'{source_id}' does not support gridded reads")
    except Exception as e:
        raise HTTPException(500, f"Grid info read error: {e}")

    if not results:
        raise HTTPException(404, f"Could not extract grid info from '{source_id}'")

    return {
        "source_id": source_id,
        "key"      : key,
        "variable" : var_list[0],
        "grid"     : results[0].grid.as_dict(),
    }

@router.get("/{source_id}/variables")
async def list_variables(source_id: str):
    """
    Return the full list of available variables for a data source.

    This allows the JavaScript side to populate variable selection dropdowns
    dynamically without hardcoding variable lists.

    Example response:
        {
          "source_id": "RAP",
          "variables": [
            {"name": "temperature", "label": "Temperature (K)"},
            {"name": "u_wind", "label": "U Wind (m/s)"},
            {"name": "v_wind", "label": "V Wind (m/s)"},
            ...
          ],
          "count": 42
        }
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    var_map = getattr(source, 'variable_map', {})
    variables = [
        {"name": var_name, "label": var_label}
        for var_name, var_label in var_map.items()
    ]

    return {
        "source_id": source_id,
        "variables": variables,
        "count": len(variables),
    }

# ─── Helpers ────────────────────────────────────────────────────────────���─────

def _parse_datetime(s: str) -> datetime:
    """Parse datetime."""
    from dateutil import parser as dtparser
    dt = dtparser.parse(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_key(key: str) -> datetime | None:
    """Parse key."""
    k = key.replace("_", "")
    for fmt in ("%Y%m%d%H%M", "%Y%m%d%H"):
        try:
            return datetime.strptime(k, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _parse_cycle(cycle: str) -> datetime | None:
    """Parse a cycle string like '2025030218' to a datetime."""
    for fmt in ("%Y%m%d%H", "%Y%m%d%H%M"):
        try:
            return datetime.strptime(cycle, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


async def _infer_fhrs_for_cycle(source, cycle: str, cycle_entries: list) -> list[int]:
    """
    Infer forecast hours for a cycle from file contents when filenames do not
    encode fhr (e.g. one Zarr store per cycle with a time axis).
    """
    path = next((t.path for t in cycle_entries if t.path is not None), None)
    if path is None:
        path = await source.get_path(cycle)
    if path is None:
        return []

    try:
        reader = get_reader(path)
    except Exception:
        return []

    list_fhrs = getattr(reader, 'list_forecast_hours', None)
    if list_fhrs is None:
        return []

    var_map = getattr(source, 'variable_map', None)
    try:
        fhrs = await list_fhrs(path, var_map=var_map)
    except Exception as e:
        print(f"[catalog] Could not infer fhrs for cycle '{cycle}' from '{path}': {e}")
        return []

    unique: set[int] = set()
    for h in fhrs:
        try:
            unique.add(int(h))
        except (TypeError, ValueError):
            continue
    return sorted(unique)


def _extract_passthrough_query_params(
    request: Request,
    exclude_keys: set[str] | None = None,
) -> dict[str, Any] | None:
    """Extract non-reserved query params and coerce simple scalar types."""
    excluded = exclude_keys or set()
    passthrough: dict[str, Any] = {}

    for key, value in request.query_params.items():
        if key in excluded:
            continue
        passthrough[key] = _coerce_query_value(value)

    return passthrough or None


def _coerce_query_value(value: str) -> Any:
    """Best-effort coercion for booleans and numeric query parameter values."""
    lower = value.strip().lower()
    if lower in {"true", "false"}:
        return lower == "true"

    try:
        if value.isdigit() or (value.startswith("-") and value[1:].isdigit()):
            return int(value)
        return float(value)
    except ValueError:
        return value
