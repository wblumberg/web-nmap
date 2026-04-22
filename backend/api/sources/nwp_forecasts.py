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

# NCEP GFS
NCEP_GFS = FilesystemSource(
    source_id_        = "NCEP_GFS",
    label_            = "NCEP GFS",
    data_dir          = "/data/store/grid/gfs/",
    filename_glob     = "gfs_*.zarr",
    time_regex        = "gfs_YYYYMMDD.HH",
    cycle_regex       = "gfs_CYYYYCMMCDD.CHH",
    fhr_regex         = "fFHR",
    data_category     = "gridded_forecast",
    source_type       = "MODEL_DET",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
)

# ECMWF Ensemble
ECMWF_ENS = FilesystemSource(
    source_id_        = "ECMWF_ENS",
    label_            = "ECMWF Ensemble",
    data_dir          = DATA_ROOT / "grid/ecmwf_ens",
    filename_glob     = "*.ecmwf_ens.zarr",
    time_regex        = "YYYYMMDDHH.ecmwf_ens.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.ecmwf_ens.zarr",
    source_type       = "MODEL_ENS",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
)

# GEFS
NCEP_GEFS = FilesystemSource(
    source_id_        = "NCEP_GEFS",
    label_            = "NCEP GEFS",
    data_dir          = DATA_ROOT / "grid/gefs",
    filename_glob     = "*.gefs.zarr",
    time_regex        = "YYYYMMDDHH.gefs.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.gefs.zarr",
    source_type       = "MODEL_ENS",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
)

# GEFS
NSSL_GEFS = FilesystemSource(
    source_id_        = "NSSL_GEFS",
    label_            = "NSSL GEFS",
    data_dir          = DATA_ROOT / "grid/gefs",
    filename_glob     = "*.gefs_ensemble.zarr",
    time_regex        = "YYYYMMDDHH.gefs_ensemble.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.gefs_ensemble.zarr",
    source_type       = "MODEL_ENS",
    data_category     = "gridded_forecast",
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

# REFS Ensemble
REFS = FilesystemSource(
    source_id_        = "REFS",
    label_            = "REFS Ensemble",
    data_dir          = DATA_ROOT / "grid/refs",
    filename_glob     = "*.refs_ensemble.zarr",
    time_regex        = "YYYYMMDDHH.refs_ensemble.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.refs_ensemble.zarr",
    source_type       = "MODEL_ENS",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
)

# RRFS
NCEP_RRFS = FilesystemSource(
    source_id_        = "NCEP_RRFS",
    label_            = "NCEP RRFS",
    data_dir          = DATA_ROOT / "grid/rrfs",
    filename_glob     = "*.rrfs.zarr",
    time_regex        = "YYYYMMDDHH.rrfs.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.rrfs.zarr",
    source_type       = "MODEL_DET",
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
