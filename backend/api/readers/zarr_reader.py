"""
readers/zarr_reader.py — Zarr format reader

Zarr is a chunked, compressed array format ideal for serving gridded
meteorological data over HTTP. It is the native format for many cloud-
optimized datasets (HRRR-Zarr, ERA5 on AWS, etc.).

─── zarr vs NetCDF ──────────────────────────────────────────────────────────
Zarr and NetCDF4 are conceptually similar (both are chunked array stores)
but Zarr is better suited for web serving because:
  - Chunks can be fetched individually over HTTP (partial reads)
  - No need to decompress the whole file to read one variable
  - The autumnplot-gl docs use Zarr as their primary example format

For a local workstation, either works fine.

─── Analysis vs Forecast ────────────────────────────────────────────────────
Analysis grids (RAP analysis, HRRR analysis, MRMS) have a single time
dimension or no time dimension at all.

Forecast grids (GFS, NAM, RAP fhrs) have a 'time' or 'step' dimension.
We use `fhr` to select the correct time step.
"""

import numpy as np
from pathlib import Path
from datetime import datetime, timezone

from .base import Reader, GriddedResult, GridInfo


class ZarrReader(Reader):
    format_name = "zarr"

    def can_read(self, path: Path) -> bool:
        # Zarr stores are directories with a .zattrs file, or .zarr extension
        if path.is_dir() and (path / ".zattrs").exists():
            return True
        # Zarr v3 stores use zarr.json at the root
        if path.is_dir() and (path / "zarr.json").exists():
            return True
        return path.suffix in (".zarr",) or path.name.endswith(".zarr")

    def _open_store(self, path: Path):
        """Open a Zarr store, handling both v2 and v3 on-disk formats.

        Opening priority:
          1. v3 (zarr.json at root)  — open normally
          2. v2 (.zgroup at root)    — open with zarr_format=2
          3. v2 without .zgroup      — some writers omit .zgroup; write the
                                       marker if child arrays have .zarray,
                                       then retry.
        """
        import json
        import zarr

        def _is_no_group(exc: Exception) -> bool:
            return 'No group found' in str(exc) or 'no group' in str(exc).lower()

        # --- Attempt 1: let zarr auto-detect (handles v3 and well-formed v2) ---
        try:
            return zarr.open_group(str(path), mode='r')
        except Exception as e1:
            if not _is_no_group(e1):
                raise

        # --- Attempt 2: explicit v2 (in case auto-detect chose the wrong format) ---
        try:
            return zarr.open_group(str(path), mode='r', zarr_format=2)
        except Exception as e2:
            if not _is_no_group(e2):
                raise RuntimeError(
                    f"Could not open Zarr store at {path}: {e2}"
                ) from e1

        # --- Attempt 3: v2 store with missing .zgroup root marker ---
        # Some writers (old xarray + zarr <2.12, or custom tools) write valid
        # .zarray/.zattrs inside each variable subdirectory but omit the root
        # .zgroup file.  We detect this pattern and write the trivial marker.
        zgroup_path = path / '.zgroup'
        if path.is_dir() and not zgroup_path.exists():
            has_arrays = any(
                (child / '.zarray').exists()
                for child in path.iterdir()
                if child.is_dir()
            )
            if has_arrays:
                zgroup_path.write_text(json.dumps({"zarr_format": 2}))
                try:
                    return zarr.open_group(str(path), mode='r', zarr_format=2)
                except Exception as e3:
                    raise RuntimeError(
                        f"Could not open Zarr store at {path} after writing .zgroup: {e3}"
                    ) from e3

        raise RuntimeError(
            f"Could not open Zarr store at {path}: unrecognised format "
            f"(no zarr.json, .zgroup, or child .zarray files found)"
        )

    async def read_gridded(
        self,
        path    : Path,
        var_map : dict[str, str],
        level   : str | None = None,
        fhr     : int | None = None,
    ) -> list[GriddedResult]:
        """
        Read gridded variables from a Zarr store.

        The var_map values are the Zarr array names inside the store.
        Example:
            var_map = { 'temperature': 'TMP', 'dewpoint': 'DPT' }
        """
        try:
            import zarr
        except ImportError:
            raise ImportError("zarr is not installed. Run: pip install zarr")

        store    = self._open_store(path)
        results  = []

        # Read grid information from the store's global attributes
        grid = self._read_grid_info(store)
        #print(grid)

        # Read the valid time
        #print(store, fhr)
        valid_time, cycle, fhr_val = self._read_time_info(store, fhr)
        #print(valid_time, cycle, fhr_val)

        for generic_name, zarr_name in var_map.items():
            if zarr_name not in store:
                print(f"[DEBUG zarr] Variable '{zarr_name}' NOT found in store. Available: {list(store.keys())}")
                continue
            
            arr   = store[zarr_name]
            attrs = dict(arr.attrs)
            print(f"[DEBUG zarr] Reading '{zarr_name}' (generic='{generic_name}'): shape={arr.shape} dtype={arr.dtype} attrs={attrs}")
            
            # Select forecast step and normalize to (nj, ni).
            dims = tuple(attrs.get('_ARRAY_DIMENSIONS', ()))
            data_array = arr[:]

            if data_array.ndim >= 3:
                if 'time' in dims:
                    t_axis = dims.index('time')
                else:
                    # Common fallback: first axis is time.
                    t_axis = 0
                t_idx = self._fhr_to_index(store, fhr) if fhr is not None else 0
                t_idx = min(t_idx, data_array.shape[t_axis] - 1)
                data_array = np.take(data_array, indices=t_idx, axis=t_axis)

            # If stored as (x, y), transpose to (y, x) so flattening matches
            # the expected row-major (nj, ni) orientation.
            if data_array.ndim == 2 and len(dims) >= 2:
                remaining_dims = tuple(d for d in dims if d != 'time')
                if remaining_dims[:2] in (('x', 'y'), ('lon', 'lat')):
                    data_array = data_array.T

            print(f"[DEBUG zarr] data_array after time select: shape={data_array.shape} dtype={data_array.dtype} "
                  f"first5={data_array.flatten()[:5].tolist()}")

            # ── Float16 pass-through ──────────────────────────────────────────
            # If the source array is already float16, skip the int16 quantization
            # round-trip.  Physical values and NaN fill are preserved exactly,
            # saving CPU time and avoiding unnecessary precision loss.
            if data_array.dtype == np.float16:
                print(f"[DEBUG zarr] float16 pass-through '{generic_name}': shape={data_array.shape}")
                results.append(GriddedResult(
                    variable     = generic_name,
                    units        = attrs.get('units', 'unknown'),
                    data         = data_array.flatten(),
                    grid         = grid,
                    valid_time   = valid_time,
                    cycle        = cycle,
                    fhr          = fhr_val,
                    fill_value   = float('nan'),
                    scale_factor = 1.0,
                    add_offset   = 0.0,
                    data_type    = 'float16',
                    metadata     = {
                        "long_name"  : attrs.get('long_name', generic_name),
                        "zarr_name"  : zarr_name,
                        "level"      : level,
                        "array_dims" : list(dims),
                    },
                ))
                continue

            # ── Quantize to int16 ────────────────────────────────────────────
            # CF-convention: physical = packed * scale_factor + add_offset
            # Sentinel fill value: -32768 (int16 minimum)
            data_f32 = data_array.astype(np.float32)
            valid_mask = np.isfinite(data_f32)
            valid_vals = data_f32[valid_mask]

            if valid_vals.size > 0:
                data_min = float(valid_vals.min())
                data_max = float(valid_vals.max())
                # Map the valid data range into int16 range [-32767, 32767]
                # (reserve -32768 as the fill/missing sentinel)
                int16_range = 65534.0  # = 32767 - (-32767)
                if data_max > data_min:
                    scale_factor = (data_max - data_min) / int16_range
                else:
                    scale_factor = 1.0
                add_offset = data_min + 32767.0 * scale_factor
            else:
                scale_factor = 1.0
                add_offset   = 0.0

            packed = np.full(data_f32.shape, -32768, dtype=np.int16)
            if scale_factor != 0.0:
                quantized = np.round((data_f32 - add_offset) / scale_factor).astype(np.int32)
                quantized = np.clip(quantized, -32767, 32767)
                packed[valid_mask] = quantized[valid_mask].astype(np.int16)

            print(f"[DEBUG zarr] int16 quantize '{generic_name}': "
                  f"scale={scale_factor:.6g} offset={add_offset:.6g} "
                  f"fill_count={(~valid_mask).sum()} total={data_f32.size}")

            results.append(GriddedResult(
                variable     = generic_name,
                units        = attrs.get('units', 'unknown'),
                data         = packed.flatten(),
                grid         = grid,
                valid_time   = valid_time,
                cycle        = cycle,
                fhr          = fhr_val,
                fill_value   = -32768,
                scale_factor = scale_factor,
                add_offset   = add_offset,
                data_type    = 'int16',
                metadata     = {
                    "long_name"  : attrs.get('long_name', generic_name),
                    "zarr_name"  : zarr_name,
                    "level"      : level,
                    "array_dims" : list(dims),
                },
            ))

        return results

    async def list_forecast_hours(
        self,
        path: Path,
        var_map: dict[str, str] | None = None,
    ) -> list[int]:
        """
        Infer available forecast-hour indices from a Zarr store.

        This is used for one-file-per-cycle datasets where forecast steps
        are stored along a time dimension inside the same file/store.
        """
        try:
            import zarr
        except ImportError:
            raise ImportError("zarr is not installed. Run: pip install zarr")

        store = self._open_store(path)

        # Prefer an explicit time coordinate array when present.
        if 'time' in store:
            fhrs = self._time_coord_to_fhrs(store)
            if fhrs is not None:
                return fhrs
            # init time unknown — fall back to sequential indices
            return list(range(int(store['time'].shape[0])))

        # No 'time' coordinate — inspect data variable dimensions/shapes.
        candidates: list[str] = []
        if var_map:
            candidates.extend(var_map.values())
        candidates.extend(list(store.keys()))

        seen = set()
        for name in candidates:
            if name in seen or name not in store:
                continue
            seen.add(name)

            arr = store[name]
            shape = getattr(arr, 'shape', ())
            if not shape:
                continue

            dims = tuple(dict(arr.attrs).get('_ARRAY_DIMENSIONS', ()))
            if 'time' in dims:
                t_idx = dims.index('time')
                # Try to compute real fhrs from a time coordinate if it
                # appeared under a different name keyed off a dimension.
                return list(range(int(shape[t_idx])))

            # Fallback heuristic for arrays shaped like (time, y, x) or (time, x, y).
            if len(shape) >= 3:
                return list(range(int(shape[0])))

        return []

    async def read_grid_info(self, path) -> GridInfo:
        """Extract grid metadata from Zarr store attributes."""
        try:
            import zarr
        except ImportError:
            raise ImportError("zarr is not installed. Run: pip install zarr")        

        store = self._open_store(path)
        return self._read_grid_info(store)

    def _read_grid_info(self, store) -> GridInfo:
        """Extract grid metadata from Zarr store attributes."""        
        attrs = dict(store.attrs) if hasattr(store, 'attrs') else {}

        print(attrs)
        # TODO: Be able to read in lambert grids
        if attrs.get('grid_type') == 'lambert':
            lat_min = float(attrs.get('lat_min', attrs.get('ll_lat', -90)))
            lat_max = float(attrs.get('lat_max', attrs.get('ur_lat', 90)))
            lon_min = float(attrs.get('lon_min', attrs.get('ll_lon', -180)))
            lon_max = float(attrs.get('lon_max', attrs.get('ur_lon', 180)))

            # HREF-style stores often provide one spacing field in km.
            spacing = attrs.get('dx', attrs.get('grid_spacing_km', 1.0))
            dx = float(spacing)
            dy = float(attrs.get('dy', spacing))

            proj_params = attrs.get('proj_params')
            if not isinstance(proj_params, dict):
                proj_params = {
                    'lat_0': attrs.get('lat_0'),
                    'lon_0': attrs.get('lon_0'),
                    'lat_1': attrs.get('lat_std', attrs.get('lat_1')),
                    'lat_2': attrs.get('lat_std', attrs.get('lat_2')),
                }

            return GridInfo(
                grid_type = 'lambert',
                ni        = int(attrs.get('ni', attrs.get('nx', 0))),
                nj        = int(attrs.get('nj', attrs.get('ny', 0))),
                lat_min   = lat_min,
                lat_max   = lat_max,
                lon_min   = lon_min,
                lon_max   = lon_max,
                dx        = dx,
                dy        = dy,
                proj_params = proj_params,
            )
        elif attrs.get('grid_type') == 'geostationary':
            print("Detected geostationary grid based on attributes.")
            print(attrs)
            return GridInfo(
                grid_type = 'geostationary',
                ni        = int(attrs.get('ni', attrs.get('nx', 0))),
                nj        = int(attrs.get('nj', attrs.get('ny', 0))),
                ll_y      = float(attrs.get('ll_y', -90)),
                ur_y      = float(attrs.get('ur_y', 90)),
                ll_x      = float(attrs.get('ll_x', -180)),
                ur_x      = float(attrs.get('ur_x', 180)),
                sat_lon   = float(attrs.get('sat_lon', 0)),
                proj_params = attrs.get('proj_params', {}),
            )

        # Try to read lat/lon arrays if they exist
        lat_arr = store['lat'][:] if 'lat' in store else None
        lon_arr = store['lon'][:] if 'lon' in store else None

        if lat_arr is not None and lon_arr is not None:
            # 2-D coordinate arrays (curvilinear/projected grids)
            if lat_arr.ndim == 2:
                nj, ni = lat_arr.shape
                return GridInfo(
                    grid_type = attrs.get('grid_type', 'plate_carree'),
                    ni=ni, nj=nj,
                    lat_min=float(lat_arr.min()), lat_max=float(lat_arr.max()),
                    lon_min=float(lon_arr.min()), lon_max=float(lon_arr.max()),
                    dx=abs(float(lon_arr[0,1] - lon_arr[0,0])),
                    dy=abs(float(lat_arr[1,0] - lat_arr[0,0])),
                    proj_params=attrs.get('proj_params', {}),
                )
            else:
                # 1-D coordinate arrays (rectilinear/plate carree grid)
                return GridInfo(
                    grid_type = 'plate_carree',
                    ni=len(lon_arr), nj=len(lat_arr),
                    lat_min=float(lat_arr.min()), lat_max=float(lat_arr.max()),
                    lon_min=float(lon_arr.min()), lon_max=float(lon_arr.max()),
                    dx=abs(float(lon_arr[1] - lon_arr[0])),
                    dy=abs(float(lat_arr[1] - lat_arr[0])),
                )

        # Fall back to attributes
        return GridInfo(
            grid_type = attrs.get('grid_type', 'plate_carree'),
            ni        = int(attrs.get('ni', attrs.get('nx', 0))),
            nj        = int(attrs.get('nj', attrs.get('ny', 0))),
            lat_min   = float(attrs.get('lat_min', -90)),
            lat_max   = float(attrs.get('lat_max',  90)),
            lon_min   = float(attrs.get('lon_min', -180)),
            lon_max   = float(attrs.get('lon_max',  180)),
            dx        = float(attrs.get('dx', 1.0)),
            dy        = float(attrs.get('dy', 1.0)),
            proj_params = attrs.get('proj_params', {}),
        )

    def _parse_init_time(self, attrs: dict):
        """Parse the model init datetime from Zarr store attributes.

        Handles two common metadata patterns:
          - run_id / init_time / cycle  = '2026041500'  (HREF style)
          - init_date='20260422' + init_cycle='00Z'     (NSSL GEFS style)
        Returns a timezone-aware datetime or None.
        """
        # Pattern 1: single string key that encodes YYYYMMDDHH
        for key in ('run_id', 'init_time', 'cycle'):
            val = attrs.get(key)
            if val:
                for fmt in ("%Y%m%d%H", "%Y%m%d%H%M"):
                    try:
                        return datetime.strptime(str(val), fmt).replace(tzinfo=timezone.utc)
                    except ValueError:
                        continue

        # Pattern 2: separate init_date + init_cycle keys
        init_date  = attrs.get('init_date')
        init_cycle = attrs.get('init_cycle')
        if init_date and init_cycle:
            try:
                hour = int(str(init_cycle).replace('Z', '').strip())
                return datetime.strptime(str(init_date), "%Y%m%d").replace(
                    hour=hour, tzinfo=timezone.utc
                )
            except (ValueError, AttributeError):
                pass

        return None

    def _time_coord_to_fhrs(self, store) -> list[int] | None:
        """Convert a Zarr 'time' coordinate to a list of integer forecast hours.

        Handles two common CF encodings:
          1. float/int values with units="hours since <init>" — values are
             already forecast hours, just cast to int.
          2. int64 nanoseconds since epoch (xarray default) — compute delta
             from parsed init time.

        Returns None if the encoding cannot be determined.
        """
        time_arr = store['time'][:]
        print(f"[zarr] _time_coord_to_fhrs: dtype={time_arr.dtype}, shape={time_arr.shape}, first={time_arr.flat[0] if time_arr.size else 'empty'}")

        # --- Case 1: CF "hours since <date>" units ---
        # The time variable carries a units attr like "hours since 2026-04-22"
        time_attrs = {}
        try:
            time_attrs = dict(store['time'].attrs)
        except Exception:
            pass

        units = time_attrs.get('units', '')
        if isinstance(units, str) and units.lower().startswith('hours since'):
            fhrs = [int(round(float(v))) for v in time_arr]
            print(f"[zarr] _time_coord_to_fhrs (hours-since): fhrs[:5]={fhrs[:5]}")
            return fhrs

        # --- Case 2: int64 nanoseconds since epoch ---
        if not np.issubdtype(time_arr.dtype, np.integer):
            # Not a recognised encoding.
            return None

        attrs   = dict(store.attrs) if hasattr(store, 'attrs') else {}
        init_dt = self._parse_init_time(attrs)
        if init_dt is None:
            print(f"[zarr] _time_coord_to_fhrs: could not parse init time from attrs")
            return None

        init_ns   = np.datetime64(init_dt.replace(tzinfo=None), 'ns').astype('int64')
        deltas_ns = time_arr.astype('int64') - init_ns
        ns_per_hour = int(3.6e12)
        fhrs = [int(round(d / ns_per_hour)) for d in deltas_ns]
        print(f"[zarr] _time_coord_to_fhrs (ns-epoch): init={init_dt.isoformat()}, fhrs[:5]={fhrs[:5]}")
        return fhrs

    def _fhr_to_index(self, store, fhr: int) -> int:
        """Return the time-array index that corresponds to `fhr` hours after init.

        Falls back to using fhr directly as an index when the store has no
        'time' coordinate or when the encoding cannot be determined.
        """
        if 'time' not in store:
            return fhr

        try:
            time_arr = store['time'][:]

            # Case 1: CF "hours since <date>" — values are already forecast hours.
            time_attrs = {}
            try:
                time_attrs = dict(store['time'].attrs)
            except Exception:
                pass
            units = time_attrs.get('units', '')
            if isinstance(units, str) and units.lower().startswith('hours since'):
                fhr_arr = np.array([float(v) for v in time_arr])
                deltas  = np.abs(fhr_arr - fhr)
                return int(np.argmin(deltas))

            # Case 2: int64 nanoseconds since epoch.
            if np.issubdtype(time_arr.dtype, np.integer):
                attrs   = dict(store.attrs) if hasattr(store, 'attrs') else {}
                init_dt = self._parse_init_time(attrs)
                if init_dt is not None:
                    init_ns   = np.datetime64(init_dt.replace(tzinfo=None), 'ns').astype('int64')
                    target_ns = init_ns + int(fhr) * int(3.6e12)
                    deltas    = np.abs(time_arr.astype('int64') - target_ns)
                    return int(np.argmin(deltas))

        except Exception as e:
            print(f"[zarr] _fhr_to_index: could not resolve fhr={fhr}: {e}")

        return fhr

    def _read_time_info(self, store, fhr_override):
        """Extract valid_time, cycle, and fhr from the store."""
        attrs = dict(store.attrs) if hasattr(store, 'attrs') else {}

        print("Attributes:", attrs)
        fhr_val    = fhr_override
        valid_time = attrs.get('valid_time')

        # Derive a canonical cycle string from whatever attribute pattern is present.
        init_dt = self._parse_init_time(attrs)
        if init_dt is not None:
            cycle = init_dt.strftime("%Y%m%d%H")
        else:
            cycle = attrs.get('init_time') or attrs.get('cycle') or attrs.get('run_id')

        if valid_time is None and init_dt is not None and fhr_val is not None:
            from datetime import timedelta
            v_dt = init_dt + timedelta(hours=fhr_val)
            valid_time = v_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        elif valid_time is None and cycle:
            valid_time = cycle

        return (
            valid_time or "unknown",
            cycle,
            fhr_val,
        )
