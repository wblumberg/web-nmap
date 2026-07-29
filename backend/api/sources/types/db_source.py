"""DB-backed DataSource implementations.

DBSource       — generic single-row-per-AvailableTime source (legacy prototype)
PointDBSource  — point-obs source that returns *distinct* valid_time bins from
                 the `points` hypertable, matching the FilesystemSource interface
                 so the catalog, timematch, and router code all work unchanged.
AlertSource    — specialized source for NWS alerts from the `alerts` hypertable,
                 representing one significance level (Warning / Watch / Advisory).
ProfileDBSource — source for vertical profile observations stored in `profiles`.
CycloneTrackDBSource — source for ATCF cyclone forecast points in `atcf_tracks`.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from ...db.engine import get_engine
from .base import DataSource, AvailableTime


class DBSource(DataSource):
    """Generic DB-backed source.

    Parameters:
      source_id_: logical source identifier (e.g. 'LIGHTNING')
      table: DB table name where rows for this source are stored (e.g. 'points')
    """

    def __init__(self, source_id_: str, table: str = "points"):
        self._source_id = source_id_
        self.table = table
        self._engine: AsyncEngine = get_engine()

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def label(self) -> str:
        return f"DB-backed {self._source_id}"

    async def list_times(
        self,
        after: Optional[datetime] = None,
        before: Optional[datetime] = None,
        limit: int = 200,
        params: dict[str, Any] | None = None,
    ):
        """Return recent available times for this source from the DB.

        This maps DB rows to `AvailableTime`. The `key` is set to a
        stable string including the DB id so callers can request details
        via `get_path()` using that key.
        """
        after = after or datetime(1970, 1, 1, tzinfo=timezone.utc)
        before = before or datetime.now(tz=timezone.utc)

        sql = text(
            f"SELECT id, valid_time, cycle, fhr FROM {self.table}"
            " WHERE source_id = :source_id AND valid_time BETWEEN :after AND :before"
            " ORDER BY valid_time DESC LIMIT :limit"
        )

        params = {"source_id": self._source_id, "after": after, "before": before, "limit": limit}

        results = []
        async with self._engine.connect() as conn:
            r = await conn.execute(sql, params)
            rows = r.fetchall()
            for row in rows:
                db_id = row[0]
                vt = row[1]
                cycle = row[2]
                fhr = row[3]
                # key format: YYYYMMDD_HHMM_db<ID>
                key = f"{vt.strftime('%Y%m%d_%H%M')}_db{db_id}"
                at = AvailableTime(
                    valid_time=vt,
                    key=key,
                    path=None,
                    cycle=cycle,
                    fhr=fhr,
                    size_bytes=None,
                )
                results.append(at)

        return results

    async def get_path(self, key: str):
        """For DB sources `key` is expected to end with `_db<ID>` and we
        return the raw row as a dict. Routers that consume DB-backed
        sources should branch accordingly.
        """
        # parse db id suffix
        if '_db' not in key:
            return None
        try:
            db_id = int(key.split('_db')[-1])
        except ValueError:
            return None

        sql = text(f"SELECT * FROM {self.table} WHERE id = :id")
        async with self._engine.connect() as conn:
            r = await conn.execute(sql, {"id": db_id})
            row = r.fetchone()
            if row is None:
                return None
            # convert RowMapping -> dict
            try:
                return dict(row._mapping)
            except Exception:
                # fallback for DBAPI Rows
                return dict(row)


class PointDBSource(DataSource):
    """DataSource backed by the `points` TimescaleDB hypertable.

    Unlike the legacy DBSource (which returns one AvailableTime per row),
    this class queries *distinct* valid_time bins so the catalog timeline
    shows one entry per observation time rather than one per data point.

    It matches the FilesystemSource attribute interface expected by the
    catalog router (source_type, data_category, cycle_regex, fhr_regex,
    default_selected, timeline_hours) so no router changes are needed.
    
    This is meant to be a generic point-obs source for any data type stored in
    the `points` hypertable, (e.g. lightning, surface obs, etc.)

    Parameters:
        source_id_      : Matches the ``source_id`` column in ``points``.
        label_          : Human-readable name shown in the UI.
        source_type     : Catalog source type string (e.g. "OBS_SURFACE").
        data_category   : Catalog data category (e.g. "point_obs").
        default_selected: Default frame count to load in the UI.
        timeline_hours  : How many hours of history to display in the timeline.
        table           : DB table name (default "points").
    """

    # These attributes shadow FilesystemSource so that catalog/timematch
    # code using getattr(src, 'cycle_regex', None) gets None gracefully.
    cycle_regex:   None = None
    fhr_regex:     None = None
    endpoint_type: str  = 'point_obs'

    def __init__(
        self,
        source_id_      : str,
        label_          : str,
        source_type     : str = "OBS_SURFACE",
        data_category   : str = "point_obs",
        default_selected: int = 10,
        timeline_hours  : int = 24,
        table           : str = "points",
        binflag         : bool = False,   # e.g. "peak_current_ka" to bin lightning by current strength
        before_minutes  : Optional[int] = None, # if binflag=True, look for data points this many minutes before frame time
        after_minutes   : Optional[int] = None, # if binflag=True, look for data points this many minutes after frame time
        use_most_recent_filter: bool = False, # if True, return only the most recent point per station_id within the time window
        most_recent_by  : str  = 'geom', # column to deduplicate on: 'station_id' or 'geom'
        return_age      : bool = False, # whether to calculate and return age_minutes for each point based on valid_time and reference time
    ):
        self._source_id       = source_id_
        self._label           = label_
        self.source_type      = source_type
        self.data_category    = data_category
        self.default_selected = default_selected
        self.timeline_hours   = timeline_hours
        self.table            = table
        self.binflag          = binflag # Similar to binflag in datatype.tbl
        self.before_minutes   = before_minutes
        self.after_minutes    = after_minutes
        self.use_most_recent_filter = use_most_recent_filter
        self.most_recent_by   = most_recent_by
        self.return_age       = return_age  # whether to calculate and return age_minutes for each point based on valid_time and reference time
        self._engine: AsyncEngine = get_engine()

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def label(self) -> str:
        return self._label

    async def list_times(
        self,
        after  : Optional[datetime] = None,
        before : Optional[datetime] = None,
        limit  : int = 200,
        params : dict[str, Any] | None = None,
    ) -> list[AvailableTime]:
        """Return distinct valid_time bins for this source, newest first."""
        after  = after  or datetime(1970, 1, 1, tzinfo=timezone.utc)
        before = before or datetime.now(tz=timezone.utc)

        sql = text(f"""
            SELECT DISTINCT time_bucket('1 minute', valid_time) AS valid_time
            FROM {self.table}
            WHERE source_id = :source_id
            AND valid_time BETWEEN :after AND :before
            ORDER BY valid_time DESC
            LIMIT :limit
        """)
        params = {
            "source_id": self._source_id,
            "after": after,
            "before": before,
            "limit": limit,
        }

        async with self._engine.connect() as conn:
            res  = await conn.execute(sql, params)
            rows = res.fetchall()

        result = []
        for row in rows:
            vt  = row[0]
            key = vt.strftime("%Y%m%d_%H%M") if hasattr(vt, "strftime") else str(vt)
            result.append(AvailableTime(
                valid_time=vt,
                key=key,
                path=None,
            ))
        return result

    async def get_path(self, key: str):
        """DB sources have no file path — return None.

        Routers that serve DB-backed sources (points_db.py) use
        services/points_sql.py directly and do not call get_path().
        """
        return None

    async def most_recent(self, params: dict[str, Any] | None = None) -> Optional[AvailableTime]:
        """Return the most recent available time, or None if the table is empty."""
        sql = text(f"""
            SELECT MAX(valid_time) FROM {self.table}
            WHERE source_id = :source_id
        """)
        async with self._engine.connect() as conn:
            vt = await conn.scalar(sql, {"source_id": self._source_id})
        if vt is None:
            return None
        key = vt.strftime("%Y%m%d_%H%M") if hasattr(vt, "strftime") else str(vt)
        return AvailableTime(valid_time=vt, key=key, path=None)


class AlertSource(DataSource):
    """DataSource backed by the ``alerts`` TimescaleDB hypertable.

    Represents one significance level (Warning / Watch / Advisory) rather
    than one specific alert type.  Phenomenon filtering is applied at query
    time via the ``phen`` parameter on the geometries endpoint.
    
    These alerts are intended to be only watches, warnings, and advisories.

    Parameters
    ----------
    source_id_:
        The source_id used in URLs, e.g. ``"alerts_warnings"``.
    label_:
        Human-readable name, e.g. ``"Warnings"``.
    sig:
        One-letter VTEC significance code: ``"W"``, ``"A"``, or ``"Y"``.
    timeline_hours:
        How many hours of history to surface in the catalog timeline.
    """

    cycle_regex:   None = None
    fhr_regex:     None = None
    endpoint_type: str  = 'geometry'

    def __init__(
        self,
        source_id_ : str,
        label_     : str,
        sig        : str,
        timeline_hours: int = 6,
    ):
        self._source_id     = source_id_
        self._label         = label_
        self.sig            = sig
        self.source_type    = "MISC"
        self.data_category  = "alerts"
        self.default_selected = 1
        self.timeline_hours = timeline_hours
        self._engine: AsyncEngine = get_engine()

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def label(self) -> str:
        return self._label

    async def list_times(
        self,
        after  : Optional[datetime] = None,
        before : Optional[datetime] = None,
        limit  : int = 200,
        params : dict[str, Any] | None = None,
    ) -> list[AvailableTime]:
        """Return distinct start_utc values for this significance level, newest first.

        Each returned key is an ISO-8601 string usable directly as the ``at``
        parameter on the geometries endpoint.
        """
        after  = after  or datetime(1970, 1, 1, tzinfo=timezone.utc)
        before = before or datetime.now(tz=timezone.utc)

        sql = text("""
            SELECT DISTINCT start_utc
            FROM alerts
            WHERE significance = :sig
              AND start_utc BETWEEN :after AND :before
            ORDER BY start_utc DESC
            LIMIT :limit
        """)
        params = {"sig": self.sig, "after": after, "before": before, "limit": limit}

        async with self._engine.connect() as conn:
            res  = await conn.execute(sql, params)
            rows = res.fetchall()

        result = []
        for row in rows:
            vt  = row[0]
            key = vt.isoformat() if hasattr(vt, "isoformat") else str(vt)
            result.append(AvailableTime(valid_time=vt, key=key, path=None))
        return result

    async def get_path(self, key: str):
        """Alert sources have no file path — geometry is queried from the DB."""
        return None

    async def most_recent(self, params: dict[str, Any] | None = None) -> Optional[AvailableTime]:
        """Return the most recent start_utc for this significance level."""
        sql = text("""
            SELECT MAX(start_utc) FROM alerts WHERE significance = :sig
        """)
        async with self._engine.connect() as conn:
            vt = await conn.scalar(sql, {"sig": self.sig})
        if vt is None:
            return None
        key = vt.isoformat() if hasattr(vt, "isoformat") else str(vt)
        return AvailableTime(valid_time=vt, key=key, path=None)


class ProfileDBSource(DataSource):
    """DB-backed source for vertical profile observations.
    
    This is a generic source for any data type stored in the `profiles` hypertable.
    Possible data sources that this is intended for:
    - Radiosondes
    - Dropsondes
    - WSR-88D VAD Vertical Wind Profiles
    - Radar Wind Profilers
    - Thermodynamic Profilers
    - ACARS Profiles

    Rows are expected in a `profiles` hypertable with one row per station/time
    and vertical arrays encoded in JSONB.
    
    """

    cycle_regex:   None = None
    fhr_regex:     None = None
    endpoint_type: str  = "profile_obs"
    time_column:   str  = "valid_time"

    def __init__(
        self,
        source_id_: str,
        label_: str,
        source_type: str = "OBS_UPPERAIR",
        data_category: str = "profile_obs",
        default_selected: int = 1,
        timeline_hours: int = 24,
        table: str = "profiles",
        use_most_recent_filter: bool = False,
        most_recent_by: Optional[str] = None,
        before_minutes: Optional[int] = None,
        after_minutes: Optional[int] = None,
    ):
        self._source_id = source_id_
        self._label = label_
        self.source_type = source_type
        self.data_category = data_category
        self.default_selected = default_selected
        self.timeline_hours = timeline_hours
        self.table = table
        self.use_most_recent_filter = use_most_recent_filter
        self.most_recent_by = most_recent_by
        self.before_minutes = before_minutes
        self.after_minutes = after_minutes
        self._engine: AsyncEngine = get_engine()

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def label(self) -> str:
        return self._label

    async def list_times(
        self,
        after: Optional[datetime] = None,
        before: Optional[datetime] = None,
        limit: int = 200,
        params: dict[str, Any] | None = None,
    ) -> list[AvailableTime]:
        """Return distinct observation-minute bins, newest first.

        ``use_most_recent_filter`` applies when fetching a frame, not when
        constructing the timeline.  Using one latest timestamp per station
        here produces a list of unrelated station times; nearest-time matching
        can then move a requested frame into the future before the profile
        endpoint applies its backward-looking window.
        """
        after = after or datetime(1970, 1, 1, tzinfo=timezone.utc)
        before = before or datetime.now(tz=timezone.utc)

        sql = text(f"""
            SELECT DISTINCT time_bucket('1 minute', valid_time) AS valid_time
            FROM {self.table}
            WHERE source_id = :source_id
              AND valid_time BETWEEN :after AND :before
            ORDER BY valid_time DESC
            LIMIT :limit
        """)
        
        bind = {
            "source_id": self._source_id,
            "after": after,
            "before": before,
            "limit": limit,
        }

        async with self._engine.connect() as conn:
            res = await conn.execute(sql, bind)
            rows = res.fetchall()

        out: list[AvailableTime] = []
        for row in rows:
            vt = row[0]
            key = vt.strftime("%Y%m%d_%H%M") if hasattr(vt, "strftime") else str(vt)
            out.append(AvailableTime(valid_time=vt, key=key, path=None))
        return out

    async def get_path(self, key: str):
        return None

    async def most_recent(self, params: dict[str, Any] | None = None) -> Optional[AvailableTime]:
        sql = text(f"""
            SELECT MAX(valid_time) FROM {self.table} WHERE source_id = :source_id
        """)
        async with self._engine.connect() as conn:
            vt = await conn.scalar(sql, {"source_id": self._source_id})
        if vt is None:
            return None
        key = vt.strftime("%Y%m%d_%H%M") if hasattr(vt, "strftime") else str(vt)
        return AvailableTime(valid_time=vt, key=key, path=None)


class CycloneTrackDBSource(DataSource):
    """DB-backed source for ATCF cyclone forecast track points.
    
    This source is backed by the `atcf_tracks` hypertable.

    This is a service to retrieve the ATCF forecast points for a given cycle or model.

    Exposes cycles/fhrs through list_times by returning one AvailableTime per
    (cycle_time, fhr) pair. This allows existing catalog cycle endpoints to
    work with DB-backed tracks.
    """

    cycle_regex:   str  = "DB_CYCLE"
    fhr_regex:     str  = "DB_FHR"
    endpoint_type: str  = "geometry"
    time_column:   str  = "valid_time"

    def __init__(
        self,
        source_id_: str,
        label_: str,
        source_type: str = "MISC",
        data_category: str = "cyclone_tracks",
        default_selected: int = 1,
        timeline_hours: int = 240,
        table: str = "atcf_tracks",
    ):
        self._source_id = source_id_
        self._label = label_
        self.source_type = source_type
        self.data_category = data_category
        self.default_selected = default_selected
        self.timeline_hours = timeline_hours
        self.table = table
        self._engine: AsyncEngine = get_engine()

    @property
    def source_id(self) -> str:
        return self._source_id

    @property
    def label(self) -> str:
        return self._label

    async def list_times(
        self,
        after: Optional[datetime] = None,
        before: Optional[datetime] = None,
        limit: int = 200,
        params: dict[str, Any] | None = None,
    ) -> list[AvailableTime]:
        after = after or datetime(1970, 1, 1, tzinfo=timezone.utc)
        before = before or datetime.now(tz=timezone.utc)

        sql = text(f"""
            SELECT cycle_time, fhr, MIN(valid_time) AS valid_time
            FROM {self.table}
            WHERE source_id = :source_id
              AND cycle_time BETWEEN :after AND :before
            GROUP BY cycle_time, fhr
            ORDER BY cycle_time DESC, fhr ASC
            LIMIT :limit
        """)
        bind = {
            "source_id": self._source_id,
            "after": after,
            "before": before,
            "limit": limit,
        }

        async with self._engine.connect() as conn:
            res = await conn.execute(sql, bind)
            rows = res.fetchall()

        out: list[AvailableTime] = []
        for row in rows:
            cycle_time = row[0]
            fhr = row[1]
            valid_time = row[2]
            cycle = cycle_time.strftime("%Y%m%d%H") if hasattr(cycle_time, "strftime") else str(cycle_time)
            key = f"{cycle}_f{int(fhr):03d}"
            out.append(
                AvailableTime(
                    valid_time=valid_time,
                    key=key,
                    path=None,
                    cycle=cycle,
                    fhr=int(fhr),
                    size_bytes=None,
                )
            )
        return out

    async def get_path(self, key: str):
        return None

    async def most_recent(self, params: dict[str, Any] | None = None) -> Optional[AvailableTime]:
        sql = text(f"""
            SELECT MAX(cycle_time) FROM {self.table} WHERE source_id = :source_id
        """)
        async with self._engine.connect() as conn:
            cycle_time = await conn.scalar(sql, {"source_id": self._source_id})
        if cycle_time is None:
            return None
        cycle = cycle_time.strftime("%Y%m%d%H") if hasattr(cycle_time, "strftime") else str(cycle_time)
        return AvailableTime(valid_time=cycle_time, key=cycle, path=None, cycle=cycle, fhr=None)

