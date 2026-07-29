"""
routers/timematch.py — Multi-Source Time Matching

Answers: "I am displaying RAP hour 006 — what key should each of my other
active sources (MRMS, SURFACE_OBS, LIGHTNING) show right now?"

─── Why do this server-side? ────────────────────────────────────────────────

The JavaScript TimeMatchingEngine.js already works for matching keys that
are already known to the browser. But there is a problem: the browser only
knows the keys it has already fetched. It doesn't know what is actually on
disk. So if MRMS has files every 2 minutes and you only pre-fetched every
5 minutes, the JS engine can only match to the 5-minute keys it knows about.

This API has access to the full directory listing, so it can match to the
true nearest file, not just the subset the browser happened to load.

Also: one call here replaces N separate /catalog/{source}/times/nearest
calls, which is faster and simpler JavaScript.

─── Endpoints ───────────────────────────────────────────────────────────────

GET  /api/v1/timematch/sources/{source_id}/valid_range
    → Return the earliest and latest available times for a source.
      Useful for configuring the time slider range in the UI.
    
GET  /api/v1/timematch/sources/{source_id}/check_overlap
    → Check whether a source has enough data within a given time window.

POST /api/v1/timematch/match
    → Given a dominant key and a list of secondary source IDs, return the
      best-matching key for each secondary source.

POST /api/v1/timematch/build_map
    → Given a dominant source and a list of secondary sources, return the
      complete match map for ALL dominant keys (equivalent to buildMatchMap()
      in TimeMatchingEngine.js, but computed server-side from real file
      listings). The browser can cache this and use it for instant stepping.

TODO: Implement a time matching strategy that matches data to only the nearest time in the past,
    the nearest time in the future, the exact time, or the nearest time in either direction.
    This will be useful for sources that are not continuous in time, such as upper air soundings, 
    which are only available at certain times of the day.  The time matching strategy should
    be specified using default values the server can use, but also allow the user to specify a time
    matching strategy for each source in the UI.  
    
"""

from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..sources.registry import get_source, SOURCES

router = APIRouter(tags=["Time Matching"])


# ─── Request / Response models ────────────────────────────────────────────────
#
# Pydantic models define the shape of POST request bodies and responses.
# FastAPI validates incoming JSON against these automatically and returns
# a clear 422 error if the shape is wrong.
#
# Think of them as "type declarations" for the API contract — the same
# role that TypeScript interfaces play on the JavaScript side.

class MatchRequest(BaseModel):
    """
    Request body for POST /match

    Fields:
        dominant_key        : The active key on the dominant (loop-driving) source.
                              e.g. '20250302_1800'
        dominant_source_id  : Which source the dominant key belongs to.
                              e.g. 'RAP'
        secondary_source_ids: List of source IDs to match against.
                              e.g. ['MRMS', 'SURFACE_OBS', 'LIGHTNING']
        window_hours        : How far (±hours) to search for a match.
                              Increase this for sparse sources like upper-air soundings.
    """
    dominant_key          : str        = Field(..., example="20250302_1800")
    dominant_source_id    : str        = Field(..., example="RAP")
    secondary_source_ids  : list[str]  = Field(..., example=["MRMS", "SURFACE_OBS"])
    window_hours          : float      = Field(1.0, ge=0.1, le=48.0)


class MatchedSource(BaseModel):
    """One entry in the match result — the best key found for one secondary source."""
    source_id     : str
    matched_key   : str | None   # None if no match found within the window
    matched_time  : str | None   # ISO datetime of the matched key
    delta_minutes : float | None # How far off the match is (0 = exact)
    status        : str          # 'matched' | 'no_data' | 'unknown_source'


class MatchResponse(BaseModel):
    dominant_source_id : str
    dominant_key       : str
    dominant_time      : str   # ISO datetime
    matches            : list[MatchedSource]


class BuildMapRequest(BaseModel):
    """
    Request body for POST /build_map

    This asks for the complete time-match table for all available dominant
    keys — the server-side equivalent of buildMatchMap() in
    TimeMatchingEngine.js.

    The response can be cached by the browser for the lifetime of the
    current loop configuration. When new data arrives (via SSE), the browser
    can call this again to refresh just the tail of the map.

    Fields:
        dominant_source_id   : Drives the loop (e.g. 'RAP')
        secondary_source_ids : Sources to match against (e.g. ['MRMS', 'SURFACE_OBS'])
        dominant_keys        : Optional — if omitted, uses all available dominant keys.
                               Pass a subset to limit the response size.
        window_hours         : Match search window, same as MatchRequest.
    """
    dominant_source_id   : str
    secondary_source_ids : list[str]
    dominant_keys        : list[str] | None = Field(
        None,
        description="If omitted, all available dominant keys are used."
    )
    window_hours         : float = Field(1.0, ge=0.1, le=48.0)


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/match", response_model=MatchResponse)
async def match_single_time(req: MatchRequest):
    """
    Match one dominant key against multiple secondary sources simultaneously.

    This is the endpoint PanelManager calls on every time-step when it needs
    to know what each secondary slot should display.

    Example request body:
        {
          "dominant_key": "20250302_1800",
          "dominant_source_id": "RAP",
          "secondary_source_ids": ["MRMS", "SURFACE_OBS", "LIGHTNING"],
          "window_hours": 3
        }

    Example response:
        {
          "dominant_source_id": "RAP",
          "dominant_key": "20250302_1800",
          "dominant_time": "2025-03-02T18:00:00Z",
          "matches": [
            {
              "source_id": "MRMS",
              "matched_key": "20250302_1758",
              "matched_time": "2025-03-02T17:58:00Z",
              "delta_minutes": 2.0,
              "status": "matched"
            },
            {
              "source_id": "SURFACE_OBS",
              "matched_key": "20250302_1800",
              "matched_time": "2025-03-02T18:00:00Z",
              "delta_minutes": 0.0,
              "status": "matched"
            },
            {
              "source_id": "LIGHTNING",
              "matched_key": "20250302_1755",
              "matched_time": "2025-03-02T17:55:00Z",
              "delta_minutes": 5.0,
              "status": "matched"
            }
          ]
        }
    """
    # Parse the dominant key to a datetime so we can compute differences
    dominant_dt = _parse_key(req.dominant_key)
    if dominant_dt is None:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Cannot parse dominant_key '{req.dominant_key}'. "
                f"Expected format: YYYYMMDD_HHMM or YYYYMMDDHHMM"
            )
        )

    # Match each secondary source in parallel using asyncio.gather()
    # gather() runs all the async calls concurrently — much faster than
    # awaiting them one by one in a loop.
    import asyncio
    match_tasks = [
        _find_best_match(source_id, dominant_dt, req.window_hours)
        for source_id in req.secondary_source_ids
    ]
    matched_sources: list[MatchedSource] = await asyncio.gather(*match_tasks)

    return MatchResponse(
        dominant_source_id = req.dominant_source_id,
        dominant_key       = req.dominant_key,
        dominant_time      = dominant_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        matches            = matched_sources,
    )


@router.post("/build_map")
async def build_match_map(req: BuildMapRequest):
    """
    Build the complete time-match table for all dominant keys.

    This is the server-side equivalent of buildMatchMap() in
    TimeMatchingEngine.js. The browser calls this once when a new set of
    sources is configured, caches the result, and uses it for O(1) time-step
    lookups without making any API calls during the loop.

    The response is a nested object:
        {
          "dominant_source_id": "RAP",
          "secondary_source_ids": ["MRMS", "SURFACE_OBS"],
          "map": {
            "20250302_0000": {
              "MRMS":        "20250302_0002",
              "SURFACE_OBS": "20250302_0000"
            },
            "20250302_0100": {
              "MRMS":        "20250302_0058",
              "SURFACE_OBS": "20250302_0100"
            },
            ...
          }
        }

    The "map" object can be stored directly in the browser and used exactly
    like the output of TimeMatchingEngine.buildMatchMap().
    """
    import asyncio

    # ── Step 1: determine which dominant keys to process ──────────────────
    if req.dominant_keys is not None:
        # Caller specified explicit keys — parse them to datetimes
        dominant_times = []
        for k in req.dominant_keys:
            dt = _parse_key(k)
            if dt is None:
                raise HTTPException(422, f"Cannot parse dominant key '{k}'")
            dominant_times.append((k, dt))
    else:
        # Fetch all available dominant keys from the source
        try:
            dom_source = get_source(req.dominant_source_id)
        except KeyError as e:
            raise HTTPException(404, str(e))

        available = await dom_source.list_times(limit=500)
        if not available:
            raise HTTPException(
                404,
                f"No data available for dominant source '{req.dominant_source_id}'"
            )
        dominant_times = [(t.key, t.valid_time) for t in available]

    # ── Step 2: for each secondary source, fetch its full time list once ──
    # We do this once upfront rather than once per dominant key, so we're
    # doing N + S database/disk queries instead of N * S queries.
    # (N = number of dominant keys, S = number of secondary sources)
    secondary_time_lists: dict[str, list] = {}
    for source_id in req.secondary_source_ids:
        try:
            source = get_source(source_id)
            # Expand single-store forecast sources to per-fhr virtual entries
            secondary_time_lists[source_id] = await _list_times_with_fhrs(source)
        except KeyError:
            secondary_time_lists[source_id] = []   # unknown source → no matches

    # ── Step 3: build the match map ───────────────────────────────────────
    match_map: dict[str, dict[str, str | None]] = {}

    for dom_key, dom_dt in dominant_times:
        match_map[dom_key] = {}

        for source_id, sec_times in secondary_time_lists.items():
            if not sec_times:
                match_map[dom_key][source_id] = None
                continue

            # Find the secondary time closest to this dominant time
            window_secs = req.window_hours * 3600
            best = _nearest_in_list(dom_dt, sec_times, window_secs)
            match_map[dom_key][source_id] = best.key if best else None

    return {
        "dominant_source_id"  : req.dominant_source_id,
        "secondary_source_ids": req.secondary_source_ids,
        "dominant_key_count"  : len(dominant_times),
        "map"                 : match_map,
    }


@router.get("/sources/{source_id}/valid_range")
async def get_valid_range(source_id: str):
    """
    Return the earliest and latest available times for a source.

    Used by the UI to configure the time slider min/max range, and to
    decide whether a source's data overlaps with the current loop window.

    Example response:
        {
          "source_id": "RAP",
          "earliest_key":  "20250301_0000",
          "earliest_time": "2025-03-01T00:00:00Z",
          "latest_key":    "20250302_1800",
          "latest_time":   "2025-03-02T18:00:00Z",
          "total_count":   43
        }
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    # Fetch all available times (newest → oldest by default)
    all_times = await source.list_times(limit=2000)

    if not all_times:
        raise HTTPException(
            404,
            f"No data available for source '{source_id}'"
        )

    # list_times() returns newest first, so:
    latest   = all_times[0]
    earliest = all_times[-1]

    return {
        "source_id"    : source_id,
        "earliest_key" : earliest.key,
        "earliest_time": earliest.valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_key"   : latest.key,
        "latest_time"  : latest.valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_count"  : len(all_times),
    }


@router.get("/sources/{source_id}/check_overlap")
async def check_overlap(
    source_id    : str,
    start_key    : str = Query(..., description="Start of the time window, e.g. 20250302_0000"),
    end_key      : str = Query(..., description="End of the time window, e.g. 20250302_1800"),
    min_coverage : float = Query(0.5, ge=0.0, le=1.0,
                                 description="Fraction of the window that must be covered (0–1)"),
):
    """
    Check whether a source has enough data within a given time window.

    Useful for the 'Add Source' dialog — before adding a source to the panel,
    check whether it actually has data for the current loop's time range.
    Returns a coverage fraction so the UI can warn the user if coverage is low.

    Example response:
        {
          "source_id": "SURFACE_OBS",
          "start_key": "20250302_0000",
          "end_key":   "20250302_1800",
          "available_count":  19,
          "coverage_fraction": 1.0,
          "has_sufficient_coverage": true
        }
    """
    try:
        source = get_source(source_id)
    except KeyError as e:
        raise HTTPException(404, str(e))

    start_dt = _parse_key(start_key)
    end_dt   = _parse_key(end_key)

    if start_dt is None:
        raise HTTPException(422, f"Cannot parse start_key '{start_key}'")
    if end_dt is None:
        raise HTTPException(422, f"Cannot parse end_key '{end_key}'")
    if start_dt >= end_dt:
        raise HTTPException(422, "start_key must be earlier than end_key")

    # Count available times in the window
    times_in_window = await source.list_times(
        after  = start_dt,
        before = end_dt,
        limit  = 2000,
    )

    # Estimate expected count: assume hourly data as a baseline
    # A source with hourly data in a 18-hour window → expect 19 files
    window_hours      = (end_dt - start_dt).total_seconds() / 3600.0
    expected_hourly   = window_hours + 1
    coverage_fraction = min(len(times_in_window) / max(expected_hourly, 1), 1.0)

    return {
        "source_id"               : source_id,
        "start_key"               : start_key,
        "end_key"                 : end_key,
        "available_count"         : len(times_in_window),
        "coverage_fraction"       : round(coverage_fraction, 2),
        "has_sufficient_coverage" : coverage_fraction >= min_coverage,
    }


# ─── Private helpers ──────────────────────────────────────────────────────────

async def _find_best_match(
    source_id    : str,
    target_dt    : datetime,
    window_hours : float,
) -> MatchedSource:
    """
    Find the best-matching key for one secondary source.
    Returns a MatchedSource regardless of whether a match is found
    (status field indicates success/failure).
    """
    # Handle unknown sources gracefully
    try:
        source = get_source(source_id)
    except KeyError:
        return MatchedSource(
            source_id     = source_id,
            matched_key   = None,
            matched_time  = None,
            delta_minutes = None,
            status        = "unknown_source",
        )

    # Fetch available times, expanding single-store forecast sources to per-fhr
    # virtual entries so that the returned matched_key encodes the forecast hour.
    window    = timedelta(hours=window_hours)
    all_times = await _list_times_with_fhrs(source)
    sec_times = [
        t for t in all_times
        if target_dt - window <= t.valid_time <= target_dt + window
    ]

    if not sec_times:
        return MatchedSource(
            source_id     = source_id,
            matched_key   = None,
            matched_time  = None,
            delta_minutes = None,
            status        = "no_data",
        )

    best          = _nearest_in_list(target_dt, sec_times, window.total_seconds())
    delta_secs    = abs((best.valid_time - target_dt).total_seconds())

    return MatchedSource(
        source_id     = source_id,
        matched_key   = best.key,
        matched_time  = best.valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        delta_minutes = round(delta_secs / 60.0, 1),
        status        = "matched",
    )


async def _list_times_with_fhrs(source) -> list:
    """
    Return available times for a source, expanding single-file-per-cycle
    forecast sources into per-fhr virtual AvailableTime entries.

    Sources like NSSL_GEFS or HREF store all forecast hours in one zarr store
    per cycle.  Their list_times() returns ONE entry per file (key = init time).
    For time-matching against observation sources to work, we need one entry per
    forecast hour so the returned matched_key encodes both cycle and fhr:
        e.g. "2026042200_f012"

    That key is then used by the gridded fetch endpoints to retrieve the exact
    forecast hour from the store.
    """
    from ..sources.types.base import AvailableTime
    from ..readers import get_reader

    times      = await source.list_times(limit=2000)
    cycle_re   = getattr(source, 'cycle_regex', None)
    fhr_re     = getattr(source, 'fhr_regex',   None)

    # Only expand sources that have cycles but no per-file fhr encoding
    if not (cycle_re and not fhr_re):
        return times
    if not any(t.fhr is None and t.cycle for t in times):
        return times

    expanded: list = []
    for t in times:
        if t.fhr is not None or not t.cycle or t.path is None:
            expanded.append(t)
            continue

        # Parse the cycle string (stored as str e.g. "2026042200") to datetime
        cycle_str = str(t.cycle)
        cycle_dt  = None
        for fmt in ("%Y%m%d%H", "%Y%m%d%H%M"):
            try:
                cycle_dt = datetime.strptime(cycle_str, fmt).replace(tzinfo=timezone.utc)
                break
            except ValueError:
                pass
        if cycle_dt is None:
            expanded.append(t)
            continue

        # Read forecast hours from the store
        try:
            reader       = get_reader(t.path)
            list_fhrs_fn = getattr(reader, 'list_forecast_hours', None)
            if list_fhrs_fn is None:
                expanded.append(t)
                continue
            fhrs = await list_fhrs_fn(t.path)
        except Exception as e:
            print(f"[timematch] could not expand fhrs for {t.path}: {e}")
            expanded.append(t)
            continue

        for fhr in fhrs:
            try:
                fhr_int = int(fhr)
            except (TypeError, ValueError):
                continue
            expanded.append(AvailableTime(
                valid_time = cycle_dt + timedelta(hours=fhr_int),
                key        = f"{cycle_str}_f{fhr_int:03d}",
                path       = t.path,
                cycle      = cycle_str,
                fhr        = fhr_int,
                size_bytes = t.size_bytes,
            ))

    return expanded


def _nearest_in_list(target_dt: datetime, times: list, window_secs: float):
    """
    Return the AvailableTime from `times` whose valid_time is closest to
    target_dt, within window_secs. Returns None if the list is empty.

    On a tie (two times equidistant from target), returns the earlier one
    — matching the convention in TimeMatchingEngine.js findBestMatch().
    """
    if not times:
        return None

    target_ts = target_dt.timestamp()
    best      = None
    best_diff = float("inf")

    for t in times:
        diff = abs(t.valid_time.timestamp() - target_ts)
        # Strictly less-than preserves the "prefer earlier on tie" rule
        if diff < best_diff:
            best_diff = diff
            best      = t

    # Reject the match if it falls outside the allowed window
    if best is not None and best_diff > window_secs:
        return None

    return best


def _parse_key(key: str) -> datetime | None:
    """
    Parse a MultiPlotLayer key string to a UTC datetime.
    Handles both 'YYYYMMDD_HHMM' and 'YYYYMMDDHHMM' formats.
    Returns None if neither format matches.
    """
    k = key.replace("_", "")
    for fmt in ("%Y%m%d%H%M", "%Y%m%d%H"):
        try:
            return datetime.strptime(k, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None
