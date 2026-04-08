from pathlib import Path
import os

from .types.raster_source import RasterSource

# Local DATA_ROOT (matches registry pattern)
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

# MRMS Composite Reflectivity
MRMS = RasterSource(
    source_id_    = "MRMS",
    label_        = "Multiple-Radar/Multi-Sensor (MRMS) Mosaic",
    data_dir      = DATA_ROOT / "raster/mrms",
    filename_glob = "mrms.*.zarr",
    time_regex    = "mrms.YYYYMMDDHHmm",
    source_type = "RADAR_MOSAIC",
    data_category = "gridded_imagery",
    human_readable = True,
    default_selected = 10,
    timeline_hours = 12,
    regions = ["CONUS", "Alaska","Guam", "Hawaii"],
)

# GOES-East
GOESE = RasterSource(
    source_id_    = "GOES-E",
    label_        = "GOES-East",
    data_dir      = DATA_ROOT / f"raster/satellite/GOES-19/%region%",
    filename_glob = "CONUS*.zarr",
    time_regex    = "zarr_YYYYMMDDTHHmmSS.zarr",
    source_type   = "SATELLITE",
    data_category = "gridded_imagery",
    human_readable = True,
    default_selected = 10,
    timeline_hours = 12,
    regions = ["CONUS", "Meso1", "Meso2", "FullDisk"],
)

# GOES-West
GOESW = RasterSource(
    source_id_    = "GOES-W",
    label_        = "GOES-West",
    data_dir      = DATA_ROOT / "raster/satellite/GOES-18/%region%",
    filename_glob = "*.zarr",
    time_regex    = "zarr_YYYYMMDDTHHmmSS.zarr",
    source_type   = "SATELLITE",
    data_category = "gridded_imagery",
    human_readable = True,
    default_selected = 10,
    timeline_hours = 12,
    regions = ["CONUS", "Meso1", "Meso2", "FullDisk"],
)