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

from .types.filesystem import FilesystemSource
from .types.db_source import AlertSource

# Category modules
from .imagery import MRMS_SOURCES, GOES_SOURCES
from .observations import (
    LIGHTNING_DB, AIRNOW_DB, SHIP_DB, SAO_DB, LSR_DB
)
from .nwp_forecasts import ECMWF_HR, HREF, NCEP_GEFS, NCEP_GFS, ECMWF_ENS, NCEP_RRFS, REFS, NSSL_GEFS
from .gridded_analyses import MESO_SOURCE

# Local DATA_ROOT (kept for backward compatibility / external usage)
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

SOURCES: dict[str, FilesystemSource] = {
    # Imagery
    **GOES_SOURCES,
    **MRMS_SOURCES,

    # Gridded forecasts / models
    "NCEP_RRFS": NCEP_RRFS,
    "ECMWF_HR": ECMWF_HR,
    "NCEP_GFS": NCEP_GFS,

    "HREF": HREF,
    "REFS": REFS,
    "NCEP_GEFS": NCEP_GEFS,
    "ECMWF_ENS": ECMWF_ENS,
    "NSSL_GEFS": NSSL_GEFS,

    # Gridded analyses
    "MESOANALYSIS_GRID": MESO_SOURCE,

    # DB-backed point sources (TimescaleDB `points` hypertable)
    "LIGHTNING": LIGHTNING_DB,
    "LSR"      : LSR_DB,
    "AIRNOW"   : AIRNOW_DB,
    "SHIP"     : SHIP_DB,
    "SAO"      : SAO_DB,
    
    # DB-backed NWS alert sources (TimescaleDB `alerts` hypertable)
    # Filter by phenomenon at query time via ?phen=TO (or ?phen=tornado)
    "WARNINGS"  : AlertSource("WARNINGS",   "Warnings",   sig="W"),
    "WATCHES"   : AlertSource("WATCHES",    "Watches",    sig="A"),
    "ADVISORIES": AlertSource("ADVISORIES", "Advisories", sig="Y"),
}


def get_source(source_id: str) -> FilesystemSource:
    """Look up a source by ID. Raises a clear error if not found.

    Call this from routers to get the source object.
    """
    source = SOURCES.get(source_id)
    if source is None:
        raise KeyError(
            f"Unknown source_id '{source_id}'. Available: {list(SOURCES.keys())}"
        )
    return source
