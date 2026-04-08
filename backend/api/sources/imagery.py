from pathlib import Path
import os
import re

from .types.raster_source import RasterSource


# Local DATA_ROOT (matches registry pattern)
DATA_ROOT = Path(os.environ.get("WEBNMAP_DATA_ROOT", "/data/store/"))

################################################################################
# MRMS SOURCES
################################################################################


# MRMS Products to include in the catalog, with corresponding zarr variable names and labels
_MRMS_PRODUCTS = {
    "MergedBaseReflectivityQC_00.50": ("CREF_low", "Base Refl QC 0.5°"),
    "CompositeReflectivity":          ("CREF",     "Composite Reflectivity"),
    "MergedReflectivityQCComposite":  ("CREF_qc",  "Merged Refl QC Composite"),
}

_MRMS_REGIONS = ["CONUS", "Alaska", "Hawaii", "Guam"]

def _mrms_source(region: str, product_dir: str, zarr_var: str, label: str) -> RasterSource:
    return RasterSource(
        source_id_    = f"MRMS_{region}_{zarr_var}",
        label_        = f"MRMS {region} — {label}",
        data_dir      = DATA_ROOT / f"raster/mrms/{region}/{product_dir}",
        filename_glob = f"mrms_{region}_{product_dir}_*.zarr",
        time_regex    = (
            rf"mrms_{region}_{re.escape(product_dir)}_"
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})T"
            r"(?P<hour>\d{2})(?P<minute>\d{2})(?P<second>\d{2})\.zarr"
        ),
        source_type    = "RADAR_MOSAIC",
        data_category  = "gridded_imagery",
        default_selected = 10,
        timeline_hours = 12,
        regions        = [region],
    )

MRMS_SOURCES: dict[str, RasterSource] = {
    f"MRMS_{region}_{zarr_var}": _mrms_source(region, prod_dir, zarr_var, lbl)
    for region in _MRMS_REGIONS
    for prod_dir, (zarr_var, lbl) in _MRMS_PRODUCTS.items()
}

################################################################################
# GOES SOURCES
################################################################################

_GOES_CHANNELS = {
    "C02": "Visible (0.64 µm)",
    "C08": "Upper-Level WV (6.2 µm)",
    "C13": "Clean IR (10.3 µm)",
}

_GOES_REGIONS = ["CONUS", "FullDisk", "Meso1", "Meso2"]

def _goes_source(sat_num: int, region: str, channel: str) -> RasterSource:
    satellite = f"GOES-{sat_num}"
    label_sat = "GOES-East" if sat_num == 19 else "GOES-West"
    return RasterSource(
        label_        = f"{label_sat} {region} — {channel} ({_GOES_CHANNELS.get(channel, channel)})",
        data_dir      = DATA_ROOT / f"raster/satellite/{satellite}/{region}/{channel}",
        filename_glob = f"{region}_{satellite}_{channel}_*.zarr",
        time_regex    = (
            rf"{region}_{satellite}_{channel}_"
            r"(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})T"
            r"(?P<hour>\d{2})(?P<minute>\d{2})(?P<second>\d{2})\.zarr"
        ),
        source_type    = "SATELLITE",
        data_category  = "gridded_imagery",
        default_selected = 10,
        timeline_hours = 3,
        regions        = [region],
        source_id_   = f"GOES-{'E' if sat_num == 19 else 'W'}_{region}_{channel}",
        source_group = "GOES-E" if sat_num == 19 else "GOES-W",   # ← UI top level
    )

# Build a dict  source_id → RasterSource  for all GOES-E combinations
GOES_SOURCES: dict[str, RasterSource] = {
    f"GOES-E_{region}_{ch}": _goes_source(19, region, ch)
    for region in _GOES_REGIONS
    for ch in _GOES_CHANNELS
}
GOES_SOURCES.update({
    f"GOES-W_{region}_{ch}": _goes_source(18, region, ch)
    for region in _GOES_REGIONS
    for ch in _GOES_CHANNELS
})