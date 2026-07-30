"""
routers/zarr_proxy.py — Zarr Chunk Passthrough Endpoint

Serves raw (still-compressed) zarr chunk bytes directly to the browser so
that decompression happens in the JS runtime (via zarr.js + numcodecs WASM)
rather than in Python.  This means the Blosc/LZ4/zstd compression applied at
write time actually reduces wire bytes, unlike the existing protobuf path which
decompresses everything server-side before re-serialising.

── URL structure ──────────────────────────────────────────────────────────────

  GET /api/v1/zarr/{source_id}/{key}/.zattrs
  GET /api/v1/zarr/{source_id}/{key}/.zgroup
  GET /api/v1/zarr/{source_id}/{key}/{variable}/.zarray
  GET /api/v1/zarr/{source_id}/{key}/{variable}/{chunk_coords}

  source_id   : registered source id, e.g. "MESOANALYSIS_GRID"
  key         : frame key, e.g. "20260430_1200"
  chunk_path  : any path component below the store root, e.g.
                "mean_MSLMA/.zarray" or "mean_MSLMA/0.0"

── Security ───────────────────────────────────────────────────────────────────

Path traversal is blocked by:
  1. Rejecting ".." anywhere in chunk_path.
  2. Verifying the resolved chunk_file is under the store root (symlink-safe).

The passthrough intentionally serves bytes verbatim — it never decompresses,
so no CPU is spent in the hot path.

── Caching ────────────────────────────────────────────────────────────────────

Chunk files are immutable once written (a new frame gets a new zarr store).
A 1-hour Cache-Control is therefore safe.  Metadata files (.zattrs, .zarray,
.zgroup) get 5 minutes to allow reprocessed stores to update promptly.

── Compatibility ─────────────────────────────────────────────────────────────

zarr.js (v0.x) constructs chunk URLs as:
  {storeBaseUrl}/{variable}/{chunkIndex}
  e.g. /api/v1/zarr/MESOANALYSIS_GRID/20260430_1200/mean_MSLMA/0.0

This router handles that layout directly.
"""

import json
import numpy as np
from pathlib import Path
from functools import lru_cache

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..sources.registry import get_source

router = APIRouter(tags=["Zarr Proxy"])

# ── Zarr v3 → v2 compatibility shim ──────────────────────────────────────────
#
# Python's zarr library (v3.x) writes stores with "zarr_format": 3, which uses:
#   - zarr.json  (root / array metadata, consolidated at the root)
#   - chunks stored as  {array}/c/{i}/{j}  (slash-separated, under a "c/" prefix)
#
# The JavaScript zarr npm package (v0.6.x) only understands zarr v2, which uses:
#   - .zgroup / .zattrs  (root metadata)
#   - {array}/.zarray    (per-array metadata)
#   - chunks stored as   {array}/{i}.{j}  (dot-separated, no prefix)
#
# When the JS client requests v2-format paths and they 404, zarr.js silently
# drops the variable, leaving `data.CMI` / `data.MergedBaseReflectivityQC`
# undefined, which crashes inside Raster.onAdd.
#
# This shim synthesises valid v2 responses on-the-fly for stores that have
# a root zarr.json, so no data conversion is needed on disk.

_V3_DTYPE_TO_V2 = {
    "float16": "<f2", "float32": "<f4", "float64": "<f8",
    "int8":    "|i1", "int16":   "<i2", "int32":   "<i4", "int64":   "<i8",
    "uint8":   "|u1", "uint16":  "<u2", "uint32":  "<u4", "uint64":  "<u8",
    "bool":    "|b1",
}

_SHUFFLE_MAP = {"noshuffle": 0, "shuffle": 1, "bitshuffle": 2}


def _read_v3_root(store_root: Path) -> dict | None:
    """Return parsed zarr.json from store_root, or None if absent / not v3."""
    zj = store_root / "zarr.json"
    if not zj.exists():
        return None
    try:
        data = json.loads(zj.read_text())
    except Exception:
        return None
    return data if data.get("zarr_format") == 3 else None


def _v3_array_meta_to_v2(array_meta: dict) -> dict:
    """Translate a single zarr v3 array metadata dict to zarr v2 .zarray format."""
    dtype_v3 = array_meta.get("data_type", "float32")
    dtype_v2 = _V3_DTYPE_TO_V2.get(dtype_v3, "<f4")

    chunks = (
        array_meta.get("chunk_grid", {})
        .get("configuration", {})
        .get("chunk_shape", array_meta.get("shape", []))
    )

    # Translate the first blosc codec found in the pipeline (if any) to a v2 compressor.
    compressor = None
    for codec in array_meta.get("codecs", []):
        if codec.get("name") == "blosc":
            cfg = codec.get("configuration", {})
            shuffle_str = cfg.get("shuffle", "shuffle")
            compressor = {
                "id":        "blosc",
                "cname":     cfg.get("cname", "lz4"),
                "clevel":    cfg.get("clevel", 5),
                "shuffle":   _SHUFFLE_MAP.get(shuffle_str, 1),
                "blocksize": cfg.get("blocksize", 0),
            }
            break

    fill_value = array_meta.get("fill_value", 0)
    # zarr v2 uses 0 or a numeric sentinel, not the string "NaN"
    if fill_value == "NaN":
        fill_value = "NaN"  # zarr v2 also accepts "NaN" for float dtypes

    return {
        "zarr_format": 2,
        "shape":       array_meta.get("shape", []),
        "chunks":      chunks,
        "dtype":       dtype_v2,
        "compressor":  compressor,
        "fill_value":  fill_value,
        "filters":     None,
        "order":       "C",
    }


def _v3_chunk_path(chunk_path: str) -> str | None:
    """
    Convert a zarr v2 chunk path (dot-separated) to a zarr v3 chunk path.

    v2: {array}/0.0        →  v3: {array}/c/0/0
    v2: {array}/1.2        →  v3: {array}/c/1/2
    v2: 0.0                →  v3: c/0/0   (bare chunk at root)

    Returns None if the path doesn't look like a chunk path (e.g. metadata).
    """
    parts = chunk_path.rsplit("/", 1)
    prefix = parts[0] + "/" if len(parts) == 2 else ""
    leaf = parts[-1]

    # Chunk leaves look like "0", "0.0", "1.2.3", etc.
    if "." in leaf and all(p.isdigit() for p in leaf.split(".")):
        v3_indices = "/".join(leaf.split("."))
        return f"{prefix}c/{v3_indices}"
    # Also accept already-slash-separated  indices  (c/0/0) — pass through
    return None


@lru_cache(maxsize=1024)
def _chunk_t_for_var(store_root_str: str, var_name: str) -> int:
    """Return the chunk size along the time axis for a variable.

    Handles both zarr v2 (.zarray) and zarr v3 (zarr.json) stores.
    Returns 1 when the answer cannot be determined (graceful degradation).
    """
    store_root = Path(store_root_str)

    # ── zarr v2: read .zarray ─────────────────────────────────────────────────
    zarray_path = store_root / var_name / ".zarray"
    if zarray_path.exists():
        try:
            meta   = json.loads(zarray_path.read_text())
            chunks = meta.get("chunks", [])
            shape  = meta.get("shape",  [])
            if len(shape) < 3 or not chunks:
                return 1
            t_axis = 0
            zattrs_path = store_root / var_name / ".zattrs"
            if zattrs_path.exists():
                attrs = json.loads(zattrs_path.read_text())
                dims  = attrs.get("_ARRAY_DIMENSIONS", [])
                if "time" in dims:
                    t_axis = dims.index("time")
            return int(chunks[t_axis])
        except Exception:
            return 1

    # ── zarr v3: read from consolidated metadata or per-array zarr.json ───────
    try:
        # Try consolidated metadata first (one file, already cached by caller).
        root_zj = store_root / "zarr.json"
        if root_zj.exists():
            root_meta = json.loads(root_zj.read_text())
            cons = (root_meta.get("consolidated_metadata") or {}).get("metadata", {})
            if var_name in cons:
                ameta  = cons[var_name]
                chunks = ameta.get("chunk_grid", {}).get("configuration", {}).get("chunk_shape", [])
                dims   = ameta.get("dimension_names", [])
                t_axis = dims.index("time") if "time" in dims else 0
                return int(chunks[t_axis]) if chunks else 1
        # Fall back to per-array zarr.json.
        arr_zj = store_root / var_name / "zarr.json"
        if arr_zj.exists():
            ameta  = json.loads(arr_zj.read_text())
            chunks = ameta.get("chunk_grid", {}).get("configuration", {}).get("chunk_shape", [])
            dims   = ameta.get("dimension_names", [])
            t_axis = dims.index("time") if "time" in dims else 0
            return int(chunks[t_axis]) if chunks else 1
    except Exception:
        pass

    return 1  # can't determine; assume rechunked


# Characters allowed in chunk paths — blocks shell metacharacters and traversal
_SAFE_CHARS = frozenset(
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    "0123456789"
    "_-./+"
)

# Metadata files get a shorter TTL so reprocessed stores propagate quickly
_META_FILENAMES = frozenset({".zattrs", ".zarray", ".zgroup", ".zmetadata"})

# Appropriate MIME types for zarr metadata files
_MIME_BY_NAME = {
    ".zattrs"   : "application/json",
    ".zarray"   : "application/json",
    ".zgroup"   : "application/json",
    ".zmetadata": "application/json",
}


def _validate_chunk_path(chunk_path: str) -> None:
    """Raise HTTPException 400 if chunk_path looks dangerous."""
    if ".." in chunk_path:
        raise HTTPException(400, "Path traversal not allowed")
    if not all(c in _SAFE_CHARS for c in chunk_path):
        raise HTTPException(400, "Invalid characters in chunk path")


def _cache_control(filename: str) -> str:
    return "public, max-age=300" if filename in _META_FILENAMES else "public, max-age=3600"


@router.get("/{source_id}/{key}/{chunk_path:path}")
async def zarr_chunk(source_id: str, key: str, chunk_path: str) -> Response:
    """
    Return a single zarr chunk or metadata file verbatim from disk.

    For zarr v2 stores, bytes are served exactly as stored (still compressed).
    For zarr v3 stores (zarr.json), v2-compatible metadata is synthesised
    on-the-fly so the JS zarr npm package (v0.6.x, v2-only) can read them.
    Chunk data is remapped from v2 dot-notation paths to v3 c/i/j paths.
    """
    _validate_chunk_path(chunk_path)

    try:
        source = get_source(source_id)
    except KeyError:
        raise HTTPException(404, f"Unknown source '{source_id}'")

    # Only zarr-transport sources should be served through this router.
    if not getattr(source, 'zarr_transport', False):
        raise HTTPException(
            403,
            f"Source '{source_id}' is not configured for zarr transport. "
            "Set zarr_transport=True on the source to enable this endpoint."
        )

    store_path = await source.get_path(key)
    if store_path is None:
        raise HTTPException(404, f"No store found for source='{source_id}' key='{key}'")

    store_root = Path(store_path).resolve()

    # ── Detect zarr v3 store ───────────────────────────────────────────────────
    v3_meta = _read_v3_root(store_root)
    is_v3 = v3_meta is not None

    filename = chunk_path.rsplit("/", 1)[-1]

    # ── Handle metadata requests for v3 stores (synthesise v2 responses) ──────
    if is_v3:
        cons = (v3_meta.get("consolidated_metadata") or {}).get("metadata") or {}

        # .zattrs at root → root attributes from zarr.json
        if chunk_path == ".zattrs":
            attrs = v3_meta.get("attributes", {})
            return Response(
                content=json.dumps(attrs),
                media_type="application/json",
                headers={"Cache-Control": "public, max-age=300",
                         "Access-Control-Allow-Origin": "*"},
            )

        # .zgroup at root → synthetic v2 group marker
        if chunk_path == ".zgroup":
            return Response(
                content='{"zarr_format": 2}',
                media_type="application/json",
                headers={"Cache-Control": "public, max-age=300",
                         "Access-Control-Allow-Origin": "*"},
            )

        # {array}/.zattrs → array attributes from consolidated metadata
        if filename == ".zattrs" and "/" in chunk_path:
            array_name = chunk_path[: chunk_path.rfind("/.zattrs")]
            array_meta = cons.get(array_name, {})
            attrs = array_meta.get("attributes", {})
            return Response(
                content=json.dumps(attrs),
                media_type="application/json",
                headers={"Cache-Control": "public, max-age=300",
                         "Access-Control-Allow-Origin": "*"},
            )

        # {array}/.zarray → synthesised v2 array metadata
        if filename == ".zarray":
            array_name = chunk_path[: chunk_path.rfind("/.zarray")]
            if array_name not in cons:
                raise HTTPException(404, f"Array '{array_name}' not found in v3 store")
            zarray_v2 = _v3_array_meta_to_v2(cons[array_name])
            return Response(
                content=json.dumps(zarray_v2),
                media_type="application/json",
                headers={"Cache-Control": "public, max-age=300",
                         "Access-Control-Allow-Origin": "*"},
            )

        # Chunk data — remap v2 dot-notation (0.0) to v3 c/i/j layout
        v3_path = _v3_chunk_path(chunk_path)
        if v3_path is not None:
            chunk_file = (store_root / v3_path).resolve()
            try:
                chunk_file.relative_to(store_root)
            except ValueError:
                raise HTTPException(400, "Path escapes store root")
            if not chunk_file.exists():
                raise HTTPException(404, f"Chunk not found: {v3_path}")
            data = chunk_file.read_bytes()
            return Response(
                content=data,
                media_type="application/octet-stream",
                headers={"Cache-Control": "public, max-age=3600",
                         "Access-Control-Allow-Origin": "*",
                         "X-Content-Type-Options": "nosniff"},
            )

    # ── Default: serve file verbatim (v2 store) ────────────────────────────────
    chunk_file = (store_root / chunk_path).resolve()

    # Symlink-safe containment check
    try:
        chunk_file.relative_to(store_root)
    except ValueError:
        raise HTTPException(400, "Path escapes store root")

    if not chunk_file.exists():
        raise HTTPException(404, f"Chunk not found: {chunk_path}")

    if chunk_file.is_dir():
        raise HTTPException(400, "Path points to a directory, not a chunk file")

    media_type = _MIME_BY_NAME.get(filename, "application/octet-stream")
    cache_control = _cache_control(filename)

    data = chunk_file.read_bytes()

    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Cache-Control"                : cache_control,
            "Access-Control-Allow-Origin"  : "*",
            "X-Content-Type-Options"       : "nosniff",
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Forecast fhr-slice proxy
# ═══════════════════════════════════════════════════════════════════════════════
#
# URL layout:
#   GET /api/v1/zarr/{source_id}/{cycle}/fhr/{fhr}/.zgroup
#   GET /api/v1/zarr/{source_id}/{cycle}/fhr/{fhr}/.zattrs
#   GET /api/v1/zarr/{source_id}/{cycle}/fhr/{fhr}/{variable}/.zarray
#   GET /api/v1/zarr/{source_id}/{cycle}/fhr/{fhr}/{variable}/{chunk_coords}
#
# The JS client sees a *virtual* 2-D zarr store (nj, ni) for each fhr.
# Internally this endpoint:
#   1. Resolves the cycle path from the source registry.
#   2. Reads the time coordinate once (cached per store path) to map fhr → t_idx.
#   3. For metadata: synthesises 2-D .zarray by dropping the time axis.
#   4. For chunk data:
#        - Fast path (chunk_t == 1): prepend t_idx to spatial indices and serve
#          the raw on-disk chunk verbatim — zero decompression, full wire savings.
#        - Slow path (chunk_t > 1): decompress the covering time chunk, extract
#          the correct slice, recompress, and return (adds latency but is still
#          correct; rechunk with chunk_t=1 to avoid this).

@lru_cache(maxsize=256)
def _load_time_coord(store_path_str: str) -> tuple[list[float], str]:
    """Return (fhr_values, units_str) for the time coordinate of a zarr store.

    Cached per store path so we only open the metadata once per cycle.
    fhr_values are always expressed as decimal hours since the init time.
    """
    import zarr as _zarr

    _zfmt = 3 if Path(store_path_str + '/zarr.json').exists() else 2
    store = _zarr.open_group(store_path_str, mode='r', zarr_format=_zfmt)
    if 'time' not in store:
        return ([], "")

    time_arr = store['time'][:]
    try:
        units = dict(store['time'].attrs).get('units', '')
    except Exception:
        units = ''

    if isinstance(units, str) and units.lower().startswith('hours since'):
        # Values are already forecast hours (float).
        return ([float(v) for v in time_arr], units)

    # datetime64 arrays: convert to int64 nanoseconds so the integer branch below
    # can compute forecast hours relative to the model init time.
    if np.issubdtype(time_arr.dtype, np.datetime64):
        time_arr = time_arr.astype('datetime64[ns]').astype('int64')

    # Nanosecond-epoch integers (or datetime64 converted above): convert relative
    # to init time stored in root attrs.
    if np.issubdtype(time_arr.dtype, np.integer):
        root_attrs = dict(store.attrs) if hasattr(store, 'attrs') else {}
        # Try common init-time attribute names.
        for key in ('init_time', 'run_id', 'cycle', 'created_at'):
            val = root_attrs.get(key)
            if val:
                try:
                    from datetime import datetime, timezone
                    if isinstance(val, str) and len(val) == 10 and val.isdigit():
                        init_dt = datetime.strptime(val, "%Y%m%d%H").replace(
                            tzinfo=timezone.utc)
                    else:
                        init_dt = datetime.fromisoformat(
                            str(val).replace('Z', '+00:00'))
                    init_ns = np.datetime64(
                        init_dt.replace(tzinfo=None), 'ns').astype('int64')
                    fhrs = [(int(v) - init_ns) / 3.6e12 for v in time_arr]
                    return (fhrs, units)
                except Exception:
                    pass

    # Last resort: assume values are already hours.
    return ([float(v) for v in time_arr], units)


def _fhr_to_tindex(store_path_str: str, fhr: int) -> int:
    """Return the 0-based time index for `fhr` hours after init."""
    fhrs, _ = _load_time_coord(store_path_str)
    if not fhrs:
        return fhr  # no time coord — assume direct index
    arr = np.array(fhrs)
    return int(np.argmin(np.abs(arr - fhr)))


def _synthesise_2d_zarray(store_path_str: str, var_name: str) -> dict | None:
    """Read array metadata for var_name, drop the time axis, return v2 dict.

    Handles both zarr v2 (.zarray) and zarr v3 (zarr.json / consolidated).
    Reads directly from on-disk JSON to avoid zarr-python API fragility.
    """
    store_root  = Path(store_path_str)
    zarray_path = store_root / var_name / ".zarray"
    zattrs_path = store_root / var_name / ".zattrs"

    # ── zarr v2 path ─────────────────────────────────────────────────────────
    if zarray_path.exists():
        meta   = json.loads(zarray_path.read_text())
        shape  = list(meta.get("shape",  []))
        chunks = list(meta.get("chunks", []))
        dims: list[str] = []
        if zattrs_path.exists():
            dims = list(json.loads(zattrs_path.read_text()).get("_ARRAY_DIMENSIONS", []))
        t_axis = dims.index("time") if "time" in dims else (0 if len(shape) >= 3 else None)
        if t_axis is not None and len(shape) > 2:
            shape  = shape[:t_axis]  + shape[t_axis + 1:]
            chunks = chunks[:t_axis] + chunks[t_axis + 1:]
        fill = meta.get("fill_value", 0)
        try:
            fv = float(fill)
            fill = "NaN" if np.isnan(fv) else fv
        except (TypeError, ValueError):
            fill = 0
        return {
            "zarr_format": 2, "shape": shape, "chunks": chunks,
            "dtype": meta.get("dtype", "<f4"), "compressor": meta.get("compressor"),
            "fill_value": fill, "filters": meta.get("filters"), "order": meta.get("order", "C"),
        }

    # ── zarr v3 path: look in consolidated metadata then per-array zarr.json ──
    ameta: dict | None = None
    root_zj = store_root / "zarr.json"
    if root_zj.exists():
        try:
            cons = (json.loads(root_zj.read_text()).get("consolidated_metadata") or {}).get("metadata", {})
            if var_name in cons:
                ameta = cons[var_name]
        except Exception:
            pass
    if ameta is None:
        arr_zj = store_root / var_name / "zarr.json"
        if arr_zj.exists():
            try:
                ameta = json.loads(arr_zj.read_text())
            except Exception:
                pass
    if ameta is None:
        return None

    # Convert v3 metadata to v2 .zarray, then drop the time axis.
    v2 = _v3_array_meta_to_v2(ameta)
    dims_v3 = list(ameta.get("dimension_names") or [])
    shape  = list(v2["shape"])
    chunks = list(v2["chunks"])
    t_axis = dims_v3.index("time") if "time" in dims_v3 else (0 if len(shape) >= 3 else None)
    if t_axis is not None and len(shape) > 2:
        shape  = shape[:t_axis]  + shape[t_axis + 1:]
        chunks = chunks[:t_axis] + chunks[t_axis + 1:]
    return {**v2, "shape": shape, "chunks": chunks}


def _map_2d_chunk_to_3d(chunk_path: str, t_idx: int) -> str:
    """Translate a 2-D chunk key (dot-separated) to a 3-D key by prepending t_idx.

    Examples:
        "0.0"   → "0.0.0"  (t_idx=0)
        "1.2"   → "5.1.2"  (t_idx=5)
        "var/0.0" → handled by caller who strips var prefix first
    """
    return f"{t_idx}.{chunk_path}"


def _serve_slow_path(store_path_str: str, var_name: str,
                     spatial_chunk_key: str, t_idx: int) -> bytes:
    """Decompress covering time chunk, extract slice at t_idx, recompress.

    Used when chunk_t > 1.  Significantly slower than the fast path; callers
    should rechunk to chunk_t=1 to avoid this branch.
    """
    import zarr as _zarr
    import numcodecs

    _zfmt = 3 if Path(store_path_str + '/zarr.json').exists() else 2
    store = _zarr.open_group(store_path_str, mode='r', zarr_format=_zfmt)
    arr = store[var_name]
    attrs = dict(arr.attrs)
    dims  = list(attrs.get('_ARRAY_DIMENSIONS', []))

    t_axis = dims.index('time') if 'time' in dims else (0 if arr.ndim >= 3 else None)
    if t_axis is None:
        raise HTTPException(500, "Array is not 3-D; cannot slice time axis")

    # Parse spatial chunk indices from dot-notation (e.g. "0.1" → (0, 1))
    spatial_indices = [int(x) for x in spatial_chunk_key.split(".")]

    # Build full 3-D chunk index
    full_idx: list[int] = []
    si = 0
    for ax in range(arr.ndim):
        if ax == t_axis:
            full_idx.append(0)  # placeholder — we'll recompute t chunk below
        else:
            full_idx.append(spatial_indices[si] if si < len(spatial_indices) else 0)
            si += 1

    # Which time-chunk covers t_idx?
    chunk_t = arr.chunks[t_axis]
    full_idx[t_axis] = t_idx // chunk_t
    within_chunk_t   = t_idx %  chunk_t

    # Read the whole covering 3-D chunk.
    chunk_shape = list(arr.chunks)
    slices = tuple(
        slice(ci * cs, min((ci + 1) * cs, arr.shape[ax]))
        for ax, (ci, cs) in enumerate(zip(full_idx, chunk_shape))
    )
    data_chunk = arr[slices]  # decompresses from disk

    # Extract the time slice along t_axis.
    slice_2d = np.take(data_chunk, within_chunk_t, axis=t_axis)

    # Recompress with the same codec (handle both zarr v2 and v3).
    raw_bytes = slice_2d.astype(arr.dtype).tobytes(order='C')

    # For v2 stores: recompress with the same codec so the client can decode
    # using the compressor advertised in the synthesised .zarray.
    # For v3 stores: _synthesise_2d_zarray returns compressor:null (because
    # arr.compressor fails for v3), so we must return raw bytes here too —
    # recompressing would give the client data it can't decode.
    compressor = None
    try:
        compressor = arr.compressor  # zarr v2: returns numcodecs object directly
    except (TypeError, AttributeError):
        pass  # v3 store: serve raw bytes; client expects compressor:null

    if compressor is not None:
        return compressor.encode(raw_bytes)
    return raw_bytes


@router.get("/{source_id}/{cycle}/fhr/{fhr}/{chunk_path:path}")
async def zarr_forecast_chunk(
    source_id : str,
    cycle     : str,
    fhr       : int,
    chunk_path: str,
) -> Response:
    """
    Serve a zarr chunk or metadata for a single forecast hour as a virtual 2-D store.

    The JS client opens this endpoint as an HTTPStore base URL and receives
    metadata describing a plain (nj, ni) array — the time dimension is hidden.
    Chunk data requests are translated: virtual key "i.j" → on-disk key
    "{t_idx}.i.j", then the raw compressed bytes are returned verbatim when
    chunk_t == 1 (fast path).

    This allows zarr.js to read forecast grids with the same code path used
    for 2-D analysis stores, with no special time-handling in the browser.
    """
    _validate_chunk_path(chunk_path)

    try:
        source = get_source(source_id)
    except KeyError:
        raise HTTPException(404, f"Unknown source '{source_id}'")

    if not getattr(source, 'zarr_transport', False):
        raise HTTPException(
            403,
            f"Source '{source_id}' is not configured for zarr transport. "
            "Set zarr_transport=True on the source to enable this endpoint.",
        )

    # Resolve store path — try fhr-keyed path first, then cycle-only.
    fhr_key = f"{cycle}_f{fhr:03d}"
    store_path = await source.get_path(fhr_key)
    if store_path is None:
        store_path = await source.get_path(cycle)
    if store_path is None:
        raise HTTPException(404, f"No store for source='{source_id}' cycle='{cycle}'")

    store_root = Path(store_path).resolve()
    store_path_str = str(store_root)

    # Compute t_idx once; result is cached inside _fhr_to_tindex / _load_time_coord.
    t_idx = _fhr_to_tindex(store_path_str, fhr)

    filename = chunk_path.rsplit("/", 1)[-1]

    # zarrita (Zarr v3 client) probes for zarr.json to detect store format.
    # This virtual store is v2-only; return 404 so zarrita falls back to v2.
    if filename == "zarr.json":
        raise HTTPException(404, "zarr.json not found (virtual v2 store)")

    # ── .zgroup (root) ──────────────────────────────────────────────────────
    if chunk_path == ".zgroup":
        zgroup_file = store_root / ".zgroup"
        content = zgroup_file.read_text() if zgroup_file.exists() else '{"zarr_format": 2}'
        return Response(
            content=content,
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=300",
                     "Access-Control-Allow-Origin": "*"},
        )

    # ── .zattrs (root) ──────────────────────────────────────────────────────
    if chunk_path == ".zattrs":
        zattrs_file = store_root / ".zattrs"
        content = zattrs_file.read_text() if zattrs_file.exists() else "{}"
        return Response(
            content=content,
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=300",
                     "Access-Control-Allow-Origin": "*"},
        )

    # ── {var}/.zattrs ────────────────────────────────────────────────────────
    if filename == ".zattrs" and "/" in chunk_path:
        var_name = chunk_path[: chunk_path.rfind("/.zattrs")]
        zattrs_file = store_root / var_name / ".zattrs"
        if zattrs_file.exists():
            raw = json.loads(zattrs_file.read_text())
        else:
            # v3 store: extract attributes from consolidated or per-array zarr.json
            raw = {}
            root_zj = store_root / "zarr.json"
            if root_zj.exists():
                try:
                    cons = (json.loads(root_zj.read_text()).get("consolidated_metadata") or {}).get("metadata", {})
                    raw = dict(cons.get(var_name, {}).get("attributes", {}))
                except Exception:
                    pass
            if not raw:
                arr_zj = store_root / var_name / "zarr.json"
                if arr_zj.exists():
                    try:
                        raw = dict(json.loads(arr_zj.read_text()).get("attributes", {}))
                    except Exception:
                        pass
        # Strip time dimension from _ARRAY_DIMENSIONS so zarr.js sees a 2-D array.
        dims = raw.get("_ARRAY_DIMENSIONS", [])
        if "time" in dims:
            raw["_ARRAY_DIMENSIONS"] = [d for d in dims if d != "time"]
        return Response(
            content=json.dumps(raw),
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=300",
                     "Access-Control-Allow-Origin": "*"},
        )

    # ── {var}/.zarray ────────────────────────────────────────────────────────
    if filename == ".zarray":
        var_name = chunk_path[: chunk_path.rfind("/.zarray")]
        zarray_2d = _synthesise_2d_zarray(store_path_str, var_name)
        if zarray_2d is None:
            raise HTTPException(404, f"Array '{var_name}' not found in store")
        return Response(
            content=json.dumps(zarray_2d),
            media_type="application/json",
            headers={"Cache-Control": "public, max-age=300",
                     "Access-Control-Allow-Origin": "*"},
        )

    # ── Chunk data ───────────────────────────────────────────────────────────
    # chunk_path is "{var}/{i}.{j}" or just "{i}.{j}" for scalar arrays.
    parts = chunk_path.rsplit("/", 1)
    if len(parts) == 2:
        var_name, spatial_key = parts
    else:
        # No variable prefix — could be an unrecognised metadata probe (e.g.
        # zarr.json at root without a slash).  Return 404 so clients fall back.
        raise HTTPException(404, f"Not found: {chunk_path}")

    # Validate that spatial_key looks like dot-separated integers.
    # Non-integer leaves are metadata probes (e.g. var/zarr.json) — return 404.
    if not all(p.isdigit() for p in spatial_key.split(".")):
        raise HTTPException(404, f"Not found: {chunk_path}")

    # Build the real 3-D chunk key.  For v2 stores: "{t}.{j}.{i}".
    # For v3 stores: "c/{t}/{j}/{i}" (slash-separated, under a c/ prefix).
    spatial_parts = spatial_key.split(".")
    is_v3_store = (store_root / "zarr.json").exists()
    if is_v3_store:
        v3_parts = [str(t_idx)] + spatial_parts
        real_key  = "c/" + "/".join(v3_parts)
    else:
        real_key = _map_2d_chunk_to_3d(spatial_key, t_idx)
    chunk_file = (store_root / var_name / real_key).resolve()

    try:
        chunk_file.relative_to(store_root)
    except ValueError:
        raise HTTPException(400, "Path escapes store root")

    # ── Fast path: chunk_t == 1, raw bytes travel verbatim ──────────────────
    chunk_t = _chunk_t_for_var(store_path_str, var_name)
    if chunk_t == 1 and chunk_file.exists():
        data = chunk_file.read_bytes()
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={
                "Cache-Control"             : "public, max-age=3600",
                "Access-Control-Allow-Origin": "*",
                "X-Content-Type-Options"    : "nosniff",
                "X-Zarr-Fhr"               : str(fhr),
                "X-Zarr-Tidx"              : str(t_idx),
            },
        )

    # A chunk_t=1 array may be sparse (for example, a 4-hour HREF product has
    # no chunks before its first complete window). Zarr supplies fill data for
    # an absent chunk; this is not a rechunking problem. Only warn when a real
    # multi-time chunk forces decode → slice → re-encode.
    sparse_fill = chunk_t == 1 and not chunk_file.exists()
    if not sparse_fill:
        import warnings
        warnings.warn(
            f"[zarr_proxy] slow path for {source_id}/{cycle}/fhr/{fhr}/{chunk_path} "
            f"(chunk_t={chunk_t}). Rechunk the time axis to chunk size 1 "
            "to enable direct chunk serving.",
            stacklevel=1,
        )
    try:
        data = _serve_slow_path(store_path_str, var_name, spatial_key, t_idx)
    except Exception as exc:
        raise HTTPException(500, f"Could not serve chunk: {exc}") from exc

    path_headers = (
        {"X-Zarr-Sparse-Fill": "1"}
        if sparse_fill
        else {"X-Zarr-SlowPath": "1"}
    )
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Cache-Control"             : "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
            "X-Content-Type-Options"    : "nosniff",
            "X-Zarr-Fhr"               : str(fhr),
            "X-Zarr-Tidx"              : str(t_idx),
            **path_headers,
        },
    )


# ── Route ordering ─────────────────────────────────────────────────────────────
# zarr_forecast_chunk  must be matched BEFORE  zarr_chunk because Starlette tries
# routes in registration order and zarr_chunk's catch-all  /{source_id}/{key}/{chunk_path:path}
# would otherwise consume every forecast URL before the more-specific forecast
# route (with its literal "fhr" segment) gets a chance to match.
#
# We swap them here rather than restructure the file, so the helpers can stay
# next to the route they support.
_fi = next(
    (i for i, r in enumerate(router.routes)
     if getattr(r, "path", "") == "/{source_id}/{cycle}/fhr/{fhr}/{chunk_path:path}"),
    None,
)
_ai = next(
    (i for i, r in enumerate(router.routes)
     if getattr(r, "path", "") == "/{source_id}/{key}/{chunk_path:path}"),
    None,
)
if _fi is not None and _ai is not None and _ai < _fi:
    router.routes[_ai], router.routes[_fi] = router.routes[_fi], router.routes[_ai]
