"""
readers/grib2_reader.py — GRIB2 format reader

GRIB2 is the standard format for NWP model output from NCEP (GFS, NAM,
RAP, HRRR, HREF, etc.) and ECMWF. Reading GRIB2 requires cfgrib, which
wraps eccodes.

─── Installation ────────────────────────────────────────────────────────────
    conda install -c conda-forge cfgrib eccodes   # recommended
    pip install cfgrib                             # also works

─── Variable selection ──────────────────────────────────────────────────────
GRIB2 files contain many messages (one per variable/level/time). cfgrib
uses 'filter_by_keys' to select specific messages.

The var_map for GRIB2 can contain either:
  a) Simple string — treated as 'shortName', e.g. '2t' for 2m temperature
  b) Dict — used as filter_by_keys directly, e.g.:
     { 'shortName': 'gh', 'typeOfLevel': 'isobaricInhPa', 'level': 500 }

─── Analysis vs Forecast ────────────────────────────────────────────────────
For analysis grids (RAP anl, HRRR anl): only one time step exists in the
file, no fhr selection needed.

For forecast grids (GFS f006, NAM f024, etc.): the file may contain only
one forecast hour already (NCEP splits by fhr), or multiple hours (WMO GRIB).
The `fhr` parameter selects the right step when multiple exist.
"""

import numpy as np
from pathlib import Path
from datetime import datetime, timezone, timedelta

from .base import Reader, GriddedResult, GridInfo


class Grib2Reader(Reader):
    format_name = "grib2"

    def can_read(self, path: Path) -> bool:
        return path.suffix in (".grib2", ".grb2", ".grib", ".grb")

    async def read_gridded(
        self,
        path    : Path,
        var_map : dict[str, str | dict],
        level   : str | None = None,
        fhr     : int | None = None,
    ) -> list[GriddedResult]:
        """
        Read gridded variables from a GRIB2 file using cfgrib.

        var_map examples:
            Simple:  { 't2m': '2t', 'u10': '10u', 'v10': '10v' }
            Filters: { 'gh500': {'shortName': 'gh',
                                 'typeOfLevel': 'isobaricInhPa',
                                 'level': 500} }
        """
        try:
            import cfgrib
            import xarray as xr
        except ImportError:
            raise ImportError(
                "cfgrib and xarray are required for GRIB2 reading.\n"
                "Install with: conda install -c conda-forge cfgrib xarray eccodes"
            )

        results = []

        for generic_name, selector in var_map.items():
            try:
                ds = self._open_grib2_variable(path, selector, fhr)
            except Exception as e:
                print(f"[grib2_reader] Could not read '{generic_name}' "
                      f"from {path.name}: {e}")
                continue

            grid       = self._ds_to_grid_info(ds)
            valid_time = self._get_valid_time(ds)
            cycle      = self._get_cycle(ds)
            fhr_val    = self._get_fhr(ds, fhr)
            units      = self._get_units(ds, selector)

            # Extract the data array — xarray variable selection
            # Use the first data variable in the dataset
            var_names = [v for v in ds.data_vars if v not in ('latitude', 'longitude')]
            if not var_names:
                continue

            data_arr = ds[var_names[0]].values
            if data_arr.ndim == 3:
                # Multiple time steps — select by fhr
                idx      = min(fhr if fhr is not None else 0, data_arr.shape[0] - 1)
                data_arr = data_arr[idx]
            data_arr = data_arr.astype(np.float32)

            results.append(GriddedResult(
                variable   = generic_name,
                units      = units,
                data       = data_arr.flatten().tolist(),
                grid       = grid,
                valid_time = valid_time,
                cycle      = cycle,
                fhr        = fhr_val,
                metadata   = {
                    "grib_shortname": selector if isinstance(selector, str)
                                      else selector.get('shortName', ''),
                    "level"         : level or (
                        selector.get('level') if isinstance(selector, dict) else None
                    ),
                },
            ))

        return results

    def _open_grib2_variable(self, path, selector, fhr):
        """Open a specific GRIB2 message as an xarray Dataset."""
        import cfgrib
        import xarray as xr

        if isinstance(selector, str):
            filter_keys = {'shortName': selector}
        else:
            filter_keys = dict(selector)

        # If fhr specified and file might have multiple steps, add step filter
        if fhr is not None and 'stepRange' not in filter_keys:
            filter_keys['stepRange'] = str(fhr)

        datasets = cfgrib.open_datasets(
            str(path),
            filter_by_keys=filter_keys,
            indexpath=str(path) + ".idx",  # cache the index for fast re-reads
        )
        if not datasets:
            raise ValueError(f"No GRIB2 messages matched filter {filter_keys}")
        return datasets[0]

    def _ds_to_grid_info(self, ds) -> GridInfo:
        """Build GridInfo from an xarray Dataset's coordinate arrays."""
        import xarray as xr

        lat = ds.coords.get('latitude',  ds.coords.get('lat'))
        lon = ds.coords.get('longitude', ds.coords.get('lon'))

        if lat is None or lon is None:
            return GridInfo(
                grid_type='plate_carree',
                ni=1, nj=1,
                lat_min=-90, lat_max=90,
                lon_min=-180, lon_max=180,
                dx=1.0, dy=1.0,
            )

        lat_vals = lat.values
        lon_vals = lon.values

        if lat_vals.ndim == 2:
            nj, ni = lat_vals.shape
        else:
            nj, ni = len(lat_vals), len(lon_vals)
            lat_vals_2d = lat_vals
            lon_vals_2d = lon_vals

        # Detect projection from dataset attributes
        grid_type   = 'plate_carree'
        proj_params = {}
        if hasattr(ds, 'attrs'):
            grid_type_attr = ds.attrs.get('GRIB_gridType', '')
            if 'lambert' in grid_type_attr.lower():
                grid_type = 'lambert'
                proj_params = {
                    'lat_0': ds.attrs.get('GRIB_LaDInDegrees', 25),
                    'lon_0': ds.attrs.get('GRIB_LoVInDegrees', -95),
                    'lat_1': ds.attrs.get('GRIB_Latin1InDegrees', 25),
                    'lat_2': ds.attrs.get('GRIB_Latin2InDegrees', 25),
                }

        if lat_vals.ndim == 1:
            dy = abs(float(lat_vals[1] - lat_vals[0])) if len(lat_vals) > 1 else 1.0
            dx = abs(float(lon_vals[1] - lon_vals[0])) if len(lon_vals) > 1 else 1.0
        else:
            dy = abs(float(lat_vals[1,0] - lat_vals[0,0]))
            dx = abs(float(lon_vals[0,1] - lon_vals[0,0]))

        return GridInfo(
            grid_type   = grid_type,
            ni          = ni,
            nj          = nj,
            lat_min     = float(lat_vals.min()),
            lat_max     = float(lat_vals.max()),
            lon_min     = float(lon_vals.min()),
            lon_max     = float(lon_vals.max()),
            dx          = dx,
            dy          = dy,
            proj_params = proj_params,
        )

    def _get_valid_time(self, ds) -> str:
        import pandas as pd
        for key in ('valid_time', 'time'):
            val = ds.coords.get(key)
            if val is not None:
                t = pd.Timestamp(val.values.flat[0])
                return t.strftime("%Y-%m-%dT%H:%M:%SZ")
        return "unknown"

    def _get_cycle(self, ds) -> str | None:
        import pandas as pd
        val = ds.coords.get('time')
        if val is not None:
            t = pd.Timestamp(val.values.flat[0])
            return t.strftime("%Y%m%d%H")
        return None

    def _get_fhr(self, ds, fhr_override) -> int | None:
        if fhr_override is not None:
            return fhr_override
        step = ds.coords.get('step')
        if step is not None:
            import pandas as pd
            s = pd.Timedelta(step.values.flat[0])
            return int(s.total_seconds() // 3600)
        return None

    def _get_units(self, ds, selector) -> str:
        var_names = [v for v in ds.data_vars if v not in ('latitude', 'longitude')]
        if var_names:
            return ds[var_names[0]].attrs.get('units', 'unknown')
        return 'unknown'
