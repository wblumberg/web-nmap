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
            
            # Select time step for forecast grids
            data_array = arr[:]
            if data_array.ndim == 3:
                # Shape: (time, nj, ni) — select by fhr index
                t_idx = fhr if fhr is not None else 0
                t_idx = min(t_idx, data_array.shape[0] - 1)
                data_array = data_array[t_idx]
            elif data_array.ndim == 2:
                # Shape: (nj, ni) — analysis grid, no time selection needed
                pass

            print(f"[DEBUG zarr] data_array after time select: shape={data_array.shape} dtype={data_array.dtype} "
                  f"min={np.nanmin(data_array):.4f} max={np.nanmax(data_array):.4f} "
                  f"nan_count={np.isnan(data_array.astype(float)).sum()} "
                  f"first5={data_array.flatten()[:5].tolist()}")

            # Replace fill value with NaN
            fill = attrs.get('_FillValue', attrs.get('missing_value', -9999))
            data_array = data_array.astype(np.float16)
            print(f"[DEBUG zarr] After float16 cast: min={np.nanmin(data_array):.4f} max={np.nanmax(data_array):.4f}")
            data_array_replaced = np.nan_to_num(data_array, nan=0)
            print(f"[DEBUG zarr] After nan_to_num: min={data_array_replaced.min():.4f} max={data_array_replaced.max():.4f} "
                  f"zero_count={(data_array_replaced == 0).sum()} total={data_array_replaced.size}")

            #try:
            #    data_array[data_array >= fill * 0.99] = np.nan
            #except:
            #    print("Cannot multiply")
            
            results.append(GriddedResult(
                variable   = generic_name,
                units      = attrs.get('units', 'unknown'),
                data       = data_array_replaced.flatten().tolist(),
                grid       = grid,
                valid_time = valid_time,
                cycle      = cycle,
                fhr        = fhr_val,
                fill_value = 0,
                metadata   = {
                    "long_name"  : attrs.get('long_name', generic_name),
                    "zarr_name"  : zarr_name,
                    "level"      : level,
                },
            ))

        return results

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
            return GridInfo(
                grid_type = 'lambert',
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
        cycle      = attrs.get('init_time') or attrs.get('cycle')
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
