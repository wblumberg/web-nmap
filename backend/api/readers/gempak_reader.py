"""
readers/gempak_reader.py — GEMPAK format reader using MetPy

Handles all three GEMPAK file types via MetPy's IO classes:
  - GempakGrid     → GriddedResult   (gridded model/analysis data)
  - GempakSurface  → PointResult     (METARs, ship reports, climate obs)
  - GempakSounding → PointResult     (rawinsonde / upper-air soundings)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GEMPAK FILE NAMING AND TEMPORAL STRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GEMPAK does not follow a single naming convention — the convention depends
on the data type and the site's configuration.  Common patterns:

GRID files (one cycle per file, one fhr per grid parameter):
    YYYYMMDD_HHMM         e.g.  20250302_1800          (RAP anl, one cycle)
    YYYYMMDD_HHMMfFFF     e.g.  20250302_1800f024      (GFS fhr 024)
    YYYYMMDDHH.gem        e.g.  2025030218.gem          (NAWIPS convention)
    model_YYYYMMDDHH      e.g.  rap_2025030218.gem

SURFACE files (multiple obs times per file — daily or hourly):
    YYYYMMDD_sfc.gem      ← daily file: all obs for one calendar day
    YYYYMMDDHH_sfc.gem    ← hourly file: obs for one synoptic hour
    surface_YYYYMMDD.gem  ← another common convention
    YYMMDDsf.gem          ← old GEMPAK 5 convention

SOUNDING files (multiple launch times per file — daily):
    YYYYMMDD_snds.gem     ← daily file: 00Z and 12Z soundings
    YYMMDDsn.gem          ← old convention

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SURFACE / SOUNDING TEMPORAL COMPLICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Unlike gridded files where each file IS one valid time, surface and sounding
GEMPAK files typically CONTAIN multiple valid times:

  - A daily surface file (20250302_sfc.gem) holds all METAR obs from
    0000 UTC through 2359 UTC on that date.
  - A daily sounding file (20250302_snds.gem) holds 00Z and 12Z launches.

This means:
  1. FilesystemSource.list_times() extracts the *file* date from the filename.
     That date represents the range of times the file covers, not one
     specific obs time.
  2. read_points() must be called with a `target_dt` and `window_minutes`
     so it can select observations inside the file that fall within that
     window.
  3. The GempakFilesystemSource (below) overrides list_times() to expose
     *individual obs times* from within files rather than file-level dates,
     which lets the normal timematch and window endpoints work correctly.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GRID NAVIGATION → autumnplot-gl GridInfo
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MetPy's GempakGrid stores a navigation_block with:
  navigation_block.projection        — GEMPROJ string (LCC, CED, MER, STR, …)
  navigation_block.proj_angle1/2/3   — projection angles (lat_0, lon_0, etc.)
  navigation_block.lower_left_lat/lon
  navigation_block.upper_right_lat/lon
  obj.kx, obj.ky                     — grid dimensions (ni, nj)
  obj.lat, obj.lon                   — 2-D meshgrid arrays (from _set_coordinates)
  obj.x, obj.y                       — 1-D projection-space coordinate arrays

After MetPy calls _get_crs() + _set_coordinates(), the 2-D lat/lon arrays
are available.  We use them to build a GridInfo whose grid_type matches
the autumnplot-gl Grid constructors, and whose proj_params let GridFactory.js
construct the correct apgl Grid on the JavaScript side.
"""

import math
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

import numpy as np
from metpy.io.gempak import GempakFile, FileTypes

from .base import Reader, GriddedResult, PointResult, GridInfo

# MetPy GEMPROJ → autumnplot-gl grid_type mapping
# MetPy's _get_crs uses pyproj internally; we translate the same projection
# type to the string autumnplot-gl's GridFactory.js understands.
_GEMPROJ_TO_APGL = {
    'LCC': 'lambert',
    'SCC': 'lambert',
    'CED': 'plate_carree',
    'MCD': 'plate_carree',      # Mercator-ish but close enough for display
    'MER': 'plate_carree',
    'STR': 'polar_stereo',
    'NPS': 'polar_stereo',
    'SPS': 'polar_stereo',
    'AED': 'azimuthal_equidist',
    'NOR': 'orthographic',
    'SOR': 'orthographic',
    'LEA': 'laea',
    'GNO': 'gnomonic',
    'TVM': 'transverse_mercator',
    'UTM': 'transverse_mercator',
}


class GempakReader(Reader):
    """
    Reader for all GEMPAK file types (grid, surface, sounding).

    Auto-detects the file type by attempting to open it with each MetPy
    GEMPAK class in order: GempakGrid → GempakSurface → GempakSounding.
    """

    format_name = "gempak"

    # File extensions that indicate GEMPAK format
    _GEMPAK_EXTENSIONS = {'.gem', '.grd', '.sfc', '.snd', '.gem2', ''}

    def can_read(self, path: Path) -> bool:
        """
        Return True for files with known GEMPAK extensions.

        GEMPAK files have no magic bytes at a fixed offset (unlike NetCDF or
        GRIB2), so extension-based detection is the most reliable approach.
        The GempakFile base class does validate the header on open, which
        will raise if the file is not actually GEMPAK format.
        """
        # Accept .gem, .grd, .sfc, .snd, and extensionless files in
        # directories named 'gempak' or 'gem'
        if path.suffix.lower() in self._GEMPAK_EXTENSIONS:
            return True
        # Many GEMPAK files have no extension at all (e.g. '2025030218')
        # Detect them by checking parent directory name
        parent = path.parent.name.lower()
        if path.suffix == '' and any(kw in parent for kw in ('gem', 'gempak', 'grid')):
            return True
        return False

    # ─── Gridded data ─────────────────────────────────────────────────────────

    async def read_gridded(
        self,
        path    : Path,
        var_map : dict[str, str],
        level   : str | None = None,
        fhr     : int | None = None,
    ) -> list[GriddedResult]:
        """
        Read one or more gridded variables from a GEMPAK grid file.

        var_map values are GEMPAK parameter names (PARM column in gdinfo),
        optionally combined with a level selector using a colon:

            Simple (use `level` param for level):
                { 'tmpc': 'TMPC', 'hght': 'HGHT' }

            With embedded level (overrides `level` param):
                { 'tmpc_500': 'TMPC:500', 'hght_500': 'HGHT:500' }

        GEMPAK vertical coordinate conventions:
            level=500   → 500 mb isobaric surface (PRES coord)
            level=0     → surface / single level
            level=-1    → layer-average (uses LEVEL1/LEVEL2)

        fhr selects the forecast hour when the file contains multiple times.
        For analysis files (fhr=None), the first available time is used.
        """
        try:
            from metpy.io import GempakGrid
        except ImportError:
            raise ImportError(
                "MetPy is required for GEMPAK reading.\n"
                "Install with: conda install -c conda-forge metpy"
            )

        gf = GempakGrid(str(path))

        grid_info  = self._nav_to_grid_info(gf)
        all_grids  = gf.gdinfo()                  # list of Grid namedtuples
        results    = []

        for generic_name, parm_spec in var_map.items():
            # Parse 'PARM:LEVEL' or plain 'PARM'
            parm_name, lev_override = _parse_parm_spec(parm_spec)
            lev_val = lev_override if lev_override is not None else _parse_level(level)

            # Find matching grid entries
            candidates = _filter_gdinfo(all_grids, parm_name, lev_val, fhr, source_path=path)
            if not candidates:
                print(f"[gempak_reader] No grid found for PARM='{parm_name}' "
                      f"LEV={lev_val} FHR={fhr} in {path.name}")
                continue

            # Use the first match (most grids have one entry per parm/level/time)
            grid_entry = candidates[0]

            # Read the data via xarray backend
            # MetPy's GempakGrid.to_xarray() parameter names:
            #   - date_time: the DATTIM1 datetime from the grid header
            #   - parameter: PARM name
            #   - level1: first level
            #   - level2: second level (for layers; -1 if unused)
            #   - vertical_coordinate: GVCD string
            ds = gf.gdxarray(
                date_time           = grid_entry.DATTIM1,
                parameter           = parm_name,
                level              = grid_entry.LEVEL1,
                level2              = grid_entry.LEVEL2,
                coordinate = grid_entry.COORD,
            )   

            if ds is None or len(ds.data_vars) == 0:
                print(f"[gempak_reader] gdxarray returned empty for '{parm_name}'")
                continue

            var_name  = list(ds.data_vars)[0]
            da        = ds[var_name]
            data_arr  = np.squeeze(da.values).astype(np.float32)

            # Replace GEMPAK missing (-9999, 9.999e20) with NaN
            data_arr = np.where(
                (data_arr <= -9999) | (data_arr >= 9.999e19),
                np.nan,
                data_arr,
            )
            
            valid_dt = grid_entry.DATTIM2 or grid_entry.DATTIM1
            valid_time = _dattim_to_iso(valid_dt)
            cycle, fhr_val = _infer_grid_cycle_fhr(grid_entry, source_path=path)


            results.append(GriddedResult(
                variable   = generic_name,
                units      = da.attrs.get('units', 'unknown'),
                data       = data_arr.flatten().tolist(),
                grid       = grid_info,
                valid_time = valid_time,
                cycle      = cycle,
                fhr        = fhr_val,
                metadata   = {
                    "gempak_parm"  : parm_name,
                    "gempak_level" : lev_val,
                    "gempak_coord" : str(grid_entry.COORD),
                    "level"        : level,
                },
            ))

        return results

    # ─── Point data: Surface observations ────────────────────────────────────

    async def read_points(
        self,
        path           : Path,
        var_map        : dict[str, str],
        bbox           : tuple | None = None,
        target_dt      : datetime | None = None,
        window_minutes : int = 0,
    ) -> PointResult:
        """
        Read surface observations or soundings from a GEMPAK file.

        Auto-detects whether the file is a surface or sounding file and
        dispatches accordingly.

        Parameters:
            path           : GEMPAK surface or sounding file
            var_map        : { generic_name: GEMPAK_PARM }
                             e.g. { 'tmpf': 'TMPF', 'dwpf': 'DWPF',
                                    'wind': 'SKNT' }
                             Pass {} to include all available parameters.
            bbox           : Optional (lon_min, lat_min, lon_max, lat_max) filter
            target_dt      : Center time for obs selection.
                             When None, all obs in the file are returned.
            window_minutes : Half-width of the time window around target_dt.
                             Obs with |obs_time - target_dt| > window_minutes
                             are excluded.
                             0 means return all obs regardless of time.

        ── Why target_dt + window_minutes? ──────────────────────────────────
        A daily GEMPAK surface file covers 24 hours of METAR reports.
        Without filtering, read_points() would return thousands of obs
        from unrelated times.  Passing target_dt='2025-03-02 18:00 UTC'
        and window_minutes=30 returns only obs between 17:30 and 18:30.
        """
        try:
            from metpy.io import GempakSurface, GempakSounding
        except ImportError:
            raise ImportError("MetPy is required: conda install -c conda-forge metpy")

        # ── Detect file type ─────────────────────────────────────────────────
        file_type = _detect_gempak_type(path)

        if file_type == 'surface':
            return await self._read_surface(
                path, var_map, bbox, target_dt, window_minutes
            )
        elif file_type == 'sounding':
            return await self._read_sounding(
                path, var_map, bbox, target_dt, window_minutes
            )
        else:
            raise ValueError(
                f"Cannot determine GEMPAK file type for '{path.name}'. "
                f"Expected a surface or sounding file."
            )

    async def _read_surface(
        self,
        path           : Path,
        var_map        : dict[str, str],
        bbox           : tuple | None,
        target_dt      : datetime | None,
        window_minutes : int,
    ) -> PointResult:
        """Read GEMPAK surface observation file."""
        from metpy.io import GempakSurface

        gf      = GempakSurface(str(path))
        sfinfo  = gf.sfinfo()       # list of Surface namedtuples

        # ── Select obs times within window ───────────────────────────────────
        # sfinfo[i].DATTIM is a datetime object (from MetPy _make_date/_make_time)
        selected_times = _select_times_in_window(
            [sf.DATTIM for sf in sfinfo],
            target_dt,
            window_minutes,
        )

        points = []
        missing = gf.prod_desc.missing_float    # typically -9999.0

        for sf in sfinfo:
            # Time filter
            obs_dt = _ensure_utc(sf.DATTIM)
            if selected_times is not None and obs_dt not in selected_times:
                continue

            # Spatial filter
            lat = float(sf.LAT)
            lon = float(sf.LON)
            if bbox is not None:
                lo_min, la_min, lo_max, la_max = bbox
                if not (lo_min <= lon <= lo_max and la_min <= lat <= la_max):
                    continue

            # Read this station's data via xarray
            try:
                ds = gf.sfjson(
                    date_time  = sf.DATTIM,
                    station_id = sf.ID.strip(),
                )
            except Exception as e:
                print(f"[gempak_reader] Skipping {sf.ID}: {e}")
                continue

            if ds is None:
                continue
            #print(ds)
            # Build the point dict
            pt = {
                'station_id' : sf.ID.strip(),
                'lat'        : lat,
                'lon'        : lon,
                'elev_m'     : float(sf.ELEV),
                'state'      : sf.STATE.strip() if hasattr(sf, 'STATE') else '',
                'country'    : sf.COUNTRY.strip() if hasattr(sf, 'COUNTRY') else '',
                'time'       : obs_dt.timestamp(),
                'time_str'   : obs_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }

            # Extract requested variables (or all if var_map is empty)
            pt.update(_extract_ds_vars(ds, var_map, missing))

            points.append(pt)

        valid_time_str = (
            target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            if target_dt else
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        )

        return PointResult(
            source_type = 'gempak_surface',
            valid_time  = valid_time_str,
            points      = points,
            metadata    = {
                'file'           : path.name,
                'surface_type'   : gf.surface_type,
                'window_minutes' : window_minutes,
                'total_in_file'  : len(sfinfo),
                'returned'       : len(points),
            },
        )

    async def _read_sounding(
        self,
        path           : Path,
        var_map        : dict[str, str],
        bbox           : tuple | None,
        target_dt      : datetime | None,
        window_minutes : int,
    ) -> PointResult:
        """
        Read GEMPAK sounding file.

        Each sounding is returned as a single point with the vertical profile
        data serialized as arrays in the point's properties.  The profile
        data is structured so the JavaScript side can display it as a skew-T
        or use individual levels for cross-sections.

        Structure of each point:
            {
              'station_id': 'OUN',
              'lat': 35.22, 'lon': -97.46, 'elev_m': 357,
              'time': 1740960000,
              'levels': {
                'pres':  [1000, 925, 850, 700, 500, ...],   # hPa
                'hght':  [357,  743, 1457, 3012, ...],      # m MSL
                'tmpC':  [22.0, 18.4, 12.0, ...],
                'dwpC':  [18.0, 10.2, -2.0, ...],
                'drct':  [200,  210,  225, ...],             # degrees
                'sped':  [5.0,  8.0,  12.0, ...],           # m/s
              }
            }
        """
        from metpy.io import GempakSounding

        gf     = GempakSounding(str(path))
        sninfo = gf.sninfo()    # list of Sounding namedtuples

        selected_times = _select_times_in_window(
            [sn.DATTIM for sn in sninfo],
            target_dt,
            window_minutes,
        )

        points  = []
        missing = gf.prod_desc.missing_float

        for sn in sninfo:
            obs_dt = _ensure_utc(sn.DATTIM)
            if selected_times is not None and obs_dt not in selected_times:
                continue

            lat = float(sn.LAT)
            lon = float(sn.LON)
            if bbox is not None:
                lo_min, la_min, lo_max, la_max = bbox
                if not (lo_min <= lon <= lo_max and la_min <= lat <= la_max):
                    continue

            try:
                ds = gf.to_xarray(
                    date_time  = sn.DATTIM,
                    station_id = sn.ID.strip(),
                )
            except Exception as e:
                print(f"[gempak_reader] Skipping sounding {sn.ID}: {e}")
                continue

            if ds is None:
                continue

            pt = {
                'station_id' : sn.ID.strip(),
                'lat'        : lat,
                'lon'        : lon,
                'elev_m'     : float(sn.ELEV),
                'state'      : sn.STATE.strip() if hasattr(sn, 'STATE') else '',
                'country'    : sn.COUNTRY.strip() if hasattr(sn, 'COUNTRY') else '',
                'time'       : obs_dt.timestamp(),
                'time_str'   : obs_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                'levels'     : _extract_sounding_levels(ds, var_map, missing),
            }
            points.append(pt)

        valid_time_str = (
            target_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            if target_dt else
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        )

        return PointResult(
            source_type = 'gempak_sounding',
            valid_time  = valid_time_str,
            points      = points,
            metadata    = {
                'file'           : path.name,
                'merged'         : gf.merged,
                'window_minutes' : window_minutes,
                'total_in_file'  : len(sninfo),
                'returned'       : len(points),
            },
        )

    # ─── Grid navigation → GridInfo ───────────────────────────────────────────

    def _nav_to_grid_info(self, gf) -> GridInfo:
        """
        Convert a GempakGrid's navigation block into a GridInfo object.

        MetPy's GempakGrid._set_coordinates() computes:
          gf.kx, gf.ky         — grid dimensions (ni, nj)
          gf.lat, gf.lon       — 2-D arrays of geographic coordinates
          gf.x, gf.y           — 1-D projection-space coordinate arrays
          gf.crs               — pyproj.CRS object

        From these we can directly build the GridInfo dict that autumnplot-gl
        needs.  The proj_params dict mirrors what GridFactory.js uses to
        construct the correct apgl Grid subclass.
        """
        nav = gf.navigation_block
        if nav is None:
            raise ValueError("GEMPAK file has no navigation block")

        gemproj   = nav.projection.strip().upper()
        apgl_type = _GEMPROJ_TO_APGL.get(gemproj, 'plate_carree')

        ni = int(gf.kx)
        nj = int(gf.ky)

        # Use the 2-D lat/lon arrays MetPy already computed
        lat_arr = gf.lat   # shape (nj, ni)
        lon_arr = gf.lon   # shape (nj, ni)

        lat_min = float(lat_arr.min())
        lat_max = float(lat_arr.max())
        lon_min = float(lon_arr.min())
        lon_max = float(lon_arr.max())

        # Grid spacing: use the projection-space 1-D arrays for accuracy
        # gf.x and gf.y are evenly spaced in projection space (metres for
        # projected CRS, degrees for CED/MER)
        x_arr = gf.x  # shape (ni,)
        y_arr = gf.y  # shape (nj,)
        dx    = abs(float(x_arr[1] - x_arr[0])) if len(x_arr) > 1 else 1.0
        dy    = abs(float(y_arr[1] - y_arr[0])) if len(y_arr) > 1 else 1.0

        # Projection parameters — translate from GEMPAK nav block angles
        # to the parameter names GridFactory.js and apgl expect.
        proj_params = _nav_to_proj_params(gemproj, nav)

        # For plate_carree / CED grids, dx/dy are in degrees.
        # For projected grids (LCC, STR, etc.) they are in metres.
        # Store the unit so GridFactory.js can use the right apgl constructor.
        proj_params['dx_units'] = 'degrees' if apgl_type == 'plate_carree' else 'metres'

        # Also store the lower-left corner in geographic and projection coords
        # so GridFactory.js can construct the Grid without needing to re-project.
        proj_params['ll_lon'] = float(nav.lower_left_lon)
        proj_params['ll_lat'] = float(nav.lower_left_lat)
        proj_params['ll_x']   = float(x_arr[0])
        proj_params['ll_y']   = float(y_arr[0])

        return GridInfo(
            grid_type   = apgl_type,
            ni          = ni,
            nj          = nj,
            lat_min     = lat_min,
            lat_max     = lat_max,
            lon_min     = lon_min,
            lon_max     = lon_max,
            dx          = dx,
            dy          = dy,
            proj_params = proj_params,
        )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# GempakFilesystemSource — extends FilesystemSource for GEMPAK's multi-time files
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

from ..sources.types.filesystem import FilesystemSource
from ..sources.types.base import AvailableTime


class GempakFilesystemSource(FilesystemSource):
    """
    FilesystemSource specialised for GEMPAK surface and sounding files.

    ── The multi-time-per-file problem ──────────────────────────────────────

    Standard FilesystemSource.list_times() returns one AvailableTime per
    *file*, deriving the time from the filename.  For GEMPAK surface files
    this is the wrong granularity:

        20250302_sfc.gem contains obs at 0000, 0030, 0100, 0130, …, 2330 UTC.
        FilesystemSource would return a single key '20250302_0000'.
        But the timematch engine needs keys like '20250302_1800',
        '20250302_1830', etc. to match against a RAP forecast cycle.

    GempakFilesystemSource solves this by:

      1. Opening each GEMPAK file (lazily, with caching) and calling
         sfinfo() / sninfo() to enumerate the individual obs times.
      2. list_times() yields one AvailableTime per distinct obs time,
         with path pointing to the containing file.
      3. get_path(key) returns the file that contains the obs with that key.
      4. read_points() is called with target_dt extracted from the key,
         along with window_minutes, so only obs near that time are returned.

    ── Caching ──────────────────────────────────────────────────────────────

    Opening a GEMPAK file (reading its headers) is fast but not free.
    _obs_time_cache maps file path → list of (datetime, key) pairs so we
    only open each file once per process lifetime.  The cache is invalidated
    when a file's mtime changes (new obs appended to a real-time file).

    ── Configuration ────────────────────────────────────────────────────────

    Extra parameters vs FilesystemSource:
        gempak_file_type : 'surface' | 'sounding' | 'grid'
                           If 'grid', behaves identically to FilesystemSource.
        obs_time_step_min: Expected obs interval in minutes (default 60).
                           Used to generate a synthetic key list when the
                           file cannot be opened (e.g. during a write).
        window_minutes   : Default window passed to read_points() calls.
    """

    def __init__(
        self,
        *args,
        gempak_file_type   : str = 'surface',
        obs_time_step_min  : int = 60,
        window_minutes     : int = 30,
        **kwargs,
    ):
        """Initialize the instance."""
        super().__init__(*args, **kwargs)
        self.gempak_file_type  = gempak_file_type
        self.obs_time_step_min = obs_time_step_min
        self.window_minutes    = window_minutes

        # cache: { str(path): { 'mtime': float, 'times': list[AvailableTime] } }
        self._obs_time_cache: dict[str, dict] = {}

    async def list_times(
        self,
        after  : datetime | None = None,
        before : datetime | None = None,
        limit  : int             = 500,
        params : dict[str, Any] | None = None,
    ) -> list[AvailableTime]:
        """
        Return one AvailableTime per individual obs time inside each file.

        For grid files delegates to the parent FilesystemSource.
        For surface/sounding files opens each matching file and enumerates
        the obs times within it.
        """
        if self.gempak_file_type == 'grid':
            return await super().list_times(after=after, before=before, limit=limit, params=params)

        if not self._data_dir.exists():
            return []

        results: list[AvailableTime] = []
        self._cache.clear()

        # Iterate over files matching the glob, newest first
        for file_path in sorted(self._data_dir.glob(self._glob), reverse=True):
            file_times = self._get_obs_times_from_file(file_path)

            for at in file_times:
                vt = at.valid_time

                if after  is not None and vt < after:
                    continue
                if before is not None and vt > before:
                    continue

                # Map each obs-time key to the containing file
                self._cache[at.key] = file_path
                results.append(at)

                if len(results) >= limit:
                    return results

        return results

    def _get_obs_times_from_file(self, file_path: Path) -> list[AvailableTime]:
        """
        Open one GEMPAK file and return an AvailableTime for each obs time.

        Uses a per-file cache keyed on (path, mtime) so files are only
        opened once.  Real-time surface files that are being appended to
        will be re-read when their mtime changes.
        """
        path_str = str(file_path)
        mtime    = file_path.stat().st_mtime

        cached = self._obs_time_cache.get(path_str)
        if cached is not None and cached['mtime'] == mtime:
            return cached['times']

        times = self._open_and_enumerate(file_path)
        self._obs_time_cache[path_str] = {'mtime': mtime, 'times': times}
        return times

    def _open_and_enumerate(self, file_path: Path) -> list[AvailableTime]:
        """
        Open the GEMPAK file and enumerate individual observation times.

        Returns a list of AvailableTime objects, one per distinct
        valid time found in the file.

        Falls back to filename-derived time on any open error.
        """
        try:
            if self.gempak_file_type == 'surface':
                return self._enumerate_surface_times(file_path)
            elif self.gempak_file_type == 'sounding':
                return self._enumerate_sounding_times(file_path)
            else:
                return []
        except Exception as e:
            print(f"[GempakFilesystemSource] Could not enumerate '{file_path.name}': {e}")
            # Fallback: derive a single time from the filename
            vt = self._extract_time(file_path.name)
            if vt is None:
                return []
            key = self._make_key(vt)
            return [AvailableTime(
                valid_time = vt,
                key        = key,
                path       = file_path,
                size_bytes = file_path.stat().st_size,
            )]

    def _enumerate_surface_times(self, file_path: Path) -> list[AvailableTime]:
        """Open a GempakSurface file and return one AvailableTime per obs time."""
        from metpy.io import GempakSurface

        gf       = GempakSurface(str(file_path))
        sfinfo   = gf.sfinfo()
        size     = file_path.stat().st_size

        # Collect unique DATTIM values
        seen:  set[datetime]          = set()
        times: list[AvailableTime]    = []

        for sf in sfinfo:
            vt = _ensure_utc(sf.DATTIM)
            if vt in seen:
                continue
            seen.add(vt)
            key = self._make_key(vt)
            times.append(AvailableTime(
                valid_time = vt,
                key        = key,
                path       = file_path,
                size_bytes = size,
            ))

        # Sort newest first
        return sorted(times, key=lambda t: t.valid_time, reverse=True)

    def _enumerate_sounding_times(self, file_path: Path) -> list[AvailableTime]:
        """Open a GempakSounding file and return one AvailableTime per launch time."""
        from metpy.io import GempakSounding

        gf     = GempakSounding(str(file_path))
        sninfo = gf.sninfo()
        size   = file_path.stat().st_size

        seen:  set[datetime]       = set()
        times: list[AvailableTime] = []

        for sn in sninfo:
            vt = _ensure_utc(sn.DATTIM)
            if vt in seen:
                continue
            seen.add(vt)
            key = self._make_key(vt)
            times.append(AvailableTime(
                valid_time = vt,
                key        = key,
                path       = file_path,
                size_bytes = size,
            ))

        return sorted(times, key=lambda t: t.valid_time, reverse=True)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━��━━━━━━━━━━
# Module-level helper functions
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
from pathlib import Path

def _detect_gempak_type(path: Path) -> str: 
    """  
    Determine whether a GEMPAK file contains grid, surface, or sounding data.

    Strategy (in order):
      1. Extension heuristic (.grd/.grid → grid, .sfc → surface, .snd → sounding)
      2. Filename keyword heuristic (sf/sfc/metar → surface, sn/snd → sounding)
      3. Probe by opening with each MetPy class and check for data
    """
    name  = path.name.lower()
    stem  = path.stem.lower()
    ext   = path.suffix.lower()

    # Extension hints
    if ext in ('.grd', '.grid'):
        return 'grid'
    if ext == '.sfc' or "sao" in name or "syn" in name or "ship" in name:
        return 'surface'
    if ext == '.snd' or "upa" in name:
        return 'sounding'

    # Stem keywords
    if any(kw in stem for kw in ('sfc', '_sf', 'metar', 'surface', 'sfobs')):
        return 'surface'
    if any(kw in stem for kw in ('snd', '_sn', 'sounding', 'raob', 'snds')):
        return 'sounding'
    if any(kw in stem for kw in ('grd', 'grid', 'model', 'anl', 'fcst')):
        return 'grid'

    # Probe by attempting to open and check for data
    print(str(path))
    
    # Try grid first (least likely to false-positive)
    try:
        from metpy.io import GempakGrid
        gf = GempakGrid(str(path))
        if hasattr(gf, 'variables') and gf.variables:  # Check for grid data
            return 'grid'
    except Exception as e:
        print(f"GempakGrid failed: {e}")
        pass

    # Try surface
    try:
        from metpy.io import GempakSurface
        gf = GempakSurface(str(path))
        print(f"Surface data length: {len(gf.data) if hasattr(gf, 'data') else 'N/A'}")
        if hasattr(gf, 'data') and len(gf.data) > 0:  # Check for surface data
            print(f"Detected surface: {gf}")
            return 'surface'
    except Exception as e:
        print(f"GempakSurface failed: {e}")
        pass

    # Try sounding
    try:
        from metpy.io import GempakSounding
        gf = GempakSounding(str(path))
        if hasattr(gf, 'soundings') and len(gf.soundings) > 0:  # Check for sounding data
            print(f"Detected sounding: {gf}")
            return 'sounding'
    except Exception as e:
        print(f"GempakSounding failed: {e}")
        pass

    raise ValueError(f"Cannot determine GEMPAK file type for '{path.name}'")

def _parse_parm_spec(spec: str) -> tuple[str, int | None]:
    """
    Parse a var_map value into (parm_name, level_override).

    Examples:
        'TMPC'      → ('TMPC', None)
        'TMPC:500'  → ('TMPC', 500)
        'HGHT:850'  → ('HGHT', 850)
    """
    if ':' in spec:
        parts = spec.split(':', 1)
        try:
            return parts[0].strip().upper(), int(parts[1].strip())
        except ValueError:
            return parts[0].strip().upper(), None
    return spec.strip().upper(), None


def _parse_level(level_str: str | None) -> int | None:
    """Parse a level string like '500mb', '500hPa', '500', '2m' to an integer."""
    if level_str is None:
        return None
    # Strip common unit suffixes
    cleaned = re.sub(r'(mb|hpa|hPa|Pa|m|ft|km)', '', level_str, flags=re.IGNORECASE)
    try:
        return int(float(cleaned.strip()))
    except (ValueError, TypeError):
        return None

def _filter_gdinfo(
    grids       : list,
    parm        : str,
    level       : int | None,
    fhr         : int | None,
    source_path : Path | None = None,
) -> list:
    """
    Filter gdinfo() Grid namedtuples by parameter name, level, and forecast hour.

    Forecast-hour matching is tolerant of files where DATTIM2 is missing:
    it falls back to filename-based cycle/fhr inference.
    """
    results = []
    for g in grids:
        #print(g.PARM, g.LEVEL1, g.DATTIM1, g.DATTIM2)
        if g.PARM.strip().upper() != parm:
            continue
        if level is not None and int(g.LEVEL1) != level:
            continue
        
        if fhr is not None:
            _, inferred_fhr = _infer_grid_cycle_fhr(g, source_path=source_path)
            #print(f"Inferred fhr: {inferred_fhr} for grid {g.PARM} at level {g.LEVEL1}")

            # If fhr is requested but cannot be inferred, only allow fhr=0 fallback.
            if inferred_fhr is None:
                if fhr != 0:
                    continue
            elif inferred_fhr != fhr:
                continue

        results.append(g)
    return results


def _infer_grid_cycle_fhr(grid, source_path: Path | None = None) -> tuple[str | None, int | None]:
    """
    Infer (cycle, fhr) for a GEMPAK grid entry.

    Priority:
      1) DATTIM1 + DATTIM2 (native forecast metadata)
      2) DATTIM1 as valid time + cycle/fhr from filename
      3) filename-only fallback
    """
    d1 = getattr(grid, 'DATTIM1', None)  # often cycle, but sometimes valid time
    d2 = getattr(grid, 'DATTIM2', None)  # often valid time for forecast grids

    # Standard forecast case
    if d1 is not None and d2 is not None:
        cdt = _ensure_utc(d1)
        vdt = _ensure_utc(d2)
        return cdt.strftime("%Y%m%d%H"), int(round((vdt - cdt).total_seconds() / 3600))

    # DATTIM1-only case: treat DATTIM1 as valid time, infer cycle/fhr from filename
    if d1 is not None:
        valid_dt = _ensure_utc(d1)
        file_cycle = _parse_cycle_from_filename(source_path) if source_path else None
        file_fhr   = _parse_fhr_from_filename(source_path) if source_path else None

        if file_cycle is not None and valid_dt >= file_cycle:
            return file_cycle.strftime("%Y%m%d%H"), int(round((valid_dt - file_cycle).total_seconds() / 3600))

        if file_fhr is not None:
            cycle_dt = valid_dt - timedelta(hours=file_fhr)
            return cycle_dt.strftime("%Y%m%d%H"), file_fhr

        return None, None

    # No grid time metadata at all; filename fallback
    if source_path is not None:
        file_cycle = _parse_cycle_from_filename(source_path)
        file_fhr   = _parse_fhr_from_filename(source_path)
        return (file_cycle.strftime("%Y%m%d%H") if file_cycle else None, file_fhr)

    return None, None


def _parse_cycle_from_filename(path: Path | None) -> datetime | None:
    """Parse a cycle datetime from common GEMPAK filename patterns."""
    if path is None:
        return None
    name = path.name

    # Examples:
    #   20250302_1800f024, 20250302_1800, 2025030218.gem, rap_2025030218.gem
    patterns = [
        r'(?P<ymd>\d{8})[_-]?(?P<hh>\d{2})(?P<mm>\d{2})(?:[fF]\d{1,3})?',
        r'(?P<ymd>\d{8})[_-]?(?P<hh>\d{2})(?:[fF]\d{1,3})?',
    ]

    for pat in patterns:
        m = re.search(pat, name)
        if not m:
            continue
        ymd = m.group('ymd')
        hh = m.group('hh')
        mm = m.groupdict().get('mm') or "00"
        try:
            return datetime.strptime(f"{ymd}{hh}{mm}", "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    return None


def _parse_fhr_from_filename(path: Path | None) -> int | None:
    """Parse forecast hour from filename token like f024."""
    if path is None:
        return None
    m = re.search(r'[fF](\d{1,3})(?!\d)', path.name)
    return int(m.group(1)) if m else None


def _dattim_to_iso(dt: datetime | None) -> str:
    """Convert a GEMPAK DATTIM datetime to an ISO 8601 UTC string."""
    if dt is None:
        return "unknown"
    return _ensure_utc(dt).strftime("%Y-%m-%dT%H:%M:%SZ")


def _dattim_to_cycle_fhr(
    dattim1: datetime | None,
    dattim2: datetime | None,
) -> tuple[str | None, int | None]:
    """
    Derive cycle and forecast hour from a GEMPAK grid's DATTIM1/DATTIM2.

    GEMPAK convention:
        DATTIM1 = analysis/init time (cycle for forecast grids)
        DATTIM2 = valid time for forecast grids; None for analysis grids

    Returns (cycle_string, fhr_int) or (None, None) for analysis grids.
    """
    if dattim1 is None:
        return None, None
    if dattim2 is None:
        # Analysis grid — no cycle/fhr distinction
        return None, None
    cycle  = _ensure_utc(dattim1).strftime("%Y%m%d%H")
    fhr    = int(round((dattim2 - dattim1).total_seconds() / 3600))
    return cycle, fhr


def _nav_to_proj_params(gemproj: str, nav) -> dict:
    """
    Build the proj_params dict from a GEMPAK navigation block.

    The parameter names match what GridFactory.js reads when calling
    the autumnplot-gl Grid constructors.
    """
    gemproj = gemproj.strip().upper()

    # LCC / SCC (Lambert Conformal Conic) — most common for CONUS NWP
    if gemproj in ('LCC', 'SCC'):
        return {
            'lat_1' : float(nav.proj_angle1),
            'lon_0' : float(nav.proj_angle2),
            'lat_2' : float(nav.proj_angle3),
            'lat_0' : float(nav.proj_angle1),  # use lat_1 as lat_0 default
        }

    # CED / MER (Cylindrical Equidistant / Mercator)
    if gemproj in ('CED', 'MER', 'MCD'):
        return {
            'lat_0' : float(nav.proj_angle1),
            'lon_0' : float(nav.proj_angle2),
        }

    # STR / NPS / SPS (Polar Stereographic)
    if gemproj in ('STR', 'NPS', 'SPS'):
        return {
            'lat_0' : float(nav.proj_angle1),   # typically ±90
            'lon_0' : float(nav.proj_angle2),
        }

    # AED / LEA / GNO / NOR / SOR (Azimuthal projections)
    return {
        'lat_0' : float(nav.proj_angle1),
        'lon_0' : float(nav.proj_angle2),
    }


def _select_times_in_window(
    dattims        : list[datetime],
    target_dt      : datetime | None,
    window_minutes : int,
) -> set[datetime] | None:
    """
    Return the set of datetimes that fall within ±window_minutes of target_dt.

    Returns None if target_dt is None or window_minutes is 0,
    meaning "include all times" (no filter).

    The returned set contains timezone-aware UTC datetimes so they can be
    compared directly against _ensure_utc(sf.DATTIM).
    """
    if target_dt is None or window_minutes == 0:
        return None

    target_utc = _ensure_utc(target_dt)
    delta      = timedelta(minutes=window_minutes)
    lo         = target_utc - delta
    hi         = target_utc + delta

    return {
        _ensure_utc(dt)
        for dt in dattims
        if lo <= _ensure_utc(dt) <= hi
    }


def _ensure_utc(dt: datetime) -> datetime:
    """Attach UTC timezone to a naive datetime, or convert to UTC if tz-aware."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _extract_ds_vars(ds, var_map: dict, missing: float) -> dict:
    """
    Extract scalar values from a single-station xarray Dataset.

    If var_map is empty, all variables in the dataset are extracted.
    Values equal to the GEMPAK missing value are replaced with None.
    """
    out = {}

    if var_map:
        items = var_map.items()
    else:
        items = {v: v for v in ds.data_vars}.items()

    for generic_name, gempak_parm in items:
        parm = gempak_parm.strip().upper()
        if parm not in ds:
            continue
        raw = ds[parm].values
        val = float(np.squeeze(raw))
        out[generic_name] = None if (val <= -9998 or val >= 9.9e19 or math.isnan(val)) else val

    return out


def _extract_sounding_levels(ds, var_map: dict, missing: float) -> dict:
    """
    Extract vertical profile arrays from a sounding xarray Dataset.

    Returns a dict of { parm_name: [val0, val1, ...] } where each list
    corresponds to one level in the sounding (surface at index 0).

    NaN and missing values are converted to None for JSON serialisation.
    """
    levels: dict[str, list] = {}

    vars_to_extract = list(var_map.values()) if var_map else list(ds.data_vars)

    for parm in vars_to_extract:
        parm_upper = parm.strip().upper()
        if parm_upper not in ds:
            continue
        arr  = ds[parm_upper].values.flatten()
        vals = []
        for v in arr:
            fv = float(v)
            vals.append(
                None if (fv <= -9998 or fv >= 9.9e19 or math.isnan(fv)) else fv
            )
        # Use the generic name as the key if var_map provided, else GEMPAK parm
        key = next((g for g, p in var_map.items()
                    if p.strip().upper() == parm_upper), parm_upper)
        levels[key] = vals

    return levels
