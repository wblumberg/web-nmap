from pathlib import Path
import os

from .types.filesystem import FilesystemSource

# Local DATA_ROOT
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

# Hourly Mesoanalysis Grids
MESO_SOURCE = FilesystemSource(
  source_id_ = "MESOANALYSIS_GRID",
  label_ = "Hourly Mesoanalysis Grids",
  data_dir = "/data/store/grid/meso/",
  filename_glob = "mesoanalysis_*.zarr",
  time_regex = "mesoanalysis_YYYYMMDD.HH",
  cycle_regex = None,
  fhr_regex = None,
  human_readable = True,
  default_selected = 10,
  timeline_hours = 24,
  data_category= "gridded_analysis",
  source_type = "ANALYSIS",
)
