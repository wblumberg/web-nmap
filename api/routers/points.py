"""
routers/points.py  (updated: passes target_dt + window_minutes to read_points)

The only change from the previous version is that _call_read_points() now
extracts a target_dt from the key and passes window_minutes from the source
configuration (or the query parameter) through to the reader.
"""

from typing import Optional
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from ..sources.registry import get_source
from ..readers import get_reader
from ..readers.base import PointResult

router = APIRouter(tags=["Point Data"])


@router.get("/{source_id}/features")
async def get_point_features(
    source_id      : str,
    key            : Optional[str] = Query(None),
    bbox           : Optional[str] = Query(None),
    variables      : Optional[str] = Query(None),
    max_age_minutes: Optional[int] = Query(None),
    window_minutes : Optional[int] = Query(None,
                        description="Time window ±minutes around key for GEMPAK "
                                    "multi-time files.  Defaults to source config value."),
):
    """
    Return a GeoJSON FeatureCollection of point observations.

    For GEMPAK surface/sounding files, `window_minutes` controls how wide
    a time window around `key` is searched within the file.

    Example:
        GET /api/v1/points/GEM_SURFACE/features?key=20250302_1800&window_minutes=30
        → Returns all METAR obs between 17:30 and 18:30 UTC on 2025-03-02,
          drawn from the daily GEMPAK surface file 20250302_sfc.gem.
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    if key is None:
        latest = await source.most_recent()
        if latest is None:
            raise HTTPException(404, f"No data for '{source_id}'")
        key = latest.key

    path = await source.get_path(key)
    if path is None:
        raise HTTPException(404, f"No file for '{source_id}' key '{key}'")

    parsed_bbox = _parse_bbox(bbox)
    var_list    = [v.strip() for v in variables.split(",")] if variables else []
    var_map     = _build_var_map(source, var_list)

    # Resolve window_minutes: query param > source config > 0
    win_min = (
        window_minutes
        if window_minutes is not None
        else getattr(source, 'window_minutes', 0)
    )

    # Parse the key to a target datetime for GEMPAK window selection
    target_dt = _parse_key_to_dt(key)

    reader = get_reader(path)
    try:
        # Pass target_dt and window_minutes if the reader supports them
        # (GempakReader does; other readers ignore extra kwargs via **kwargs)
        import inspect
        sig = inspect.signature(reader.read_points)
        extra = {}
        if 'target_dt'      in sig.parameters: extra['target_dt']      = target_dt
        if 'window_minutes' in sig.parameters: extra['window_minutes'] = win_min

        result: PointResult = await reader.read_points(
            path    = path,
            var_map = var_map,
            bbox    = parsed_bbox,
            **extra,
        )
    except NotImplementedError:
        raise HTTPException(400, f"Source '{source_id}' does not support point reads")
    except Exception as e:
        raise HTTPException(500, f"Read error: {e}")

    if max_age_minutes is not None:
        result = _filter_by_age(result, max_age_minutes)

    return JSONResponse(result.as_geojson())


@router.get("/{source_id}/window")
async def get_points_in_window(
    source_id      : str,
    center_key     : str   = Query(...),
    window_minutes : int   = Query(60, ge=1, le=1440),
    bbox           : Optional[str] = Query(None),
    dedupe_field   : Optional[str] = Query(None),
):
    """
    Aggregate point data from multiple files/times within a window.

    For GEMPAK daily files this is especially efficient: instead of opening
    many separate hourly files, a single daily file is opened once and the
    window filter is applied inside it.
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    center_dt   = _parse_key_to_dt(center_key)
    if center_dt is None:
        raise HTTPException(422, f"Cannot parse center_key '{center_key}'")

    parsed_bbox = _parse_bbox(bbox)

    # For GEMPAK multi-time sources: list_times already exposes individual
    # obs times.  But if a single file covers the whole window (daily file),
    # we can read it once with a wide window rather than re-opening it for
    # each obs time key.  Check whether all keys in the window map to the
    # same file.
    window = timedelta(minutes=window_minutes)
    times  = await source.list_times(
        after  = center_dt - window,
        before = center_dt + window,
        limit  = 2000,
    )

    # Group keys by their file path
    from collections import defaultdict
    by_file: dict[str, list] = defaultdict(list)
    for t in times:
        p = await source.get_path(t.key)
        if p:
            by_file[str(p)].append(t)

    all_points: list[dict] = []
    import inspect

    for file_str, file_times in by_file.items():
        from pathlib import Path as _Path
        file_path = _Path(file_str)
        reader    = get_reader(file_path)
        sig       = inspect.signature(reader.read_points)

        try:
            extra = {}
            if 'target_dt'      in sig.parameters: extra['target_dt']      = center_dt
            if 'window_minutes' in sig.parameters: extra['window_minutes'] = window_minutes

            result = await reader.read_points(
                path    = file_path,
                var_map = {},
                bbox    = parsed_bbox,
                **extra,
            )
            for pt in result.points:
                pt['_source_key'] = (
                    file_times[0].key if file_times else center_key
                )
            all_points.extend(result.points)

        except Exception as e:
            print(f"[points/window] Skipping {file_path.name}: {e}")

    if dedupe_field:
        all_points = _deduplicate(all_points, dedupe_field, center_dt)

    merged = PointResult(
        source_type = getattr(source, 'source_type', 'point'),
        valid_time  = center_key,
        points      = all_points,
        metadata    = {
            "window_minutes": window_minutes,
            "files_used"    : len(by_file),
            "total_points"  : len(all_points),
        },
    )
    return JSONResponse(merged.as_geojson())


@router.get("/{source_id}/lsrs")
async def get_lsrs(
    source_id    : str,
    center_key   : str            = Query(...),
    window_hours : float          = Query(6.0, ge=0.5, le=48.0),
    event_types  : Optional[str]  = Query(None),
    min_magnitude: Optional[float]= Query(None),
    bbox         : Optional[str]  = Query(None),
):
    """Return Local Storm Reports with type/magnitude filtering."""
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    center_dt   = _parse_key_to_dt(center_key)
    if center_dt is None:
        raise HTTPException(422, f"Cannot parse center_key '{center_key}'")

    window      = timedelta(hours=window_hours)
    times       = await source.list_times(
        after  = center_dt - window,
        before = center_dt,
        limit  = 500,
    )

    parsed_bbox = _parse_bbox(bbox)
    type_filter = {t.strip().upper() for t in event_types.split(",")} \
                  if event_types else None
    all_points  = []
    import inspect

    for t in times:
        path = await source.get_path(t.key)
        if path is None:
            continue
        reader = get_reader(path)
        sig    = inspect.signature(reader.read_points)
        extra  = {}
        if 'target_dt'      in sig.parameters: extra['target_dt']      = center_dt
        if 'window_minutes' in sig.parameters: extra['window_minutes'] = int(window_hours * 60)

        try:
            result = await reader.read_points(
                path=path, var_map={}, bbox=parsed_bbox, **extra
            )
            for pt in result.points:
                event = str(pt.get('event_type') or pt.get('type') or '').upper()
                if type_filter and event not in type_filter:
                    continue
                mag = pt.get('magnitude') or pt.get('mag')
                if min_magnitude is not None and mag is not None:
                    try:
                        if float(mag) < min_magnitude:
                            continue
                    except (TypeError, ValueError):
                        pass
                all_points.append(pt)
        except Exception as e:
            print(f"[points/lsrs] Skipping {t.key}: {e}")

    result = PointResult(
        source_type = 'lsr',
        valid_time  = center_key,
        points      = all_points,
        metadata    = {
            "window_hours"      : window_hours,
            "event_type_filter" : list(type_filter) if type_filter else None,
            "min_magnitude"     : min_magnitude,
            "total_reports"     : len(all_points),
        },
    )
    return JSONResponse(result.as_geojson())


# ── Helpers ────────────────────────────────────────────────────────────────────

def _parse_bbox(s):
    if not s: return None
    try:
        p = [float(x) for x in s.split(",")]
        return tuple(p) if len(p) == 4 else None
    except ValueError:
        return None

def _parse_key_to_dt(key: str) -> datetime | None:
    k = key.replace("_", "")
    for fmt in ("%Y%m%d%H%M", "%Y%m%d%H"):
        try:
            return datetime.strptime(k, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None

def _build_var_map(source, var_list):
    svm = getattr(source, 'variable_map', {})
    return {v: svm.get(v, v) for v in var_list}

def _filter_by_age(result: PointResult, max_age_minutes: int) -> PointResult:
    now    = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=max_age_minutes)
    
    print(now, cutoff, result.points[0].get('valid_time'))
    result.points = [
        pt for pt in result.points
        if (t := pt.get('valid_time')) is None or
           datetime.fromtimestamp(float(t), tz=timezone.utc) >= cutoff
    ]
    return result

def _deduplicate(points: list, field: str, center_dt: datetime) -> list:
    best = {}
    for pt in points:
        kv = pt.get(field)
        if kv is None: continue
        if kv not in best:
            best[kv] = pt
        else:
            ek = best[kv].get('_source_key', '')
            nk = pt.get('_source_key', '')
            ed = _parse_key_to_dt(ek)
            nd = _parse_key_to_dt(nk)
            if ed and nd and center_dt:
                if abs((nd - center_dt).total_seconds()) < \
                   abs((ed - center_dt).total_seconds()):
                    best[kv] = pt
    return list(best.values())
