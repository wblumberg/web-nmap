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
        return path.suffix in (".zarr",) or path.name.endswith(".zarr")

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

        store    = zarr.open(str(path), mode='r')
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
                t_idx = fhr if fhr is not None else 0
                t_idx = min(t_idx, data_array.shape[t_axis] - 1)
                data_array = np.take(data_array, indices=t_idx, axis=t_axis)

            # If stored as (x, y), transpose to (y, x) so flattening matches
            # the expected row-major (nj, ni) orientation.
            if data_array.ndim == 2 and len(dims) >= 2:
                remaining_dims = tuple(d for d in dims if d != 'time')
                if remaining_dims[:2] in (('x', 'y'), ('lon', 'lat')):
                    data_array = data_array.T

            print(f"[DEBUG zarr] data_array after time select: shape={data_array.shape} dtype={data_array.dtype} "
                  f"min={np.nanmin(data_array):.4f} max={np.nanmax(data_array):.4f} "
                  f"nan_count={np.isnan(data_array.astype(float)).sum()} "
                  f"first5={data_array.flatten()[:5].tolist()}")

            # Quantize to int16 using CF-convention scale_factor / add_offset.
            # physical = packed * scale_factor + add_offset
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

        store = zarr.open(str(path), mode='r')

        # Prefer an explicit time coordinate array when present.
        if 'time' in store:
            try:
                return list(range(int(store['time'].shape[0])))
            except Exception:
                pass

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

        store = zarr.open(str(path), mode='r')
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

    def _read_time_info(self, store, fhr_override):
        """Extract valid_time, cycle, and fhr from the store."""
        attrs = dict(store.attrs) if hasattr(store, 'attrs') else {}

        print("Attributes:", attrs)
        cycle      = attrs.get('init_time') or attrs.get('cycle') or attrs.get('run_id')
        valid_time = attrs.get('valid_time')
        fhr_val    = fhr_override

        if valid_time is None and cycle and fhr_val is not None:
            # Compute valid time from cycle + fhr
            from datetime import timedelta
            try:
                c_dt = datetime.strptime(cycle, "%Y%m%d%H").replace(tzinfo=timezone.utc)
                v_dt = c_dt + timedelta(hours=fhr_val)
                valid_time = v_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                valid_time = cycle

        return (
            valid_time or "unknown",
            cycle,
            fhr_val,
        )
