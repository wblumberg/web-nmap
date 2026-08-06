"""
readers/__init__.py — Reader registry  (updated: GempakReader added)
"""

from pathlib import Path

from .zarr_reader    import ZarrReader
from .geojson_reader import GeoJSONReader
from .gempak_reader  import GempakReader
from .acad_ltng_reader import AcadLtngReader

# Order matters — first match wins.
READERS = [
    ZarrReader(),
    GeoJSONReader(),
    GempakReader(),
    AcadLtngReader(),
]


def get_reader(path: Path):
    """Return the first registered reader that supports a path."""
    for reader in READERS:
        if reader.can_read(path):
            return reader
    raise ValueError(
        f"No reader found for '{path.name}'. "
        f"Supported formats: {[r.format_name for r in READERS]}"
    )


def get_reader_by_format(fmt: str):
    """Return the reader registered for a catalog format name."""
    for reader in READERS:
        if reader.format_name == fmt:
            return reader
    raise ValueError(f"Unknown format '{fmt}'")
