"""
sources/filesystem.py — Filesystem-based DataSource  (fixed)

Fix: save cycle_regex and fhr_regex as public instance attributes so that
catalog.py (and any other code) can inspect them with src.cycle_regex and
src.fhr_regex.  Previously only the *compiled* versions (_cycle_re, _fhr_re)
were saved, so the raw strings were lost after __init__ returned.
"""

import re
import os
from datetime import datetime, timezone
from pathlib import Path

from .base import DataSource, AvailableTime


from ...utils.human_regex import human_pattern_to_regex

class FilesystemSource(DataSource):
    """
    A DataSource that scans a local directory for files matching a pattern.

    Parameters:
        source_id_      : The source_id string (e.g. 'MRMS', 'LIGHTNING')
        label_          : Human-readable name
        data_dir        : Directory to scan
        filename_glob   : Glob pattern to match files (e.g. 'mrms.*.cref.bin.gz')
        time_regex      : Regex string with named groups (year, month, day, hour,
                          minute, second) applied to the filename to extract the
                          valid time.
        cycle_regex     : Optional regex string to extract cycle time from filename.
                          Named groups: cyear, cmonth, cday, chour
        fhr_regex       : Optional regex string to extract forecast hour from filename.
                          Named group: fhr
        human_readable  : If True, regex patterns are specified in human-readable format.
        default_selected: Default number of frames to select on load (int, default 10; if -9999, load all available frames)
        timeline_hours  : Timeline length in hours to show on load (int, default 48)
    """

    def __init__(
        self,
        source_id_    : str,
        label_        : str,
        data_dir      : str | Path,
        filename_glob : str,
        time_regex    : str,
        cycle_regex   : str | None = None,
        fhr_regex     : str | None = None,
        source_type   : str = 'unknown',
        data_category : str = 'unknown',
        human_readable : bool = False,
        default_selected: int = 10,
        timeline_hours: int = 48,
    ):
        self._source_id    = source_id_
        self._label        = label_
        self._data_dir     = Path(data_dir)
        self._glob         = filename_glob

        print(f"Initializing FilesystemSource with source_id: {source_id_}, data_dir: {data_dir}, filename_glob: {filename_glob}, time_regex: {time_regex}, cycle_regex: {cycle_regex}, fhr_regex: {fhr_regex}, human_readable: {human_readable}")
        # ── Save the raw regex strings as public attributes ───────────────────
        if human_readable:
            self.time_regex = human_pattern_to_regex(time_regex)
            self.cycle_regex = human_pattern_to_regex(cycle_regex) if cycle_regex else None
            self.fhr_regex = human_pattern_to_regex(fhr_regex) if fhr_regex else None
        else:
            self.time_regex = time_regex
            self.cycle_regex = cycle_regex
            self.fhr_regex = fhr_regex

        print(f"Initialized FilesystemSource {self._source_id} with time_regex: {self.time_regex}, cycle_regex: {self.cycle_regex}, fhr_regex: {self.fhr_regex}")
        # ── Compiled regex objects (used internally for matching) ─────────────
        self._time_re    = re.compile(self.time_regex)
        self._cycle_re   = re.compile(self.cycle_regex)  if self.cycle_regex  else None
        self._fhr_re     = re.compile(self.fhr_regex)    if self.fhr_regex    else None

        # Cache: maps key → Path, populated lazily by list_times()
        self._cache: dict[str, Path] = {}

        # Optional attributes set externally or via constructor
        self.variable_map  : dict[str, str] = {}
        self.data_category : str = data_category
        self.source_type   : str = source_type

        # Data availability window (legacy, can be removed if unused)
        self.max_history_hours: int | None = None

        # UI/selection defaults
        self.default_selected: int = default_selected # Number of frames to select by default on load; if -9999, load all available
        self.timeline_hours: int = timeline_hours # Number of hours to show on timeline by default on load

    # ── DataSource interface ──────────────────────────────────────────────────

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def label(self) -> str:
        return self._label

    # ── Filename parsing ──────────────────────────────────────────────────────

    def _extract_time(self, filename: str) -> datetime | None:
        """Parse a valid time from a filename using the configured regex."""
        m = self._time_re.search(filename)
        if not m:
            return None
        g = m.groupdict()
        try:
            return datetime(
                year   = int(g.get("year",   0)),
                month  = int(g.get("month",  1)),
                day    = int(g.get("day",    1)),
                hour   = int(g.get("hour",   0)),
                minute = int(g.get("minute", 0)),
                second = int(g.get("second", 0)),
                tzinfo = timezone.utc,
            )
        except (ValueError, KeyError):
            return None

    def _extract_cycle(self, filename: str) -> str | None:
        """Extract the model cycle string (e.g. '2025030218') from a filename."""
        if not self._cycle_re:
            return None
        m = self._cycle_re.search(filename)
        if not m:
            return None
        g = m.groupdict()
        try:
            # Return as YYYYMMDDHH string — same format used in catalog responses
            return (
                f"{int(g['cyear']):04d}"
                f"{int(g['cmonth']):02d}"
                f"{int(g['cday']):02d}"
                f"{int(g['chour']):02d}"
            )
        except (KeyError, ValueError):
            return None

    def _extract_fhr(self, filename: str) -> int | None:
        """Extract the forecast hour integer from a filename."""
        print(filename)
        if not self._fhr_re:
            return None
        print(self._fhr_re.pattern)
        m = self._fhr_re.search(filename)
        print(m)
        if not m:
            return None
        try:
            return int(m.group("fhr"))
        except (IndexError, ValueError):
            return None

    def _make_key(self, valid_time: datetime) -> str:
        """
        Convert a datetime to the MultiPlotLayer key string.

        For analysis sources:  '20250302_1800'
        For forecast sources:  '{cycle}_f{fhr:03d}'  — built in list_times()
                               after both cycle and fhr are extracted.
        """
        return valid_time.strftime("%Y%m%d_%H%M")

    # ── list_times ────────────────────────────────────────────────────────────

    async def list_times(
        self,
        after  : datetime | None = None,
        before : datetime | None = None,
        limit  : int             = 200,
    ) -> list[AvailableTime]:
        """
        Scan the data directory and return AvailableTime objects.

        For forecast sources (cycle_regex + fhr_regex both set) the key is
        formatted as '{cycle}_f{fhr:03d}' so it is unique per cycle+fhr
        combination and sortable.

        For analysis/observation sources the key is 'YYYYMMDD_HHMM'.
        """
        results: list[AvailableTime] = []
        self._cache.clear()

        if not self._data_dir.exists():
            print(f"Data directory: {self._data_dir} does not exist.")
            return []
        
        for path in sorted(self._data_dir.glob(self._glob), reverse=True):
            vt = self._extract_time(path.name)
            if vt is None:
                continue

            # Apply time window filter
            if after  is not None and vt < after:
                continue
            if before is not None and vt > before:
                continue

            cycle = self._extract_cycle(path.name)
            fhr   = self._extract_fhr(path.name)

            # Build the key
            if cycle is not None and fhr is not None:
                # Forecast source: key uniquely identifies cycle + fhr
                key = f"{cycle}_f{fhr:03d}"
            else:
                # Analysis / observation source: key is the valid time
                key = self._make_key(vt)
            self._cache[key] = path

            # Also cache a cycle alias for one-file-per-cycle forecast stores.
            # This lets /forecast resolve by cycle even when no fhr appears
            # in filenames and forecast lead selection happens inside a reader.
            if cycle is not None and fhr is None:
                self._cache[cycle] = path

            at = AvailableTime(
                valid_time  = vt,
                key         = key,
                path        = path,
                cycle       = cycle,
                fhr         = fhr,
                size_bytes  = path.stat().st_size,
            )
            results.append(at)

            if len(results) >= limit:
                break

        return results

    async def get_path(self, key: str) -> Path | None:
        """Return the filesystem path for a given key, populating cache if needed."""
        if not self._cache:
            print(self.list_times())
            await self.list_times()
        print(self._cache.get(key))
        return self._cache.get(key)

    async def most_recent(self) -> AvailableTime | None:
        """Return the single most recent available time."""
        times = await self.list_times(limit=1)
        print(times)
        return times[0] if times else None
