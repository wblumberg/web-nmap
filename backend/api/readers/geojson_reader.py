"""
readers/geojson_reader.py — GeoJSON / compressed GeoJSON reader

Used for:
  - NWS watches, warnings, advisories  (polygon FeatureCollections)
  - SPC outlooks (tornado, wind, hail) (polygon FeatureCollections)
  - Surface frontal analysis           (line FeatureCollections)
  - Local Storm Reports                (point FeatureCollections)
  - Aircraft track snapshots           (point/line FeatureCollections)
  - Scatterometer wind vectors         (point FeatureCollections)

Both raw .geojson and .geojson.gz (gzip-compressed) are supported.
"""

import gzip
import json
from pathlib import Path
from datetime import datetime, timezone

from .base import Reader, PointResult, GeometryResult


class GeoJSONReader(Reader):
    """Represent geo jsonreader."""
    format_name = "geojson"

    def can_read(self, path: Path) -> bool:
        """Return whether this reader supports the supplied path."""
        return path.suffix in (".geojson", ".json") or \
               path.name.endswith(".geojson.gz") or \
               path.name.endswith(".json.gz")

    def _load(self, path: Path) -> dict:
        """Load raw bytes → parsed GeoJSON dict, handling gzip transparently."""
        raw = path.read_bytes()
        if path.name.endswith(".gz"):
            raw = gzip.decompress(raw)
        return json.loads(raw)

    async def read_geometries(
        self,
        path    : Path,
        var_map : dict[str, str],
        bbox    : tuple | None = None,
    ) -> GeometryResult:
        """
        Read polygon/line geometries from GeoJSON.
        Used for watch/warning boxes, SPC outlooks, fronts, etc.

        var_map can remap property names, e.g.:
            { 'event_type': 'properties.event',
              'expires':    'properties.expires' }
        This is optional — if empty, all properties pass through as-is.
        """
        fc         = self._load(path)
        valid_time = self._infer_valid_time(fc)

        features = []
        for feat in fc.get("features", []):
            geom = feat.get("geometry")
            if geom is None:
                continue

            # Spatial filter
            if bbox is not None and not self._bbox_intersects(geom, bbox):
                continue

            # Property remapping
            props = feat.get("properties", {})
            if var_map:
                props = {
                    generic: self._get_nested(props, path_str)
                    for generic, path_str in var_map.items()
                }

            features.append({
                "type"      : "Feature",
                "geometry"  : geom,
                "properties": props,
            })

        return GeometryResult(
            geometry_type = fc.get("metadata", {}).get("type", "unknown"),
            valid_time    = valid_time,
            features      = features,
            metadata      = fc.get("metadata", {}),
        )

    async def read_points(
        self,
        path    : Path,
        var_map : dict[str, str],
        bbox    : tuple | None = None,
    ) -> PointResult:
        """
        Read point features from GeoJSON.
        Used for LSRs, aircraft positions, scatterometer points, etc.
        """
        fc         = self._load(path)
        valid_time = self._infer_valid_time(fc)

        points = []
        for feat in fc.get("features", []):
            geom = feat.get("geometry", {})
            if geom.get("type") != "Point":
                continue

            coords = geom.get("coordinates", [])
            if len(coords) < 2:
                continue

            lon, lat = float(coords[0]), float(coords[1])

            if bbox is not None:
                lo_min, la_min, lo_max, la_max = bbox
                if not (lo_min <= lon <= lo_max and la_min <= lat <= la_max):
                    continue

            props = feat.get("properties", {})
            # Apply var_map remapping if provided
            if var_map:
                remapped = {g: self._get_nested(props, p) for g, p in var_map.items()}
                pt = {'lat': lat, 'lon': lon, **remapped}
            else:
                pt = {'lat': lat, 'lon': lon, **props}

            points.append(pt)

        source_type = fc.get("metadata", {}).get("source_type", "geojson_points")
        return PointResult(
            source_type = source_type,
            valid_time  = valid_time,
            points      = points,
            metadata    = fc.get("metadata", {}),
        )

    def _infer_valid_time(self, fc: dict) -> str:
        """Try to find a valid time in the GeoJSON metadata."""
        meta = fc.get("metadata", {})
        for key in ("valid_time", "time", "generated", "updated"):
            if key in meta:
                return str(meta[key])
        # Try the first feature's properties
        feats = fc.get("features", [])
        if feats:
            props = feats[0].get("properties", {})
            for key in ("onset", "effective", "time", "valid_time"):
                if key in props:
                    return str(props[key])
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _get_nested(self, obj: dict, path: str):
        """Retrieve a nested property using dot notation, e.g. 'properties.event'."""
        parts = path.split(".")
        for part in parts:
            if not isinstance(obj, dict):
                return None
            obj = obj.get(part)
        return obj

    def _bbox_intersects(self, geom: dict, bbox: tuple) -> bool:
        """Quick check whether a geometry might intersect a bounding box."""
        lo_min, la_min, lo_max, la_max = bbox
        coords = self._flatten_coords(geom.get("coordinates", []))
        return any(lo_min <= c[0] <= lo_max and la_min <= c[1] <= la_max
                   for c in coords)

    def _flatten_coords(self, coords) -> list:
        """Recursively flatten nested coordinate arrays to a list of [lon, lat]."""
        if not coords:
            return []
        if isinstance(coords[0], (int, float)):
            return [coords]
        flat = []
        for item in coords:
            flat.extend(self._flatten_coords(item))
        return flat
