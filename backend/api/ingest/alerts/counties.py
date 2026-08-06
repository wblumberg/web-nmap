"""County shapefile helper: load and cache county GeoDataFrame and build
MultiPolygon geometries from a list of 5-digit FIPS codes.

Usage:
  from backend.api.ingest.alerts.counties import counties_to_multipolygon
  geom = counties_to_multipolygon('/path/to/c_16ap26.shp', ['01234','01001'])
"""
from typing import Optional, Iterable
import geopandas as gpd
import shapely
from shapely.geometry import Polygon, MultiPolygon

# module-level cache
_COUNTIES_DF = None

def _load_shapefile(shp_path: str):
    """Load shapefile."""
    global _COUNTIES_DF
    if _COUNTIES_DF is None:
        _COUNTIES_DF = gpd.read_file(shp_path)
        # Ensure FIPS field exists and is zero-padded
        if 'FIPS' in _COUNTIES_DF.columns:
            _COUNTIES_DF['FIPS'] = _COUNTIES_DF['FIPS'].astype(str).str.zfill(5)
        elif 'GEOID' in _COUNTIES_DF.columns:
            _COUNTIES_DF['FIPS'] = _COUNTIES_DF['GEOID'].astype(str).str.zfill(5)
        else:
            # try to find a likely candidate
            for c in _COUNTIES_DF.columns:
                if c.lower().startswith('fip') or c.lower().startswith('geoid'):
                    _COUNTIES_DF['FIPS'] = _COUNTIES_DF[c].astype(str).str.zfill(5)
                    break
    return _COUNTIES_DF

def counties_to_multipolygon(shp_path: str, fips_list: Iterable[str]) -> Optional[MultiPolygon]:
    """Return a MultiPolygon (shapely) for the provided 5-digit FIPS codes.

    Returns None if no matches found.
    """
    df = _load_shapefile(shp_path)
    wanted = {str(x).zfill(5) for x in fips_list}
    matched = df[df['FIPS'].isin(wanted)]
    if matched.empty:
        return None

    # Call make_valid() on each geometry individually before unioning.
    # GEOS can segfault (not just raise) on self-intersecting or degenerate
    # rings in the county shapefile, and make_valid() normalizes them safely.
    geoms = []
    for g in matched.geometry:
        if g is None or g.is_empty:
            continue
        try:
            valid = shapely.make_valid(g)
            if valid is not None and not valid.is_empty:
                geoms.append(valid)
        except Exception:
            pass

    if not geoms:
        return None

    # dissolve into a single geometry
    try:
        geom = shapely.union_all(geoms)
    except Exception:
        from shapely.ops import unary_union
        geom = unary_union(geoms)

    if geom is None or geom.is_empty:
        return None
    # normalize to MultiPolygon
    if isinstance(geom, Polygon):
        geom = MultiPolygon([geom])
    elif not isinstance(geom, MultiPolygon):
        # GeometryCollection or other mixed type — extract only polygonal parts
        polys = [g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))]
        if not polys:
            return None
        geom = shapely.union_all(polys)
        if isinstance(geom, Polygon):
            geom = MultiPolygon([geom])
    return geom
