from pathlib import Path
import os

from .types.filesystem import FilesystemSource

# Local DATA_ROOT
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

# ECMWF IFS
ECMWF_HR = FilesystemSource(
    source_id_        = "ECMWF_HR",
    label_            = "ECMWF IFS",
    data_dir          = "/data/store/grid/ecmwf_hr/",
    filename_glob     = "ecmwfhr_*.zarr",
    time_regex        = "ecmwfhr_YYYYMMDD.HH",
    cycle_regex       = "ecmwfhr_CYYYYCMMCDD.CHH",
    fhr_regex         = "fFHR",
    data_category     = "gridded_forecast",
    source_type       = "MODEL_DET",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
)

# HREF Ensemble
HREF = FilesystemSource(
    source_id_        = "HREF",
    label_            = "HREF Ensemble",
    data_dir          = DATA_ROOT / "grid/href",
    filename_glob     = "*.href_ensemble.zarr",
    time_regex        = "YYYYMMDDHH.href_ensemble.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.href_ensemble.zarr",
    source_type       = "MODEL_ENS",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
)

# Additional data sources to add:
# - GFS
# - ECMWF Ensemble (ENS)
# - RRFS 
# - REFS
# - GEFS
# - ATCF (better for tropical cyclones, but could be added later if we want to focus on that)
