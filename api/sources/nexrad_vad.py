"""
NEW_SOURCE_TEMPLATE.py
══════════════════════════════════════════════════════════════════════════════

HOW TO ADD A NEW DATA SOURCE TO THE WEBNMAP API
------------------------------------------------

Step 1  Copy this file to api/sources/my_new_source.py
Step 2  Fill in the sections marked TODO below
Step 3  Add the source to SOURCES in api/sources/registry.py
Step 4  Add a VIEW_REGISTRY entry in src/config/views.js
Step 5  Run `uvicorn api.main:app --reload` and open /docs to verify

That's it. No changes to routers, readers, or any other file are needed
unless your source requires a completely new file format (in which case
add a reader in api/readers/).

══════════════════════════════════════════════════════════════════════════════

DECISION GUIDE: which data type is my source?
─────────────────────────────────────────────

  Data type              | Router endpoint          | Reader method
  ───────────────────────┼──────────────────────────┼──────────────���─────
  2-D gridded field      | /gridded/{id}/field       | read_gridded()
  (MRMS, RAP, GFS, etc.) | /gridded/{id}/forecast    |
  ───────────────────────┼──────────────────────────┼────────────────────
  Discrete point obs     | /points/{id}/features     | read_points()
  (METARs, buoys, ACARS) | /points/{id}/window       |
  ───────────────────────┼──────────────────────────┼────────────────────
  Accumulating point     | /points/{id}/lsrs         | read_points()
  events (LSRs, PIREPs)  | /points/{id}/window       |
  ───────────────────────┼──────────────────────────┼────────────────────
  Polygon / polyline     | /geometries/{id}/features | read_geometries()
  (WWA, outlooks, fronts)| /geometries/{id}/by_type  |
  ───────────────────────┼──────────────────────────┼────────────────────
  Lightning strikes      | /lightning/strikes        | read_points()
  (time-age color coding)|                           |   (with age calc)
  ───────────────────────┼──────────────────────────┼────────────────────
  Scatterometer swath    | /points/{id}/features     | read_points()
  (ASCAT, RapidScat)     |   + bbox param            |   or read_gridded()

══════════════════════════════════════════════════════════════════════════════

FILE FORMAT GUIDE: which reader handles my files?
─────────────────────────────────────────────────

  Format          | File extensions        | Reader class
  ────────────────┼────────────────────────┼───────────────────────
  Zarr store      | .zarr  (directory)     | ZarrReader
  GRIB2           | .grib2 .grb2 .grb      | Grib2Reader
  NetCDF / HDF5   | .nc .nc4 .h5 .hdf5     | NetCDFReader
  GeoJSON         | .geojson .json         | GeoJSONReader
                  | .geojson.gz .json.gz   |
  ────────────────┼────────────────────────┼───────────────────────
  New format?     | Any extension          | Create api/readers/myformat_reader.py
                  |                        | Subclass Reader, implement can_read()
                  |                        | and whichever of read_gridded /
                  |                        | read_points / read_geometries applies.
                  |                        | Add to READERS list in readers/__init__.py

══════════════════════════════════════════════════════════════════════════════
"""

from pathlib import Path
from .filesystem import FilesystemSource


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1: Define the source
# ══════════════════════════════════════════════════════════════════════════════

NEXRAD_VAD = FilesystemSource(

    # TODO: Replace with a short all-caps identifier.
    # This string is used in API URLs: /api/v1/gridded/MY_SOURCE/field
    # and in the JavaScript VIEW_REGISTRY source_id field.
    source_id_ = "NEXRAD_VAD",

    # TODO: Replace with a human-readable label shown in the UI dropdown.
    label_ = "NEXRAD Velocity Azimuth Display Wind Profiles",

    # TODO: Replace with the directory where your data files live.
    # Can be a string or pathlib.Path.
    # Tip: use an environment variable so the path is configurable:
    #   import os
    #   data_dir = os.environ.get("MY_SOURCE_DIR", "/data/my_source")
    data_dir = "/data/processed/vad/",

    # TODO: Replace with a glob pattern that matches your files.
    # Examples:
    #   "*.grib2"                       — all GRIB2 files
    #   "rap.t*.wrfprsf*.grib2"         — RAP forecast GRIB2
    #   "mrms.*.cref.bin.gz"            — MRMS composite reflectivity
    #   "lsrs.*.geojson.gz"             — LSR GeoJSON files
    #   "ascat_*.nc"                    — ASCAT scatterometer NetCDF
    filename_glob = "NEXRAD.VWP.summary.*.nc",

    # TODO: Replace with a regex that extracts the valid time from filenames.
    #
    # Named groups that FilesystemSource recognizes:
    #   year, month, day, hour, minute, second   — valid time components
    #   cyear, cmonth, cday, chour               — model cycle time
    #   fhr                                      — forecast hour (integer)
    #
    # Examples:
    #
    #   Files: mrms.202503021800.cref.bin.gz
    #   Regex: r"mrms\.(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})(?P<hour>\d{2})(?P<minute>\d{2})"
    #
    #   Files: rap.t18z.wrfprsf06.grib2   (cycle=18Z, fhr=06)
    #   Regex: r"rap\.t(?P<hour>\d{2})z\.wrfprsf(?P<fhr>\d{2})"
    #   + cycle_regex / fhr_regex as separate patterns below
    #
    #   Files: lsrs.20250302_1800.geojson.gz
    #   Regex: r"lsrs\.(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})_(?P<hour>\d{2})(?P<minute>\d{2})"
    #
    time_regex = (
        r"NEXRAD\.VWP\.summary\."
        r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
        r"\.(?P<hour>\d{2})(?P<minute>\d{2})(?P<second>\d{2})"
    ),

    # TODO (optional): If files contain model cycle info, add a cycle_regex.
    # Leave as None for observation / analysis sources.
    # Example:
    #   Files: gfs.t00z.pgrb2.0p25.f024
    #   cycle_regex = r"gfs\.t(?P<chour>\d{2})z"
    cycle_regex = None,

    # TODO (optional): If files contain forecast hour info, add an fhr_regex.
    # Leave as None for analysis / observation sources.
    # Example:
    #   Files: gfs.t00z.pgrb2.0p25.f024
    #   fhr_regex = r"\.f(?P<fhr>\d{3})"
    fhr_regex = None,
)


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2: Variable mapping
# ══════════════════════════════════════════════════════════════════════════════
#
# Maps generic JavaScript variable names → file-specific variable names.
# The JavaScript side always uses the generic names; the API translates them.
#
# This dict is read by the gridded/points routers when building var_map.
# The key is what the JS side requests; the value is what the file contains.
#
# Examples:
#   GRIB2 RAP: { 't2m': '2t', 'u10': '10u', 'v10': '10v',
#                'mslp': 'msl', 'cape': 'cape', 'cin': 'cin' }
#   NetCDF:    { 'temperature': 'TMP_2mAboveGround',
#                'dewpoint':    'DPT_2mAboveGround' }
#   GeoJSON:   {}   ← properties pass through unchanged
#
# Leave empty ({}) if the file variable names match the generic names,
# or if this source serves GeoJSON (properties are passed through as-is).
#
NEXRAD_VAD.variable_map = {
    # TODO: Add your variable mappings here.
    # "generic_js_name": "file_variable_name",

    # GRIDDED examples:
    # "t2m":    "TMP_2mAboveGround",
    # "td2m":   "DPT_2mAboveGround",
    # "u10":    "UGRD_10mAboveGround",
    # "v10":    "VGRD_10mAboveGround",
    # "mslp":   "PRMSL_meansealevel",
    # "cape":   "CAPE_surface",
    # "ref":    "MergedReflectivityQC",

    # POINT examples:
    # "station_id": "STID",
    # "tmpf":        "air_temperature_F",
    # "dwpf":        "dewpoint_F",
    # "wind_speed":  "wind_speed_kt",
    # "wind_dir":    "wind_direction",

    # GEOMETRY examples (leave empty if GeoJSON properties are already correct):
    # "event":   "prod_type",
    # "expires": "expiration_time",
}

# Optional: set the data category so routers can document it correctly.
# Values: 'gridded_analysis', 'gridded_forecast', 'point_obs',
#         'point_events', 'geometry_polygon', 'geometry_line'
NEXRAD_VAD.data_category = "point_obs"  # TODO: change this


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3: Register the source in registry.py
# ══════════════════════════════════════════════════════════════════════════════
#
# In api/sources/registry.py, add:
#
#   from .my_new_source import MY_NEW_SOURCE
#
#   SOURCES: dict[str, FilesystemSource] = {
#       ...existing sources...
#       "MY_SOURCE": MY_NEW_SOURCE,
#   }
#
# ══════════════════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4: Add a VIEW_REGISTRY entry in src/config/views.js
# ══════════════════════════════════════════════════════════════════════════════
#
# In src/config/views.js, add an entry like this to VIEW_REGISTRY:
#
#   'my_source_view': {
#       label:      'My New Source — Short Description',
#       group:      'basic',   // see getActiveGroups() for valid group IDs
#
#       // Must match the source_id_ you chose in Section 1:
#       source_id:  'MY_SOURCE',
#
#       // Must match a key in api/products/index.js (or misc.js):
#       product_id: 'my_product',
#
#       maxZoom:    8,
#
#       // Time configuration — choose ONE of these patterns:
#
#       // A) Analysis / observation source (no forecast hours):
#       time:          { valid_time: null },
#       available_fhrs: null,
#
#       // B) Forecast source with discrete forecast hours:
#       time:          { cycle: '2025030200', fhr: 0 },
#       available_fhrs: [0, 1, 2, 3, 6, 9, 12, 15, 18, 21, 24],
#
#       // Variable map passed to the API as query parameters.
#       // Keys are the generic names; values are format-specific names
#       // (same as MY_NEW_SOURCE.variable_map above):
#       var_map: { 't2m': 'TMP_2mAboveGround' },
#   },
#
# ════════════════════════════════��═════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5: Add a product in src/products/
# ══════════════════════════════════════════════════════════════════════════════
#
# In src/products/my_product.js (or add to an existing products file):
#
#   export default {
#       'my_product': {
#           label:         'My New Product',
#           group:         'basic',
#           available_for: ['MY_SOURCE'],
#           data_keys:     ['t2m'],   // must match var_map keys above
#
#           make_layers(data, grid) {
#               // data.t2m.data is a Float32Array (converted from the API response)
#               // data.t2m.grid has .ni, .nj, .lat_min, .lon_min, .dx, .dy
#               const field = new apgl.RawScalarField(
#                   makeGrid(data.t2m.grid),   // your grid factory
#                   new Float32Array(data.t2m.data)
#               );
#               const fill  = new apgl.ContourFill(field, { cmap: myColormap });
#               const layer = new apgl.PlotLayer('my_fill', fill);
#               return {
#                   layers:   [layer],
#                   colorbar: [apgl.makeColorBar(myColormap, { label: 'Temp (°F)' })],
#                   sampler:  (lon, lat) => ({ t2m: field.sampleField(lon, lat) }),
#               };
#           },
#       },
#   };
#
# ══════════════════════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 6 (optional): Custom reader for a new file format
# ══════════════════════════════════════════════════════════════════════════════
#
# If your files are in a format not already handled (not Zarr/GRIB2/NetCDF/
# GeoJSON), create api/readers/myformat_reader.py:
#
#   from .base import Reader, GriddedResult, PointResult, GeometryResult
#   from pathlib import Path
#
#   class MyFormatReader(Reader):
#       format_name = "myformat"
#
#       def can_read(self, path: Path) -> bool:
#           return path.suffix == ".myext"
#
#       async def read_gridded(self, path, var_map, level=None, fhr=None):
#           # Open the file, extract arrays, return list[GriddedResult]
#           ...
#
#       # Implement read_points() and/or read_geometries() if applicable.
#
# Then add it to api/readers/__init__.py:
#
#   from .myformat_reader import MyFormatReader
#   READERS = [
#       ZarrReader(),
#       Grib2Reader(),
#       NetCDFReader(),
#       GeoJSONReader(),
#       MyFormatReader(),   ← add here
#   ]
#
# ══════════════════════════════════════════════════════════════════════════════
