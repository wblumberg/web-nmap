from pathlib import Path
import os

from .types.db_source import PointDBSource

# Local DATA_ROOT
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

# ── DB-backed point sources (TimescaleDB `points` hypertable) ─────────────────
# These sources read from the database rather than flat files.
# Use GET /api/v1/db-points/{source_id} to query their data.

# Lightning strikes ingested via lightning_ingest.py
LIGHTNING_DB = PointDBSource(
    source_id_       = "LIGHTNING",
    label_           = "Lightning Strikes (DB)",
    source_type      = "MISC",
    data_category    = "point_obs",
    default_selected = 10,
    timeline_hours   = 2,
    binflag          = True,
    before_minutes   = 60,
    after_minutes    = 0,
    most_recent      = False,
    return_age       = True,
)

# Local storm reports ingested via lsr_ingest.py
LSR_DB = PointDBSource(
    source_id_       = "LSR",
    label_           = "Local Storm Reports",
    source_type      = "MISC",
    data_category    = "point_obs",
    default_selected = 10,
    timeline_hours   = 2,
    binflag          = False,
    before_minutes   = 1440,
    after_minutes    = 0,
    most_recent      = False,
    return_age       = True,
)

# AirNow hourly AQI observations ingested via airnow_ingest.py
AIRNOW_DB = PointDBSource(
    source_id_       = "AIRNOW",
    label_           = "Air Quality (AirNow)",
    source_type      = "OBS_SURFACE",
    data_category    = "point_obs",
    default_selected = 1,
    timeline_hours   = 48,
    binflag          = True,
    before_minutes   = 60,
    after_minutes    = 0,
    most_recent      = True,
    return_age       = False,
)

# Ship observations ingested via ship_ingest.py
SHIP_DB = PointDBSource(
    source_id_       = "SHIP",
    label_           = "SHIP/BUOY",
    source_type      = "OBS_SURFACE",
    data_category    = "point_obs",
    default_selected = 1,
    timeline_hours   = 48,
    binflag          = True,
    before_minutes   = 60,
    after_minutes    = 0,
    most_recent      = True,
    return_age       = False,
)

# METAR observations ingested via sao_ingest.py
SAO_DB = PointDBSource(
    source_id_       = "SAO",
    label_           = "METAR",
    source_type      = "OBS_SURFACE",
    data_category    = "point_obs",
    default_selected = 1,
    timeline_hours   = 48,
    binflag          = True,
    before_minutes   = 60,
    after_minutes    = 0,
    most_recent      = True,
    return_age       = False,
)