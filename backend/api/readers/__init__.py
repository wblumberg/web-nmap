"""
readers/__init__.py — Reader registry  (updated: GempakReader added)
"""

from pathlib import Path

from .zarr_reader    import ZarrReader
from .grib2_reader   import Grib2Reader
from .netcdf_reader  import NetCDFReader
from .geojson_reader import GeoJSONReader
from .gempak_reader  import GempakReader
from .acad_ltng_reader import AcadLtngReader

# Order matters — first match wins.
# GempakReader is placed after NetCDF because some .nc files could
# accidentally match the GEMPAK extension heuristic (they won't — GEMPAK
# has no .nc extension — but the explicit ordering makes intent clear).
READERS = [
    ZarrReader(),
    Grib2Reader(),
    NetCDFReader(),
    GeoJSONReader(),
    GempakReader(),
    AcadLtngReader(),
]


def get_reader(path: Path):
    for reader in READERS:
        if reader.can_read(path):
            return reader
    raise ValueError(
        f"No reader found for '{path.name}'. "
        f"Supported formats: {[r.format_name for r in READERS]}"
    )


def get_reader_by_format(fmt: str):
    for reader in READERS:
        if reader.format_name == fmt:
            return reader
    raise ValueError(f"Unknown format '{fmt}'")
