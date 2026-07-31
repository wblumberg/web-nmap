from pathlib import Path
import os

from .types.db_source import PointDBSource, ProfileDBSource

# Local DATA_ROOT
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

# ── DB-backed point sources (TimescaleDB `points` hypertable) ─────────────────
# These sources read from the database rather than flat files.
# Use GET /api/v1/db-points/{source_id} to query their data.

# Lightning strikes ingested via lightning_ingest.py
LIGHTNING_DB = PointDBSource(
    source_id_       = "LIGHTNING",
    label_           = "Lightning (NLDN)",
    source_type      = "MISC",
    data_category    = "point_obs",
    default_selected = 10,
    timeline_hours   = 2,
    binflag          = True,
    before_minutes   = 60,
    after_minutes    = 0,
    use_most_recent_filter = False,
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
    use_most_recent_filter = False,
    return_age       = True,
)

# AirNow hourly AQI observations ingested via airnow_ingest.py
AIRNOW_DB = PointDBSource(
    source_id_       = "AIRNOW",
    label_           = "AirNow",
    source_type      = "OBS_SURFACE",
    data_category    = "point_obs",
    default_selected = 1,
    timeline_hours   = 48,
    binflag          = True,
    before_minutes   = 180,
    after_minutes    = 0,
    use_most_recent_filter = True,
    most_recent_by   = 'station_id',
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
    use_most_recent_filter = True,
    most_recent_by   = 'station_id',
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
    use_most_recent_filter = True,
    most_recent_by   = 'station_id',
    return_age       = False,
)

# RECON observations ingested via recon_ingest.py
RECON_DB = PointDBSource(
    source_id_       = "RECON",
    label_           = "RECON",
    source_type      = "OBS_UPPERAIR",
    data_category    = "point_obs",
    default_selected = 1,
    timeline_hours   = 48,
    binflag          = True,
    before_minutes   = 180,
    after_minutes    = 0,
    use_most_recent_filter = False,
    most_recent_by   = 'station_id',
    return_age       = False,
)

# ASCAT scatterometer wind-vector cells.  Individual platforms (currently
# ASCAT-B and ASCAT-C) share one source and are identified by the ``platform``
# property.  A frame represents a trailing six-hour composite rather than one
# instantaneous scan.
ASCAT_DB = PointDBSource(
    source_id_       = "ASCAT",
    label_           = "ASCAT Scatterometer Winds",
    source_type      = "SATELLITE",
    data_category    = "point_obs",
    default_selected = 1,
    timeline_hours   = 24,
    binflag          = True,
    before_minutes   = 360,
    after_minutes    = 0,
    use_most_recent_filter = False,
    return_age       = True,
)


# VAD profile observations (vertical wind profiles).
VAD_PROFILE_DB = ProfileDBSource(
    source_id_       = "VAD_PROFILE",
    label_           = "VAD Profile",
    source_type      = "OBS_UPPERAIR",
    data_category    = "profile_obs",
    default_selected = 1,
    timeline_hours   = 48,
    before_minutes   = 20,
    after_minutes    = 0,
    use_most_recent_filter = True,
    most_recent_by   = 'station_id',
)
