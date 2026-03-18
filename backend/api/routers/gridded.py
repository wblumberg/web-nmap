"""
routers/gridded.py — Gridded Data Endpoints

Serves 2-D gridded fields (analysis and forecast) in a format that the
autumnplot-gl RawScalarField / RawVectorField constructors can consume
directly in JavaScript.

─── Analysis vs Forecast ────────────────────────────────────────────────────

Analysis endpoint:  GET /api/v1/gridded/{source_id}/field
  - Returns the field closest to the requested valid_time
  - No fhr parameter needed
  - Works for: MRMS, RAP analysis, HRRR analysis, GOES satellite

Forecast endpoint:  GET /api/v1/gridded/{source_id}/forecast
  - Returns a specific forecast hour from a model run
  - Requires cycle (model init time) and fhr
  - Works for: GFS f024, NAM f036, HRRR f18, RAP f21, HREF members

Both endpoints return the same response structure — a GriddedResult JSON
object that the JavaScript DataLoader converts to a Float32Array and passes
to autumnplot-gl.

─── Vector fields ────────────────────────────────────────────────────────────

Wind and other vector fields require two components (U and V). The endpoint
supports requesting multiple variables in one call. When var_map contains
both 'u_wind' and 'v_wind', the response contains both GriddedResults and
the JS side constructs a RawVectorField from them.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from ..sources.registry import get_source
from ..readers import get_reader

from datetime import datetime

router = APIRouter(tags=["Gridded Data"])


@router.get("/{source_id}/field")
async def get_analysis_field(
    source_id  : str,
    variables  : str   = Query(...,
                               description="Comma-separated list of variables, e.g. 't2m,u10,v10'"),
    key        : Optional[str] = Query(None,
                               description="Valid time key. Defaults to most recent."),
    level      : Optional[str] = Query(None,
                               description="Vertical level, e.g. '500mb', '2m', '10m'"),
    bbox       : Optional[str] = Query(None,
                               description="Bounding box: lon_min,lat_min,lon_max,lat_max"),
):
    """
    Return one or more gridded analysis fields for a given valid time.

    The response is a JSON object with one key per requested variable.
    Each value is a GriddedResult dict containing the flat float32 data
    array and the grid descriptor.

    JavaScript usage:
        const resp = await fetch('/api/v1/gridded/MRMS/field?variables=cref&key=20250302_1800');
        const json = await resp.json();
        // json.fields.cref.data is a regular JS array → convert to Float32Array
        const data = new Float32Array(json.fields.cref.data);
        const grid = json.fields.cref.grid;
        const field = new apgl.RawScalarField(
            new apgl.PlateCarreeGrid(grid.ni, grid.nj, grid.lon_min, grid.lat_min,
                                     grid.dx, grid.dy),
            data
        );
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # Resolve key to most recent if not specified
    if key is None:
        latest = await source.most_recent()
        if latest is None:
            raise HTTPException(404, f"No data for '{source_id}'")
        key = latest.key

    path = await source.get_path(key)
    if path is None:
        raise HTTPException(404, f"No file for '{source_id}' key '{key}'")

    # Build var_map from the source registry and requested variable names
    var_list = [v.strip() for v in variables.split(",")]
    var_map  = _build_var_map(source, var_list)

    print(f"[DEBUG gridded] source_id={source_id} key={key} var_list={var_list} var_map={var_map} path={path}")

    reader  = get_reader(path)
    print(f"[DEBUG gridded] reader type: {type(reader).__name__}")
    print(f"Start time for reading variables: {datetime.utcnow().isoformat()}Z")
    try:
        results = await reader.read_gridded(
            path    = path,
            var_map = var_map,
            level   = level,
        )
    except NotImplementedError:
        raise HTTPException(400, f"Source '{source_id}' does not support gridded reads.")
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"Read error: {e}")
    print(f"Finished reading variables: {datetime.utcnow().isoformat()}Z")

    fields = {r.variable: r.as_dict() for r in results}
    for vname, fdata in fields.items():
        d = fdata.get('data', [])
        g = fdata.get('grid', {})
        print(f"[DEBUG gridded] field '{vname}': data_len={len(d)} "
              f"grid_type={g.get('grid_type')} ni={g.get('ni')} nj={g.get('nj')} "
              f"first5={d[:5]} last5={d[-5:]} "
              f"min={min(d) if d else 'N/A'} max={max(d) if d else 'N/A'}")

    print(f"Sending JSON Response: {datetime.utcnow().isoformat()}Z")
    return JSONResponse({
        "source_id" : source_id,
        "key"       : key,
        "field_count": len(fields),
        "fields"    : fields,
    })


@router.get("/{source_id}/forecast")
async def get_forecast_field(
    source_id  : str,
    variables  : str           = Query(..., description="Comma-separated variable list"),
    cycle      : str           = Query(..., description="Model init time, e.g. '2025030200'"),
    fhr        : int           = Query(..., ge=0, le=384, description="Forecast hour"),
    level      : Optional[str] = Query(None, description="Vertical level"),
    bbox       : Optional[str] = Query(None, description="lon_min,lat_min,lon_max,lat_max"),
):
    """
    Return gridded forecast fields for a specific model cycle + forecast hour.

    This endpoint is used for time-stepped model loops (GFS f000→f240,
    NAM f000→f060, HRRR f000→f018, HREF members, etc.)

    JavaScript usage:
        // Loop through GFS forecast hours
        for (const fhr of [0, 6, 12, 18, 24]) {
            const url = `/api/v1/gridded/GFS/forecast?variables=t500,gh500`
                      + `&cycle=2025030200&fhr=${fhr}`;
            const resp  = await fetch(url);
            const json  = await resp.json();
            // Add to MultiPlotLayer with key = json.key
            multiLayer.addField(makeField(json.fields.t500), json.key);
        }
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # Build a key from cycle + fhr, e.g. '2025030200_f006'
    key = f"{cycle}_f{str(fhr).zfill(3)}"

    print(f"Looking for forecast file with key '{key}' for source '{source_id}'")
    path = await source.get_path(key)

    if path is None:
        # Also try direct cycle key for sources that store one file per cycle
        path = await source.get_path(cycle)
        print(f"Trying cycle key '{cycle}' → {'Found' if path else 'Not found'}")
    if path is None:
        raise HTTPException(404, f"No file for '{source_id}' cycle '{cycle}' fhr {fhr}")

    var_list = [v.strip() for v in variables.split(",")]
    var_map  = _build_var_map(source, var_list)

    print(f"Start time for reading forecast variables: {datetime.utcnow().isoformat()}Z")
    print(path, var_map)
    reader  = get_reader(path)
    try:
        results = await reader.read_gridded(
            path    = path,
            var_map = var_map,
            level   = level,
            fhr     = fhr,
        )
    except Exception as e:
        raise HTTPException(500, f"Read error: {e}")
    print(f"Finished reading forecast variables: {datetime.utcnow().isoformat()}Z")

    fields = {r.variable: r.as_dict() for r in results}

    print(f"Sending JSON Response: {datetime.utcnow().isoformat()}Z")
    return JSONResponse({
        "source_id" : source_id,
        "cycle"     : cycle,
        "fhr"       : fhr,
        "key"       : key,
        "field_count": len(fields),
        "fields"    : fields,
    })


@router.get("/{source_id}/available_levels")
async def get_available_levels(
    source_id : str,
    key       : Optional[str] = Query(None, description="Valid time key"),
    variable  : Optional[str] = Query(None, description="Variable name to inspect"),
):
    """
    Return the available vertical levels for a source.

    Used by the UI to populate the level selector dropdown when the user
    is configuring a pressure-level or height-level product.

    Returns a list of level strings, e.g.:
        ["1000mb", "925mb", "850mb", "700mb", "500mb", "300mb", "250mb", "200mb"]
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
        raise HTTPException(404, f"No file for key '{key}'")

    levels = await _detect_levels(path, variable)
    return {
        "source_id" : source_id,
        "key"       : key,
        "variable"  : variable,
        "levels"    : levels,
    }


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _build_var_map(source, var_list: list[str]) -> dict[str, str]:
    """
    Map generic variable names to format-specific names using the source's
    variable_map config. Falls back to identity (name maps to itself) if
    no mapping is configured.
    """
    source_var_map = getattr(source, 'variable_map', {})
    return {
        v: source_var_map.get(v, v)
        for v in var_list
    }


async def _detect_levels(path, variable):
    """Open the file and return available vertical level names."""
    try:
        import xarray as xr
        ds = xr.open_dataset(str(path), mask_and_scale=True)
        level_dims = [d for d in ds.dims
                      if d in ('level', 'pressure', 'plev', 'lev', 'isobaricInhPa')]
        if level_dims:
            vals = ds[level_dims[0]].values
            ds.close()
            return [f"{int(v)}mb" for v in vals]
        ds.close()
    except Exception:
        pass
    return []
