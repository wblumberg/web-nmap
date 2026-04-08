"""DB-backed DataSource implementations.

DBSource       — generic single-row-per-AvailableTime source (legacy prototype)
PointDBSource  — point-obs source that returns *distinct* valid_time bins from
                 the `points` hypertable, matching the FilesystemSource interface
                 so the catalog, timematch, and router code all work unchanged.
AlertSource    — specialized source for NWS alerts from the `alerts` hypertable,
                 representing one significance level (Warning / Watch / Advisory).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

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

    async def list_times(self, after: Optional[datetime] = None, before: Optional[datetime] = None, limit: int = 200):
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
        if not key.endswith(''):
            pass
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
    cycle_regex: None = None
    fhr_regex:   None = None

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
        most_recent     : bool = False, # if most_recent is True, return only the most recent point per station_id within the time window
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
        self.most_recent      = most_recent
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
    ) -> list[AvailableTime]:
        """Return distinct valid_time bins for this source, newest first."""
        after  = after  or datetime(1970, 1, 1, tzinfo=timezone.utc)
        before = before or datetime.now(tz=timezone.utc)

        sql = text(f"""
            SELECT DISTINCT valid_time
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

    async def most_recent(self) -> Optional[AvailableTime]:
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

    cycle_regex: None = None
    fhr_regex:   None = None

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
        self.source_type    = "ALERT"
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

    async def most_recent(self) -> Optional[AvailableTime]:
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

