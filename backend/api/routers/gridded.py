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

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from ..sources.registry import get_source
from ..readers import get_reader
from ..readers.base import GriddedResult
from ..services.grid_cache import grid_cache

from datetime import datetime, timedelta, timezone
import asyncio
import hashlib
import struct
import sys
import os
import numpy as np

# ─── Protobuf imports ─────────────────────────────────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..', 'proto'))
from wxdata_pb2 import GridResponse, GridField, GridInfo

router = APIRouter(tags=["Gridded Data"])

# ─── Precision helpers ────────────────────────────────────────────────────────

_VALID_PRECISIONS = ("float32", "float16")


def _resolve_precision(precision: str | None) -> str:
    """Validate and normalise the precision query parameter."""
    if precision is None:
        return "float32"
    p = precision.strip().lower()
    if p not in _VALID_PRECISIONS:
        return "float32"
    return p


def _pack_data(data_array: np.ndarray, precision: str) -> bytes:
    """Cast a numpy array to the requested precision and return raw bytes."""
    dtype = np.float16 if precision == "float16" else np.float32
    return np.nan_to_num(data_array.astype(dtype), nan=0.0).tobytes()


# ─── Content negotiation ──────────────────────────────────────────────────────

def _wants_protobuf(request: Request) -> bool:
    """Check if the client prefers protobuf over JSON."""
    accept = request.headers.get("accept", "")
    return "application/x-protobuf" in accept


def _wants_nocache(request: Request) -> bool:
    """Check if caching should be bypassed (for performance testing)."""
    if request.query_params.get("nocache") == "1":
        return True
    cc = request.headers.get("cache-control", "")
    return "no-cache" in cc or "no-store" in cc


# ─── ETag / caching helpers ───────────────────────────────────────────────────

def _compute_etag(source_id: str, key: str, variables: str,
                  level: str | None, precision: str) -> str:
    """Compute a deterministic ETag for a gridded response."""
    raw = f"{source_id}:{key}:{variables}:{level or ''}:{precision}"
    digest = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return f'"grid-{digest}"'


def _add_cache_headers(response: Response, etag: str, nocache: bool) -> Response:
    """Attach Cache-Control and ETag headers to a response."""
    response.headers["ETag"] = etag
    if nocache:
        response.headers["Cache-Control"] = "no-store"
    else:
        # Forecast grids are immutable once written → safe to cache for 1 hour
        response.headers["Cache-Control"] = "public, max-age=3600"
    return response


def _check_etag(request: Request, etag: str) -> Response | None:
    """Return a 304 Not Modified response if the client's ETag matches."""
    if_none_match = request.headers.get("if-none-match", "")
    if if_none_match == etag:
        resp = Response(status_code=304)
        resp.headers["ETag"] = etag
        return resp
    return None


# ─── Protobuf serialization ───────────────────────────────────────────────────
def _results_to_protobuf(results, source_id: str, key: str,
                          cycle: str = "", fhr: int = -1,
                          precision: str = "float32") -> bytes:
    """Serialize a list of GriddedResult objects into a GridResponse protobuf."""
    def safe_float(val, default=-9999.0):
        try:
            return float(val)
        except (TypeError, ValueError):
            return default

    resp = GridResponse(
        source_id=source_id,
        key=key,
        cycle=cycle,
        fhr=fhr,
        field_count=len(results),
    )
    for r in results:
        gi = r.grid
        pb_grid = GridInfo(
            grid_type=gi.grid_type or "",
            ni=gi.ni if gi.ni is not None else -9999,
            nj=gi.nj if gi.nj is not None else -9999,
            lat_min=safe_float(getattr(gi, "lat_min", None)),
            lat_max=safe_float(getattr(gi, "lat_max", None)),
            lon_min=safe_float(getattr(gi, "lon_min", None)),
            lon_max=safe_float(getattr(gi, "lon_max", None)),
            dx=safe_float(getattr(gi, "dx", None)),
            dy=safe_float(getattr(gi, "dy", None)),
            proj_params={k: str(v) for k, v in (getattr(gi, "proj_params", {}) or {}).items()},
        )
        # Pack data at the requested precision
        data_array = np.asarray(r.data, dtype=np.float32)
        raw_bytes = _pack_data(data_array, precision)

        pb_field = GridField(
            variable=r.variable,
            units=r.units or "",
            data=raw_bytes,
            grid=pb_grid,
            valid_time=r.valid_time or "",
            cycle=r.cycle or "",
            fhr=r.fhr if r.fhr is not None else -1,
            fill_value=safe_float(r.fill_value, float('nan')),
            metadata={**{k: str(v) for k, v in (r.metadata or {}).items()},
                      'precision': precision},
        )
        resp.fields[r.variable].CopyFrom(pb_field)

    return resp.SerializeToString()


@router.get("/{source_id}/field")
async def get_analysis_field(
    request    : Request,
    source_id  : str,
    variables  : str   = Query(...,
                               description="Comma-separated list of variables, e.g. 't2m,u10,v10'"),
    key        : Optional[str] = Query(None,
                               description="Valid time key. Defaults to most recent."),
    level      : Optional[str] = Query(None,
                               description="Vertical level, e.g. '500mb', '2m', '10m'"),
    bbox       : Optional[str] = Query(None,
                               description="Bounding box: lon_min,lat_min,lon_max,lat_max"),
    precision  : Optional[str] = Query(None,
                               description="Transport precision: 'float32' (default) or 'float16'"),
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
    prec = _resolve_precision(precision)

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

    # ── ETag / 304 check ──
    nocache = _wants_nocache(request)
    etag = _compute_etag(source_id, key, variables, level, prec)
    not_modified = _check_etag(request, etag)
    if not_modified and not nocache:
        return not_modified

    # ── LRU cache check (protobuf path only) ──
    cache_key = (source_id, key, variables, level, prec)
    if _wants_protobuf(request) and not nocache:
        cached = grid_cache.get(cache_key)
        if cached is not None:
            resp = Response(content=cached, media_type="application/x-protobuf")
            return _add_cache_headers(resp, etag, nocache)

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

    print(f"Sending Response: {datetime.utcnow().isoformat()}Z")

    # ── Content negotiation: protobuf or JSON ──
    if _wants_protobuf(request):
        pb_bytes = _results_to_protobuf(results, source_id, key, precision=prec)
        grid_cache.put(cache_key, pb_bytes)
        resp = Response(content=pb_bytes, media_type="application/x-protobuf")
        return _add_cache_headers(resp, etag, nocache)

    fields = {r.variable: r.as_dict() for r in results}
    for vname, fdata in fields.items():
        d = fdata.get('data', [])
        g = fdata.get('grid', {})
        print(f"[DEBUG gridded] field '{vname}': data_len={len(d)} "
              f"grid_type={g.get('grid_type')} ni={g.get('ni')} nj={g.get('nj')} "
              f"first5={d[:5]} last5={d[-5:]} "
              f"min={min(d) if d else 'N/A'} max={max(d) if d else 'N/A'}")

    return _add_cache_headers(JSONResponse({
        "source_id" : source_id,
        "key"       : key,
        "field_count": len(fields),
        "fields"    : fields,
    }), etag, nocache)


@router.get("/{source_id}/forecast")
async def get_forecast_field(
    request    : Request,
    source_id  : str,
    variables  : str           = Query(..., description="Comma-separated variable list"),
    cycle      : str           = Query(..., description="Model init time, e.g. '2025030200'"),
    fhr        : int           = Query(..., ge=0, le=384, description="Forecast hour"),
    level      : Optional[str] = Query(None, description="Vertical level"),
    bbox       : Optional[str] = Query(None, description="lon_min,lat_min,lon_max,lat_max"),
    precision  : Optional[str] = Query(None, description="Transport precision: 'float32' or 'float16'"),
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
    prec = _resolve_precision(precision)

    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # Build a key from cycle + fhr, e.g. '2025030200_f006'
    key = f"{cycle}_f{str(fhr).zfill(3)}"

    # ── ETag / 304 check ──
    nocache = _wants_nocache(request)
    etag = _compute_etag(source_id, key, variables, level, prec)
    not_modified = _check_etag(request, etag)
    if not_modified and not nocache:
        return not_modified

    # ── LRU cache check (protobuf path only) ──
    cache_key = (source_id, key, variables, level, prec)
    if _wants_protobuf(request) and not nocache:
        cached = grid_cache.get(cache_key)
        if cached is not None:
            resp = Response(content=cached, media_type="application/x-protobuf")
            return _add_cache_headers(resp, etag, nocache)

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

    # ── Content negotiation: protobuf or JSON ──
    if _wants_protobuf(request):
        pb_bytes = _results_to_protobuf(results, source_id, key, cycle=cycle, fhr=fhr, precision=prec)
        grid_cache.put(cache_key, pb_bytes)
        resp = Response(content=pb_bytes, media_type="application/x-protobuf")
        return _add_cache_headers(resp, etag, nocache)

    fields = {r.variable: r.as_dict() for r in results}

    print(f"Sending JSON Response: {datetime.utcnow().isoformat()}Z")
    return _add_cache_headers(JSONResponse({
        "source_id" : source_id,
        "cycle"     : cycle,
        "fhr"       : fhr,
        "key"       : key,
        "field_count": len(fields),
        "fields"    : fields,
    }), etag, nocache)


# ═════════════════════════════════════════════════════════════════════════════
# STREAMING BATCH FORECAST ENDPOINT
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/{source_id}/forecast_stream")
async def stream_forecast_fields(
    source_id  : str,
    variables  : str           = Query(..., description="Comma-separated variable list"),
    cycle      : str           = Query(..., description="Model init time, e.g. '2025030200'"),
    fhrs       : str           = Query(..., description="Comma-separated forecast hours, e.g. '0,1,2,3,4'"),
    level      : Optional[str] = Query(None, description="Vertical level"),
    precision  : Optional[str] = Query(None, description="Transport precision: 'float32' or 'float16'"),
    nocache    : Optional[str] = Query(None, description="Set to '1' to bypass cache"),
):
    """
    Stream multiple forecast frames over a single HTTP connection.

    Opens the Zarr store once, reads each requested forecast hour lazily
    (one time-slice at a time), and streams each frame as a length-prefixed
    protobuf GridResponse message.  This means the first frame arrives
    quickly without waiting for all forecast hours to be loaded into memory.

    Wire format:
        [4-byte big-endian length][GridResponse protobuf bytes] ...repeated...

    The client reads frames incrementally from the stream and can display
    each one as soon as it arrives (progressive rendering).
    """
    prec = _resolve_precision(precision)
    bypass_cache = (nocache == "1")

    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # Parse and validate fhr list
    try:
        fhr_list = [int(f.strip()) for f in fhrs.split(",") if f.strip()]
    except ValueError:
        raise HTTPException(400, "fhrs must be comma-separated integers")

    if not fhr_list:
        raise HTTPException(400, "fhrs must contain at least one forecast hour")

    # Resolve the path — try cycle-based key first for one-file-per-cycle stores
    path = await source.get_path(f"{cycle}_f{fhr_list[0]:03d}")
    if path is None:
        path = await source.get_path(cycle)
    if path is None:
        raise HTTPException(404, f"No file for '{source_id}' cycle '{cycle}'")

    var_list = [v.strip() for v in variables.split(",")]
    var_map  = _build_var_map(source, var_list)

    reader = get_reader(path)

    print(f"[STREAM] {source_id} cycle={cycle} fhrs={fhr_list} vars={var_list} "
          f"precision={prec} path={path}")
    
    async def _generate():
        """Stream frames with backpressure control using a bounded queue."""
        import asyncio
        import zarr
        import time

        queue = asyncio.Queue(maxsize=50)

        store = zarr.open(str(path), mode='r')
        grid  = reader._read_grid_info(store)

        pb_grid = GridInfo(
            grid_type=grid.grid_type or "",
            ni=grid.ni, nj=grid.nj,
            lat_min=float(grid.lat_min), lat_max=float(grid.lat_max),
            lon_min=float(grid.lon_min), lon_max=float(grid.lon_max),
            dx=float(grid.dx), dy=float(grid.dy),
            proj_params={k: str(v) for k, v in (grid.proj_params or {}).items()},
        )

        var_info = {}
        for generic_name, zarr_name in var_map.items():
            if zarr_name not in store:
                continue
            arr = store[zarr_name]
            attrs = dict(arr.attrs)
            dims = tuple(attrs.get('_ARRAY_DIMENSIONS', ()))
            var_info[generic_name] = {
                'arr': arr,
                'attrs': attrs,
                'dims': dims,
            }

        def _read_and_serialize_frame(fhr, key):
            t1 = time.perf_counter()
            resp = GridResponse(
                source_id=source_id, key=key, cycle=cycle,
                fhr=fhr, field_count=len(var_info),
            )
            for generic_name, info in var_info.items():
                arr = info['arr']
                attrs = info['attrs']
                dims = info['dims']
                t_zarr0 = time.perf_counter()
                if arr.ndim >= 3:
                    t_axis = dims.index('time') if 'time' in dims else 0
                    t_idx = min(fhr, arr.shape[t_axis] - 1)
                    idx = [slice(None)] * arr.ndim
                    idx[t_axis] = t_idx
                    slice_2d = arr[tuple(idx)]
                else:
                    slice_2d = arr[:]
                t_zarr1 = time.perf_counter()
                if slice_2d.ndim == 2 and len(dims) >= 2:
                    remaining = tuple(d for d in dims if d != 'time')
                    if remaining[:2] in (('x', 'y'), ('lon', 'lat')):
                        slice_2d = slice_2d.T
                t_pack0 = time.perf_counter()
                raw_bytes = _pack_data(slice_2d, prec)
                t_pack1 = time.perf_counter()
                pb_field = GridField(
                    variable=generic_name,
                    units=attrs.get('units', 'unknown'),
                    data=raw_bytes,
                    grid=pb_grid,
                    valid_time="",
                    cycle=cycle,
                    fhr=fhr,
                    fill_value=0.0,
                    metadata={'precision': prec},
                )
                resp.fields[generic_name].CopyFrom(pb_field)
                print(f"[STREAM][{key}] {generic_name}: zarr_read={t_zarr1-t_zarr0:.3f}s pack={t_pack1-t_pack0:.3f}s shape={slice_2d.shape}")
            t2 = time.perf_counter()
            print(f"[STREAM][{key}] frame: total_serialize={t2-t1:.3f}s")
            return resp.SerializeToString()

        async def producer():
            for fhr in fhr_list:
                key = f"{cycle}_f{fhr:03d}"
                t0 = time.perf_counter()
                pb_bytes = await asyncio.to_thread(_read_and_serialize_frame, fhr, key)
                frame = struct.pack('>I', len(pb_bytes)) + pb_bytes
                if queue.full():
                    try:
                        queue.get_nowait()
                        print(f"[QUEUE] Dropping stale frame before enqueue ({key})")
                    except asyncio.QueueEmpty:
                        pass
                await queue.put(frame)
                t1 = time.perf_counter()
                print(f"[PRODUCER][{key}] produced in {t1-t0:.3f}s")
            await queue.put(None)

        asyncio.create_task(producer())

        while True:
            frame = await queue.get()
            if frame is None:
                break
            t_send0 = time.perf_counter()
            yield frame
            t_send1 = time.perf_counter()
            print(f"[STREAM] send_time={t_send1-t_send0:.3f}s")

    
    
    return StreamingResponse(
        _generate(),
        media_type="application/x-protobuf-stream",
    )




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
