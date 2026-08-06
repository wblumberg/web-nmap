"""
readers/base.py — Abstract Reader base class and result data classes

─── Design principle ────────────────────────────────────────────────────────

Every file format (Zarr, GRIB2, NetCDF, GeoJSON, BUFR …) has its own
reader class. Each reader:
  1. Accepts a file path + a variable mapping dict
  2. Reads the file
  3. Returns a standardized result object

The routers never touch file format details — they only interact with the
result objects. This means you can swap Zarr for GRIB2 for a given source
without changing any router code.

─── Result types ────────────────────────────────────────────────────────────

GriddedResult   — a 2-D lat/lon field (analysis or forecast)
PointResult     — a list of discrete point observations/reports
GeometryResult  — a GeoJSON FeatureCollection of polygons/lines

─── Variable mapping (var_map) ──────────────────────────────────────────────

`var_map` translates the generic variable names used in the JavaScript
VIEW_REGISTRY into the actual variable names inside each file format.

Example for temperature:
    JS side:    var_map = { 't2m': 'TMP_2mAboveGround' }
    GRIB2 file: shortName = 'TMP_2mAboveGround'

This decouples the frontend naming from the backend file naming.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Union
import numpy as np


@dataclass
class GridInfo:
    """
    Describes the spatial grid of a gridded field.

    These values are passed to the autumnplot-gl Grid constructors on the
    JS side (PlateCarreeGrid, LambertGrid, etc.).

    TODO: Implement the Geostationary Grid that Tim has been working on for satellite data

    Fields:
        grid_type   : 'plate_carree' | 'lambert' | 'mercator' | 'polar_stereo'
        ni, nj      : grid dimensions (number of points west-east, south-north)
        lat_min/max : bounding box in degrees
        lon_min/max : bounding box in degrees
        dx, dy      : grid spacing in degrees (plate_carree) or km (projected)
        proj_params : projection-specific parameters (e.g. lat_0, lon_0 for Lambert)
    """
    grid_type   : str
    ni          : int
    nj          : int
    lat_min     : Optional[float] = None
    lat_max     : Optional[float] = None
    lon_min     : Optional[float] = None
    lon_max     : Optional[float] = None
    dx          : Optional[float] = None
    dy          : Optional[float] = None
    proj_params : dict = field(default_factory=dict)
    # Optional geostationary-specific parameters (lower-left / upper-right
    # coordinates in projected space and satellite latitude).
    ll_x        : float | None = None
    ll_y        : float | None = None
    ur_x        : float | None = None
    ur_y        : float | None = None
    sat_lon     : float | None = None

    def as_dict(self) -> dict:
        """Serialize the value as a dictionary."""
        return {
            "grid_type"  : self.grid_type,
            "ni"         : self.ni,
            "nj"         : self.nj,
            "lat_min"    : self.lat_min,
            "lat_max"    : self.lat_max,
            "lon_min"    : self.lon_min,
            "lon_max"    : self.lon_max,
            "dx"         : self.dx,
            "dy"         : self.dy,
            "proj_params": self.proj_params,
            "ll_x"       : self.ll_x,
            "ll_y"       : self.ll_y,
            "ur_x"       : self.ur_x,
            "ur_y"       : self.ur_y,
            "sat_lon"    : self.sat_lon,
        }


@dataclass
class GriddedResult:
    """
    A single 2-D gridded variable read from a file.

    Fields:
        variable     : The generic variable name (from var_map key)
        units        : Physical units string (e.g. 'K', 'm/s', 'Pa')
        data         : Flat int16 (or float32) array, row-major order, shape (nj, ni)
                       When quantized, apply: physical = data * scale_factor + add_offset
        grid         : The spatial grid descriptor
        valid_time   : UTC datetime of this field
        cycle        : Model init time (None for analysis/obs)
        fhr          : Forecast hour (None for analysis/obs)
        fill_value   : Value used for missing data (sentinel int16 = -32768 when quantized)
        metadata     : Extra key/value pairs (level, ensemble member, etc.)
        scale_factor : CF-convention scale factor; physical = data * scale_factor + add_offset
        add_offset   : CF-convention offset; physical = data * scale_factor + add_offset
        data_type    : 'int16' | 'float32' | 'float16'
    """
    variable     : str
    units        : str
    data         : Union[np.ndarray, list]  # numpy array preferred; list also accepted
    grid         : GridInfo
    valid_time   : str           # ISO 8601 UTC
    cycle        : str | None    = None
    fhr          : int | None    = None
    fill_value   : float         = float('nan')
    metadata     : dict          = field(default_factory=dict)
    scale_factor : float | None  = None
    add_offset   : float | None  = None
    data_type    : str           = 'float32'

    def as_dict(self) -> dict:
        """Serialize the value as a dictionary."""
        data = self.data.tolist() if isinstance(self.data, np.ndarray) else self.data
        return {
            "variable"    : self.variable,
            "units"       : self.units,
            "data"        : data,
            "grid"        : self.grid.as_dict(),
            "valid_time"  : self.valid_time,
            "cycle"       : self.cycle,
            "fhr"         : self.fhr,
            "fill_value"  : self.fill_value,
            "metadata"    : self.metadata,
            "scale_factor": self.scale_factor,
            "add_offset"  : self.add_offset,
            "data_type"   : self.data_type,
        }


@dataclass
class PointResult:
    """
    A set of discrete point observations or reports.

    Each point is a dict with at minimum 'lat', 'lon', and 'time'.
    Additional keys depend on the data type (temperature, wind, etc.).

    Fields:
        source_type : 'metar' | 'lsr' | 'aircraft' | 'scatterometer' | 'buoy' | ...
        valid_time  : Reference time for this dataset (ISO 8601 UTC)
        points      : List of dicts, each representing one observation/report
        metadata    : Extra key/value pairs
    """
    source_type : str
    valid_time  : str
    points      : list[dict]
    metadata    : dict = field(default_factory=dict)

    def as_geojson(self) -> dict:
        """Convert to GeoJSON FeatureCollection for MapLibre consumption."""
        features = []
        for pt in self.points:
            lon = pt.get('lon') or pt.get('longitude')
            lat = pt.get('lat') or pt.get('latitude')
            if lon is None or lat is None:
                continue
            props = {k: v for k, v in pt.items()
                     if k not in ('lat', 'lon', 'latitude', 'longitude')}
            features.append({
                "type"      : "Feature",
                "geometry"  : {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            })
        return {
            "type"    : "FeatureCollection",
            "metadata": {"source_type": self.source_type,
                         "valid_time" : self.valid_time,
                         "count"      : len(features),
                         **self.metadata},
            "features": features,
        }


@dataclass
class GeometryResult:
    """
    A set of polygon / polyline geometries (watches, warnings, fronts, etc.)

    This is essentially a GeoJSON FeatureCollection with extra metadata.
    The 'features' list contains standard GeoJSON Feature objects.

    Fields:
        geometry_type : 'watch_warning' | 'outlook' | 'front' | 'boundary' | ...
        valid_time    : Reference time (ISO 8601 UTC)
        features      : List of GeoJSON Feature dicts
        metadata      : Extra key/value pairs
    """
    geometry_type : str
    valid_time    : str
    features      : list[dict]
    metadata      : dict = field(default_factory=dict)

    def as_geojson(self) -> dict:
        """Serialize the value as a GeoJSON feature collection."""
        return {
            "type"    : "FeatureCollection",
            "metadata": {"geometry_type": self.geometry_type,
                         "valid_time"   : self.valid_time,
                         "count"        : len(self.features),
                         **self.metadata},
            "features": self.features,
        }


# ─── Abstract Reader ──────────────────────────────────────────────────────────

class Reader(ABC):
    """
    Abstract base class for all file format readers.

    A Reader knows how to open one specific file format and extract
    variables from it. Subclasses implement read_gridded(), read_points(),
    or read_geometries() depending on what the format contains.

    Most readers will only implement one of the three — a GRIB2 reader
    produces GriddedResults, a GeoJSON reader produces GeometryResults, etc.
    """

    #: Short name identifying this format, e.g. 'zarr', 'grib2', 'geojson'
    format_name: str = "unknown"

    @abstractmethod
    def can_read(self, path: Path) -> bool:
        """
        Return True if this reader can handle the given file.
        Used by the reader registry to auto-detect formats.
        """
        ...

    async def read_gridded(
        self,
        path    : Path,
        var_map : dict[str, str],
        level   : str | None = None,
        fhr     : int | None = None,
    ) -> list[GriddedResult]:
        """
        Read one or more gridded fields from the file.

        Parameters:
            path    : File to read
            var_map : { generic_name: format_specific_name }
                      e.g. { 't2m': 'TMP_2mAboveGround' }
            level   : Optional level descriptor (e.g. '500mb', '2m', '10m')
            fhr     : Forecast hour (for selecting a specific time step)

        Returns:
            List of GriddedResult, one per variable in var_map.

        Raises NotImplementedError if this reader doesn't support gridded data.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support gridded data."
        )

    async def read_points(
        self,
        path    : Path,
        var_map : dict[str, str],
        bbox    : tuple[float, float, float, float] | None = None,
    ) -> PointResult:
        """
        Read point observations from the file.

        Parameters:
            path    : File to read
            var_map : { generic_name: format_specific_name }
            bbox    : Optional bounding box (lon_min, lat_min, lon_max, lat_max)
                      to spatially filter the points.

        Returns:
            PointResult containing the observations.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support point data."
        )

    async def read_geometries(
        self,
        path    : Path,
        var_map : dict[str, str],
        bbox    : tuple[float, float, float, float] | None = None,
    ) -> GeometryResult:
        """
        Read polygon/polyline geometries from the file.

        Parameters:
            path    : File to read
            var_map : { generic_name: format_specific_name }
            bbox    : Optional spatial filter

        Returns:
            GeometryResult containing the features.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not support geometry data."
        )
