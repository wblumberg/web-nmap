"""
sources/registry.py — Source Registry

Maps source_id strings to their DataSource implementations.
This is the single place where you add a new data source to the system.

─── How to add a new source ─────────────────────────────────────────────────
1. Create a FilesystemSource (or subclass) with the right glob/regex
2. Add it to the SOURCES dict below
3. The catalog, lightning, observations, and timematch routers all use this
   registry automatically — no other changes needed

─── Filename regex reference ─────────────────────────────────────────────────
Named groups used:
    year, month, day, hour, minute, second  → valid time
    cyear, cmonth, cday, chour              → model cycle time
    fhr                                     → forecast hour (integer)

Example: mrms.20250302185943.MergedReflectivityQC.00.50.bin.gz
    time_regex = r'mrms\\.(?P<year>\\d{4})(?P<month>\\d{2})(?P<day>\\d{2})'
                 r'(?P<hour>\\d{2})(?P<minute>\\d{2})(?P<second>\\d{2})'
"""

import os
from pathlib import Path

from .filesystem import FilesystemSource
from ..readers.gempak_reader import GempakFilesystemSource

from .mesoanalysis import MESO_SOURCE
from .nexrad_vad import NEXRAD_VAD

# ── Configure your local data directories here ────────────────────────────────
# These can also be read from environment variables or a config file.
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

SOURCES: dict[str, FilesystemSource] = {

    # ── MRMS Composite Reflectivity ───────────────────────────────────────────
    # Files: mrms.202503021800.cref.bin.gz
    "MRMS": FilesystemSource(
        source_id_    = "MRMS",
        label_        = "Multiple-Radar/Multi-Sensor (MRMS) Mosaic",
        data_dir      = DATA_ROOT / "grid/mrms",
        filename_glob = "mrms.*.zarr",
        time_regex    = (
            r"mrms\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        # Values: 'gridded_analysis', 'gridded_forecast', 'point_obs',
#         'point_events', 'geometry_polygon', 'geometry_line'
        #data_category  = "gridded_analysis",
    ),

    # ── RAP Analysis (GRIB2) ──────────────────────────────────────────────────
    # Files: rap.t00z.wrfprsf00.grib2  (cycle=t00z, fhr=f00)
    "RAP": FilesystemSource(
        source_id_    = "RAP",
        label_        = "RAP Model Analysis/Forecast",
        data_dir      = DATA_ROOT / "grid/rap",
        filename_glob = "rap.t*.wrfprsf*.grib2",
        # Extract valid time: compute as cycle + fhr
        # For simplicity here we parse only the cycle and treat fhr=0 as the time.
        # A real implementation would add fhr hours to cycle time.
        time_regex    = (
            r"rap\.t"
            r"(?P<hour>\d{2})z"
        ),
        cycle_regex   = (
            r"rap\.t"
            r"(?P<chour>\d{2})z"
        ),
        fhr_regex     = r"wrfprsf(?P<fhr>\d{2})",
        #data_category = "gridded_forecast",
    ),

    # ── Lightning Strikes ─────────────────────────────────────────────────────
    # Files: lightning.20250302_1800.geojson.gz
    "LIGHTNING": FilesystemSource(
        source_id_    = "LIGHTNING",
        label_        = "Lightning Strikes",
        data_dir      = "/data/base/lightning",
        filename_glob = "acad.*.txt",
        time_regex    = (
            r"acad\."
            r"(?P<year>\d{4})\.(?P<month>\d{2})\.(?P<day>\d{2})"
            r"\.(?P<hour>\d{2})\.(?P<minute>\d{2})"
        ),
        # Values: 'gridded_analysis', 'gridded_forecast', 'point_obs',
#         'point_events', 'geometry_polygon', 'geometry_line'
        #data_category = "point_obs"
    ),

    # ── Surface Observations ─────────────────────────────────────────────────
    # Files: surface.20250302_1800.json.gz
    "SURFACE_OBS": FilesystemSource(
        source_id_    = "SURFACE_OBS",
        label_        = "Surface Observations (METARs)",
        data_dir      = DATA_ROOT / "point/surface",
        filename_glob = "surface.*.json.gz",
        time_regex    = (
            r"surface\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── West Texas Mesonet Observations ─────────────────────────────────────
    # Files: surface.20250302_1800.json.gz
    "WTXMESO_OBS": FilesystemSource(
        source_id_    = "WTXMESO_OBS",
        label_        = "West Texas Mesonet Surface Observations",
        data_dir      = "/data/base/wtxmeso",
        filename_glob = "wtxmeso_*.json",
        time_regex    = (
            r"wtxmeso_"
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"\.(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),


    # ── Ship Observations ─────────────────────────────────────────────────
    # Files: ship.20250302_1800.json.gz
    "SHIP_OBS": FilesystemSource(
        source_id_    = "SHIP_OBS",
        label_        = "Ship Observations",
        data_dir      = DATA_ROOT / "point/ship",
        filename_glob = "ship.*.json.gz",
        time_regex    = (
            r"ship\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── Ship Observations ─────────────────────────────────────────────────
    # Files: ship.20250302_1800.json.gz
    "SYNOPTIC_OBS": FilesystemSource(
        source_id_    = "SYNOPTIC_OBS",
        label_        = "Synoptic-API Observations",
        data_dir      = DATA_ROOT / "point/synoptic",
        filename_glob = "synoptic.*.json.gz",
        time_regex    = (
            r"synoptic\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── AQI Observations ─────────────────────────────────────────────────
    # Files: aqi.20250302_1800.json.gz
    "AQI_OBS": FilesystemSource(
        source_id_    = "AQI_OBS",
        label_        = "Air Quality Now Observations",
        data_dir      = DATA_ROOT / "point/aqi",
        filename_glob = "aqi.*.json.gz",
        time_regex    = (
            r"aqi\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
    ),

    # ── Synoptic Radiosonde (00/12 UTC) Observations ─────────────────────────────────────────────────
    # Files: raob.20250302_1800.json.gz
    "RAOB_OBS": FilesystemSource(
        source_id_    = "RAOB_OBS",
        label_        = "Radiosonde Observations",
        data_dir      = DATA_ROOT / "point/upperair",
        filename_glob = "raob.*.json.gz",
        time_regex    = (
            r"raob\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── NEXRAD VAD Observations ─────────────────────────────────────────────────
    # Files: vad.20250302_1800.json.gz
    "VAD_OBS": FilesystemSource(
        source_id_    = "VAD_OBS",
        label_        = "NEXRAD VAD Observations",
        data_dir      = DATA_ROOT / "vad",
        filename_glob = "vad.*.json.gz",
        time_regex    = (
            r"vad\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── ACARS Observations ─────────────────────────────────────────────────
    # Files: acars.20250302_1800.json.gz
    "ACARS_OBS": FilesystemSource(
        source_id_    = "ACARS_OBS",
        label_        = "ACARS Observations",
        data_dir      = DATA_ROOT / "point/acars",
        filename_glob = "acars.*.json.gz",
        time_regex    = (
            r"acars\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── RECON Observations ─────────────────────────────────────────────────
    # Files: recon.20250302_1800.json.gz
    "RECON_OBS": FilesystemSource(
        source_id_    = "RECON_OBS",
        label_        = "Aircraft RECON Observations",
        data_dir      = DATA_ROOT / "point/recon",
        filename_glob = "recon.*.json.gz",
        time_regex    = (
            r"recon\."
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
            r"_(?P<hour>\d{2})(?P<minute>\d{2})"
        ),
        #data_category = "point_obs"
    ),

    # ── GEMPAK gridded — RAP (one file per cycle, multiple fhrs inside) ───────
    # Files: rap_2025030218.gem  or  2025030218.gem
    "GEM_RAP": GempakFilesystemSource(
        source_id_        = "GEM_RAP",
        label_            = "RAP (GEMPAK Grid)",
        data_dir          = "/data/gempak/model/rap",
        filename_glob     = "*_rap13km.gem",
        time_regex        = (r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
                             r"(?P<hour>\d{2})_rap13km.gem"),
        cycle_regex       = (r"(?P<cyear>\d{4})(?P<cmonth>\d{2})(?P<cday>\d{2})"
                             r"(?P<chour>\d{2})_rap13km.gem"),
        fhr_regex         = None,           # fhrs read from gdinfo inside the file
        gempak_file_type  = 'grid',
    ),

    # ── GEMPAK gridded — GFS (one fhr per file, NAWIPS naming) ────────────────
    # Files: gfs_2025030200_f024.gem
    "ECMWF_HR": FilesystemSource(
        source_id_        = "ECMWF_HR",
        label_            = "ECMWF IFS",
        data_dir          = "/data/store/grid/ecmwf_hr/",
        filename_glob     = "ecmwfhr_*.zarr",
        time_regex        = (r"ecmwfhr_"
                             r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})\."
                             r"(?P<hour>\d{2})"),
        cycle_regex       = (r"ecmwfhr_"
                             r"(?P<cyear>\d{4})(?P<cmonth>\d{2})(?P<cday>\d{2})\."
                             r"(?P<chour>\d{2})"),
        fhr_regex         = r"f(?P<fhr>\d{3})",
    ),

    # ── GEMPAK surface — daily files (one day per file, all stations) ─────────
    # Files: 20250302_sfc.gem  (contains obs every 20-60 min all day)
    "GEM_SURFACE": GempakFilesystemSource(
        source_id_        = "GEM_SURFACE",
        label_            = "Surface Obs (GEMPAK)",
        data_dir          = "/data/gempak/surface",
        filename_glob     = "*_sao.gem",
        time_regex        = (r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
                             r"_sao\.gem"),
        gempak_file_type  = 'surface',
        obs_time_step_min = 60,    # typical METAR interval
        window_minutes    = 30,    # ±30 min window for time matching
    ),

    # ── GEMPAK surface — hourly files ─────────────────────────────────────────
    # Files: 2025030218_sfc.gem  (one file per synoptic hour)
    "GEM_SURFACE_HOURLY": GempakFilesystemSource(
        source_id_        = "GEM_SURFACE_HOURLY",
        label_            = "Surface Obs Hourly (GEMPAK)",
        data_dir          = DATA_ROOT / "gempak" / "surface_hourly",
        filename_glob     = "*.gem",
        time_regex        = (r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
                             r"(?P<hour>\d{2})_sfc\.gem"),
        gempak_file_type  = 'surface',
        obs_time_step_min = 60,
        window_minutes    = 30,
    ),

    # ── GEMPAK sounding — daily files ─────────────────────────────────────────
    # Files: 20250302_snds.gem  (00Z and 12Z soundings for the day)
    "GEM_SOUNDING": GempakFilesystemSource(
        source_id_        = "GEM_SOUNDING",
        label_            = "Soundings (GEMPAK)",
        data_dir          = "/data/gempak/upperair",
        filename_glob     = "*_upa.gem",
        time_regex        = (r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})"
                             r"_upa\.gem"),
        gempak_file_type  = 'sounding',
        obs_time_step_min = 720,   # 12-hour sounding interval
        window_minutes    = 60,    # ±60 min window (soundings drift from launch time)
    ),

    "MESOANALYSIS_GRID": MESO_SOURCE,
    "NEXRAD_VAD": NEXRAD_VAD,
}

def get_source(source_id: str) -> FilesystemSource:
    """
    Look up a source by ID. Raises a clear error if not found.
    Call this from routers to get the source object.
    """
    source = SOURCES.get(source_id)
    if source is None:
        raise KeyError(
            f"Unknown source_id '{source_id}'. "
            f"Available: {list(SOURCES.keys())}"
        )
    return source
