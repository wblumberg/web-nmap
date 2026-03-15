"""
readers/netcdf_reader.py — NetCDF3/NetCDF4/HDF5 reader

NetCDF is used by many observational and derived datasets:
  - NEXRAD mosaic composites (netCDF4)
  - Satellite retrievals (GOES-R L2, NUCAPS soundings)
  - Reanalysis products (ERA5, CFSR)
  - Scatterometer winds (ASCAT, RapidScat)
  - Ocean buoys (TAO/TRITON, NDBC)

─── Analysis vs Forecast ────────────────────────────────────────────────────
NetCDF files may have a 'time' dimension with multiple steps (e.g. a 48-hour
forecast netCDF from the RUC or an ERA5 monthly download). The `fhr`
parameter selects the right index along the time dimension.

For single-time files (most observational NetCDF), `fhr` is ignored.
"""

import numpy as np
from pathlib import Path
from datetime import datetime, timezone

from .base import Reader, GriddedResult, PointResult, GridInfo


class NetCDFReader(Reader):
    format_name = "netcdf"

    def can_read(self, path: Path) -> bool:
        return path.suffix in (".nc", ".nc4", ".netcdf", ".h5", ".hdf5")

    async def read_gridded(
        self,
        path    : Path,
        var_map : dict[str, str],
        level   : str | None = None,
        fhr     : int | None = None,
    ) -> list[GriddedResult]:
        """
        Read gridded variables from a NetCDF file.

        var_map values are the NetCDF variable names, e.g.:
            { 'temperature': 'TMP_2mAboveGround',
              'dewpoint':     'DPT_2mAboveGround',
              'u_wind':       'UGRD_10mAboveGround' }
        """
        try:
            import xarray as xr
        except ImportError:
            raise ImportError(
                "xarray and netCDF4 are required.\n"
                "Install with: conda install -c conda-forge xarray netCDF4"
            )

        ds      = xr.open_dataset(str(path), mask_and_scale=True)
        results = []

        grid       = self._ds_to_grid_info(ds)
        valid_time = self._get_valid_time(ds, fhr)
        cycle      = self._get_cycle(ds)

        for generic_name, nc_name in var_map.items():
            if nc_name not in ds:
                print(f"[netcdf_reader] Variable '{nc_name}' not in {path.name}")
                continue

            da = ds[nc_name]

            # Handle time dimension
            if 'time' in da.dims and len(da.time) > 1:
                idx = min(fhr if fhr is not None else 0, len(da.time) - 1)
                da  = da.isel(time=idx)
            elif 'time' in da.dims:
                da = da.isel(time=0)

            # Handle vertical level dimension
            if level is not None:
                level_dims = [d for d in da.dims if d in
                              ('level', 'pressure', 'plev', 'lev', 'isobaricInhPa')]
                if level_dims:
                    try:
                        lev_val = float(level.replace('mb','').replace('hPa',''))
                        lev_idx = int(np.argmin(np.abs(
                            ds[level_dims[0]].values - lev_val
                        )))
                        da = da.isel({level_dims[0]: lev_idx})
                    except (ValueError, TypeError):
                        pass

            data_arr = da.values.astype(np.float32)
            # Squeeze out any remaining size-1 dimensions
            data_arr = np.squeeze(data_arr)

            results.append(GriddedResult(
                variable   = generic_name,
                units      = da.attrs.get('units', 'unknown'),
                data       = data_arr.flatten().tolist(),
                grid       = grid,
                valid_time = valid_time,
                cycle      = cycle,
                fhr        = fhr,
                metadata   = {
                    "long_name": da.attrs.get('long_name', generic_name),
                    "nc_name"  : nc_name,
                    "level"    : level,
                },
            ))

        ds.close()
        return results

    async def read_points(
        self,
        path    : Path,
        var_map : dict[str, str],
        bbox    : tuple | None = None,
    ) -> PointResult:
        """
        Read point data from a NetCDF file (e.g. buoy obs, sounding profiles,
        scatterometer swaths stored as 1-D arrays of lat/lon/value).
        """
        try:
            import xarray as xr
        except ImportError:
            raise ImportError("xarray is required: conda install -c conda-forge xarray")

        ds         = xr.open_dataset(str(path), mask_and_scale=True)
        valid_time = self._get_valid_time(ds, None)

        # Identify coordinate variables
        lat_name = next((v for v in ('lat','latitude','LAT') if v in ds), None)
        lon_name = next((v for v in ('lon','longitude','LON') if v in ds), None)

        if lat_name is None or lon_name is None:
            ds.close()
            raise ValueError(f"Cannot find lat/lon in {path.name}")

        lats = ds[lat_name].values.flatten()
        lons = ds[lon_name].values.flatten()
        n    = len(lats)

        points = []
        for i in range(n):
            lat = float(lats[i])
            lon = float(lons[i])

            # Apply bounding box filter
            if bbox is not None:
                lo_min, la_min, lo_max, la_max = bbox
                if not (lo_min <= lon <= lo_max and la_min <= lat <= la_max):
                    continue

            pt = {'lat': lat, 'lon': lon}
            for generic_name, nc_name in var_map.items():
                if nc_name in ds:
                    val = ds[nc_name].values.flatten()
                    pt[generic_name] = float(val[i]) if i < len(val) else None
            points.append(pt)

        ds.close()
        return PointResult(
            source_type = 'netcdf_points',
            valid_time  = valid_time,
            points      = points,
        )

    def _ds_to_grid_info(self, ds) -> GridInfo:
        lat_name = next((v for v in ('lat','latitude','y') if v in ds.coords), None)
        lon_name = next((v for v in ('lon','longitude','x') if v in ds.coords), None)

        if lat_name and lon_name:
            lat_vals = ds.coords[lat_name].values
            lon_vals = ds.coords[lon_name].values
            if lat_vals.ndim == 1 and lon_vals.ndim == 1:
                return GridInfo(
                    grid_type = 'plate_carree',
                    ni=len(lon_vals), nj=len(lat_vals),
                    lat_min=float(lat_vals.min()), lat_max=float(lat_vals.max()),
                    lon_min=float(lon_vals.min()), lon_max=float(lon_vals.max()),
                    dx=abs(float(lon_vals[1]-lon_vals[0])) if len(lon_vals)>1 else 1.0,
                    dy=abs(float(lat_vals[1]-lat_vals[0])) if len(lat_vals)>1 else 1.0,
                )

        # Fallback
        return GridInfo(
            grid_type='plate_carree',
            ni=1, nj=1,
            lat_min=-90, lat_max=90,
            lon_min=-180, lon_max=180,
            dx=1.0, dy=1.0,
        )

    def _get_valid_time(self, ds, fhr) -> str:
        import pandas as pd
        for name in ('time', 'valid_time', 'TIME'):
            if name in ds.coords:
                t_arr = ds.coords[name].values
                idx = 0
                if hasattr(t_arr, '__len__') and len(t_arr) > 1 and fhr is not None:
                    idx = min(fhr, len(t_arr)-1)
                t = pd.Timestamp(t_arr.flat[idx] if hasattr(t_arr,'flat') else t_arr)
                return t.strftime("%Y-%m-%dT%H:%M:%SZ")
        return "unknown"

    def _get_cycle(self, ds) -> str | None:
        import pandas as pd
        for name in ('time', 'init_time', 'cycle_time'):
            if name in ds.coords:
                t = pd.Timestamp(ds.coords[name].values.flat[0])
                return t.strftime("%Y%m%d%H")
        return None
