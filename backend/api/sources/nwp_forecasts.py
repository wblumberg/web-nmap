"""Declare and configure backend data sources for nwp forecasts."""

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
    zarr_transport    = True,
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
    zarr_transport    = True,
)

# ECMWF Ensemble
# I'm seeing some issues with this data, where I'm getting this error from the frontend
# "Invalid LngLat latitude value: must be between -90 and 90"
ECMWF_ENS = FilesystemSource(
    source_id_        = "ECMWF_ENS",
    label_            = "ECMWF Ensemble",
    data_dir          = DATA_ROOT / "grid/ecens/",
    filename_glob     = "*.ecmwf_ecens.zarr",
    time_regex        = "YYYYMMDDHH.ecmwf_ecens.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.ecmwf_ecens.zarr",
    source_type       = "MODEL_ENS",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
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
    zarr_transport    = True,
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
    zarr_transport    = True,
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
    zarr_transport    = True,
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
    zarr_transport    = True,
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
    zarr_transport    = True,
)

NSSL_WRF = FilesystemSource(
    source_id_        = "NSSL_WRF",
    label_            = "NSSL 4km WRF",
    data_dir          = DATA_ROOT / "grid/wrf4nssl",
    filename_glob     = "*.wrf4nssl.zarr",
    time_regex        = "YYYYMMDDHH.wrf4nssl.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.wrf4nssl.zarr",
    source_type       = "MODEL_DET",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
)

NSSL_MPAS_RN = FilesystemSource(
    source_id_        = "NSSL_MPAS_RN",
    label_            = "NSSL MPAS-RN",
    data_dir          = DATA_ROOT / "grid/mpasrn_nssl/",
    filename_glob     = "*.mpasrn_nssl.zarr",
    time_regex        = "YYYYMMDDHH.mpasrn_nssl.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.mpasrn_nssl.zarr",
    source_type       = "MODEL_DET",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
)

HRRR = FilesystemSource(
    source_id_        = "HRRR",
    label_            = "HRRR",
    data_dir          = DATA_ROOT / "grid/hrrr/",
    filename_glob     = "*.hrrr.zarr",
    time_regex        = "YYYYMMDDHH.hrrr.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.hrrr.zarr",
    source_type       = "MODEL_DET",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
)

NAM_NEST = FilesystemSource(
    source_id_        = "NAM_NEST",
    label_            = "NAM 3km NEST",
    data_dir          = DATA_ROOT / "grid/namnest/",
    filename_glob     = "*.namnest.zarr",
    time_regex        = "YYYYMMDDHH.namnest.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.namnest.zarr",
    source_type       = "MODEL_DET",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
)

HRW_FV3 = FilesystemSource(
    source_id_        = "HRW_FV3",
    label_            = "HiresW-FV3",
    data_dir          = DATA_ROOT / "grid/hiresw_conusfv3/",
    filename_glob     = "*.hiresw_conusfv3.zarr",
    time_regex        = "YYYYMMDDHH.hiresw_conusfv3.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.hiresw_conusfv3.zarr",
    source_type       = "MODEL_DET",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
)

HRW_ARW = FilesystemSource(
    source_id_        = "HRW_ARW",
    label_            = "HiresW-ARW",
    data_dir          = DATA_ROOT / "grid/hiresw_conusarw/",
    filename_glob     = "*.hiresw_conusarw.zarr",
    time_regex        = "YYYYMMDDHH.hiresw_conusarw.zarr",
    cycle_regex       = "CYYYYCMMCDDCHH.hiresw_conusarw.zarr",
    source_type       = "MODEL_DET",
    data_category     = "gridded_forecast",
    human_readable    = True,
    default_selected = -9999,
    timeline_hours = 48,
    zarr_transport    = True,
)

# Additional data sources to add:
# - GFS
# - RRFS 
# - REFS
# - GEFS
