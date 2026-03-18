from __future__ import annotations

import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha1
from pathlib import Path
from typing import Any, Iterable


ISO_UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def to_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_iso_utc(dt: datetime) -> str:
    return to_utc(dt).strftime(ISO_UTC_FORMAT)


def parse_time_like(value: str | datetime | int | float | None) -> datetime | None:
    if value is None:
        return None

    if isinstance(value, datetime):
        return to_utc(value)

    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        value = str(int(value))

    if not isinstance(value, str):
        return None

    raw = value.strip()
    if not raw:
        return None

    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"

    # Unix epoch support (seconds: 10 digits, milliseconds: 13 digits)
    if raw.isdigit():
        try:
            if len(raw) == 10:
                return datetime.fromtimestamp(int(raw), tz=timezone.utc)
            if len(raw) == 13:
                return datetime.fromtimestamp(int(raw) / 1000.0, tz=timezone.utc)
        except (ValueError, OverflowError, OSError):
            pass

    try:
        return to_utc(datetime.fromisoformat(raw))
    except ValueError:
        pass

    for fmt in (
        "%Y%m%d_%H%M",
        "%Y%m%d%H%M",
        "%Y%m%d_%H%M%S",
        "%Y%m%d%H%M%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
    ):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except ValueError:
            continue

    return None


@dataclass
class ObservationInsert:
    obs_type: str
    obs_time: datetime
    payload: dict[str, Any]
    platform_id: str | None = None
    lat: float | None = None
    lon: float | None = None
    elevation_m: float | None = None
    source_name: str | None = None

    def normalized(self) -> "ObservationInsert":
        return ObservationInsert(
            obs_type=self.obs_type.strip().upper(),
            obs_time=to_utc(self.obs_time),
            payload=self.payload,
            platform_id=self.platform_id,
            lat=self.lat,
            lon=self.lon,
            elevation_m=self.elevation_m,
            source_name=self.source_name,
        )


class ObservationSQLStore:
    """
    SQLite-backed store for point observations.

    Supports:
    - fast insert with de-duplication
    - listing unique observation times
    - time-window and latest-only retrieval
    - optional time binning for API responses
    - delete/prune maintenance operations
    """

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA temp_store=MEMORY;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS observations (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    obs_type     TEXT    NOT NULL,
                    obs_time     TEXT    NOT NULL,
                    platform_id  TEXT,
                    lat          REAL,
                    lon          REAL,
                    elevation_m  REAL,
                    source_name  TEXT,
                    payload_json TEXT    NOT NULL,
                    event_hash   TEXT    NOT NULL UNIQUE,
                    inserted_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                );

                CREATE INDEX IF NOT EXISTS idx_observations_type_time
                    ON observations (obs_type, obs_time DESC);

                CREATE INDEX IF NOT EXISTS idx_observations_time
                    ON observations (obs_time DESC);

                CREATE INDEX IF NOT EXISTS idx_observations_type_platform_time
                    ON observations (obs_type, platform_id, obs_time DESC);

                CREATE INDEX IF NOT EXISTS idx_observations_source_time
                    ON observations (source_name, obs_time DESC);
                """
            )

    @staticmethod
    def _json_safe(value: Any) -> Any:
        """
        Convert arbitrary nested values into JSON-safe structures with
        deterministic string keys for dictionaries.
        """
        if isinstance(value, dict):
            out: dict[str, Any] = {}
            for key, item_value in value.items():
                key_s = "_null_key" if key is None else str(key)
                out[key_s] = ObservationSQLStore._json_safe(item_value)
            return out

        if isinstance(value, (list, tuple, set)):
            return [ObservationSQLStore._json_safe(v) for v in value]

        if isinstance(value, datetime):
            return to_iso_utc(value)

        if isinstance(value, Path):
            return str(value)

        if isinstance(value, (str, int, float, bool)) or value is None:
            return value

        return str(value)

    @staticmethod
    def _payload_json(payload: dict[str, Any]) -> str:
        return json.dumps(
            ObservationSQLStore._json_safe(payload),
            sort_keys=True,
            separators=(",", ":"),
        )

    @staticmethod
    def _event_hash(item: ObservationInsert, payload_json: str | None = None) -> str:
        payload_s = payload_json if payload_json is not None else ObservationSQLStore._payload_json(item.payload)
        text = "|".join(
            [
                item.obs_type.upper(),
                to_iso_utc(item.obs_time),
                item.platform_id or "",
                "" if item.lat is None else f"{item.lat:.8f}",
                "" if item.lon is None else f"{item.lon:.8f}",
                payload_s,
                item.source_name or "",
            ]
        )
        return sha1(text.encode("utf-8")).hexdigest()

    def insert_many(self, observations: Iterable[ObservationInsert]) -> dict[str, int]:
        rows = [ob.normalized() for ob in observations]
        if not rows:
            return {"submitted": 0, "inserted": 0, "duplicates": 0}

        params = []
        for item in rows:
            payload_json = self._payload_json(item.payload)
            params.append(
                (
                    item.obs_type,
                    to_iso_utc(item.obs_time),
                    item.platform_id,
                    item.lat,
                    item.lon,
                    item.elevation_m,
                    item.source_name,
                    payload_json,
                    self._event_hash(item, payload_json=payload_json),
                )
            )

        with self._connect() as conn:
            before = conn.total_changes
            conn.executemany(
                """
                INSERT OR IGNORE INTO observations (
                    obs_type, obs_time, platform_id, lat, lon,
                    elevation_m, source_name, payload_json, event_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                params,
            )
            inserted = conn.total_changes - before

        submitted = len(rows)
        return {
            "submitted": submitted,
            "inserted": inserted,
            "duplicates": max(0, submitted - inserted),
        }

    def list_obs_types(self) -> list[str]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT obs_type FROM observations ORDER BY obs_type ASC"
            ).fetchall()
        return [r["obs_type"] for r in rows]

    def latest_time(self, obs_types: list[str] | None = None) -> datetime | None:
        sql = "SELECT MAX(obs_time) AS latest FROM observations"
        args: list[Any] = []
        if obs_types:
            placeholders = ",".join("?" for _ in obs_types)
            sql += f" WHERE obs_type IN ({placeholders})"
            args.extend([t.upper() for t in obs_types])

        with self._connect() as conn:
            row = conn.execute(sql, args).fetchone()

        latest = row["latest"] if row else None
        return parse_time_like(latest)

    def list_unique_times(
        self,
        obs_types: list[str] | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        where_parts: list[str] = []
        args: list[Any] = []

        if obs_types:
            normalized = [t.upper() for t in obs_types]
            placeholders = ",".join("?" for _ in normalized)
            where_parts.append(f"obs_type IN ({placeholders})")
            args.extend(normalized)

        where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
        args.append(int(limit))

        sql = f"""
            SELECT
                obs_time,
                COUNT(*) AS row_count,
                COUNT(DISTINCT obs_type) AS type_count,
                GROUP_CONCAT(DISTINCT obs_type) AS present_types
            FROM observations
            {where_sql}
            GROUP BY obs_time
            ORDER BY obs_time DESC
            LIMIT ?
        """

        with self._connect() as conn:
            rows = conn.execute(sql, args).fetchall()

        out: list[dict[str, Any]] = []
        for row in rows:
            out.append(
                {
                    "obs_time": row["obs_time"],
                    "row_count": row["row_count"],
                    "type_count": row["type_count"],
                    "present_types": sorted(
                        [x for x in (row["present_types"] or "").split(",") if x]
                    ),
                }
            )
        return out

    def query_observations(
        self,
        *,
        obs_types: list[str] | None,
        center_time: datetime | None,
        minutes_before: int,
        minutes_after: int,
        latest_only: bool,
        prefer_most_data: bool,
        parameter_names: list[str] | None,
        bin_minutes: int,
        max_rows: int,
    ) -> dict[str, Any]:
        types = [t.upper() for t in obs_types] if obs_types else self.list_obs_types()
        if not types:
            return {
                "metadata": {
                    "row_count": 0,
                    "obs_types": [],
                    "mode": "empty",
                },
                "observations": [],
            }

        center = center_time or self.latest_time(types)
        if center is None:
            return {
                "metadata": {
                    "row_count": 0,
                    "obs_types": types,
                    "mode": "empty",
                },
                "observations": [],
            }

        start = center - timedelta(minutes=minutes_before)
        end = center + timedelta(minutes=minutes_after)

        if latest_only:
            payload = self._query_latest_only(
                obs_types=types,
                center=center,
                start=start,
                end=end,
                prefer_most_data=prefer_most_data,
                parameter_names=parameter_names,
                max_rows=max_rows,
            )
            payload["metadata"].update(
                {
                    "center_time": to_iso_utc(center),
                    "window_start": to_iso_utc(start),
                    "window_end": to_iso_utc(end),
                    "minutes_before": minutes_before,
                    "minutes_after": minutes_after,
                    "mode": "latest_only",
                }
            )
            return payload

        rows = self._fetch_window_rows(
            obs_types=types,
            start=start,
            end=end,
            max_rows=max_rows,
        )
        serialized = [self._serialize_row(r, parameter_names) for r in rows]

        base_metadata = {
            "obs_types": types,
            "center_time": to_iso_utc(center),
            "window_start": to_iso_utc(start),
            "window_end": to_iso_utc(end),
            "minutes_before": minutes_before,
            "minutes_after": minutes_after,
            "row_count": len(serialized),
            "max_rows": max_rows,
        }

        if bin_minutes > 0:
            bins = self._bin_serialized_rows(serialized, bin_minutes)
            return {
                "metadata": {
                    **base_metadata,
                    "mode": "window_binned",
                    "bin_minutes": bin_minutes,
                    "bin_count": len(bins),
                },
                "bins": bins,
                "observations": [],
            }

        return {
            "metadata": {**base_metadata, "mode": "window"},
            "observations": serialized,
        }

    def _fetch_window_rows(
        self,
        *,
        obs_types: list[str],
        start: datetime,
        end: datetime,
        max_rows: int,
    ) -> list[sqlite3.Row]:
        placeholders = ",".join("?" for _ in obs_types)
        args: list[Any] = [*obs_types, to_iso_utc(start), to_iso_utc(end), max_rows]

        sql = f"""
            SELECT
                id, obs_type, obs_time, platform_id, lat, lon,
                elevation_m, source_name, payload_json
            FROM observations
            WHERE obs_type IN ({placeholders})
              AND obs_time >= ?
              AND obs_time <= ?
            ORDER BY obs_time DESC, obs_type ASC
            LIMIT ?
        """

        with self._connect() as conn:
            rows = conn.execute(sql, args).fetchall()

        return rows

    def _query_latest_only(
        self,
        *,
        obs_types: list[str],
        center: datetime,
        start: datetime,
        end: datetime,
        prefer_most_data: bool,
        parameter_names: list[str] | None,
        max_rows: int,
    ) -> dict[str, Any]:
        with self._connect() as conn:
            selected_times: dict[str, str | None] = {}

            for obs_type in obs_types:
                in_window = self._choose_snapshot_time(
                    conn=conn,
                    obs_type=obs_type,
                    center=center,
                    start=start,
                    end=end,
                    prefer_most_data=prefer_most_data,
                )
                selected_times[obs_type] = in_window

            all_rows: list[sqlite3.Row] = []
            for obs_type, obs_time in selected_times.items():
                if obs_time is None:
                    continue
                rows = conn.execute(
                    """
                    SELECT
                        id, obs_type, obs_time, platform_id, lat, lon,
                        elevation_m, source_name, payload_json
                    FROM observations
                    WHERE obs_type = ? AND obs_time = ?
                    ORDER BY platform_id ASC
                    LIMIT ?
                    """,
                    (obs_type, obs_time, max_rows),
                ).fetchall()
                all_rows.extend(rows)

        serialized = [self._serialize_row(r, parameter_names) for r in all_rows]
        return {
            "metadata": {
                "obs_types": obs_types,
                "row_count": len(serialized),
                "max_rows": max_rows,
                "selected_snapshot_times": selected_times,
                "prefer_most_data": prefer_most_data,
            },
            "observations": serialized,
        }

    def _choose_snapshot_time(
        self,
        *,
        conn: sqlite3.Connection,
        obs_type: str,
        center: datetime,
        start: datetime,
        end: datetime,
        prefer_most_data: bool,
    ) -> str | None:
        center_iso = to_iso_utc(center)
        start_iso = to_iso_utc(start)
        end_iso = to_iso_utc(end)

        if prefer_most_data:
            row = conn.execute(
                """
                SELECT
                    obs_time,
                    COUNT(*) AS n,
                    ABS(strftime('%s', obs_time) - strftime('%s', ?)) AS dt
                FROM observations
                WHERE obs_type = ?
                  AND obs_time >= ?
                  AND obs_time <= ?
                GROUP BY obs_time
                ORDER BY n DESC, dt ASC, obs_time DESC
                LIMIT 1
                """,
                (center_iso, obs_type, start_iso, end_iso),
            ).fetchone()
            if row:
                return row["obs_time"]

            row = conn.execute(
                """
                SELECT obs_time, COUNT(*) AS n
                FROM observations
                WHERE obs_type = ?
                GROUP BY obs_time
                ORDER BY n DESC, obs_time DESC
                LIMIT 1
                """,
                (obs_type,),
            ).fetchone()
            return row["obs_time"] if row else None

        row = conn.execute(
            """
            SELECT obs_time
            FROM observations
            WHERE obs_type = ?
              AND obs_time >= ?
              AND obs_time <= ?
            ORDER BY obs_time DESC
            LIMIT 1
            """,
            (obs_type, start_iso, end_iso),
        ).fetchone()
        if row:
            return row["obs_time"]

        row = conn.execute(
            """
            SELECT obs_time
            FROM observations
            WHERE obs_type = ?
            ORDER BY obs_time DESC
            LIMIT 1
            """,
            (obs_type,),
        ).fetchone()
        return row["obs_time"] if row else None

    def _serialize_row(
        self,
        row: sqlite3.Row,
        parameter_names: list[str] | None,
    ) -> dict[str, Any]:
        payload = json.loads(row["payload_json"])

        if parameter_names:
            filtered = {name: payload.get(name) for name in parameter_names if name in payload}
        else:
            filtered = payload

        return {
            "id": row["id"],
            "obs_type": row["obs_type"],
            "obs_time": row["obs_time"],
            "platform_id": row["platform_id"],
            "lat": row["lat"],
            "lon": row["lon"],
            "elevation_m": row["elevation_m"],
            "source_name": row["source_name"],
            "data": filtered,
        }

    def _bin_serialized_rows(
        self,
        rows: list[dict[str, Any]],
        bin_minutes: int,
    ) -> list[dict[str, Any]]:
        size_seconds = int(bin_minutes) * 60
        if size_seconds <= 0:
            return []

        bins: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            dt = parse_time_like(row["obs_time"])
            if dt is None:
                continue
            epoch = int(dt.timestamp())
            bucket_epoch = (epoch // size_seconds) * size_seconds
            bucket_start = datetime.fromtimestamp(bucket_epoch, tz=timezone.utc)
            bucket_key = (to_iso_utc(bucket_start), row["obs_type"])

            if bucket_key not in bins:
                bins[bucket_key] = {
                    "bin_start": bucket_key[0],
                    "bin_end": to_iso_utc(bucket_start + timedelta(seconds=size_seconds)),
                    "obs_type": row["obs_type"],
                    "count": 0,
                    "observations": [],
                }

            bins[bucket_key]["count"] += 1
            bins[bucket_key]["observations"].append(row)

        ordered = list(bins.values())
        ordered.sort(key=lambda x: (x["bin_start"], x["obs_type"]), reverse=True)
        return ordered

    def delete_rows(
        self,
        *,
        obs_types: list[str] | None,
        source_names: list[str] | None,
        before: datetime | None,
        after: datetime | None,
    ) -> int:
        where_parts: list[str] = []
        args: list[Any] = []

        if obs_types:
            normalized = [t.upper() for t in obs_types]
            placeholders = ",".join("?" for _ in normalized)
            where_parts.append(f"obs_type IN ({placeholders})")
            args.extend(normalized)

        if source_names:
            normalized_sources = [s.strip() for s in source_names if s and s.strip()]
            if normalized_sources:
                placeholders = ",".join("?" for _ in normalized_sources)
                where_parts.append(f"source_name IN ({placeholders})")
                args.extend(normalized_sources)

        if before is not None:
            where_parts.append("obs_time <= ?")
            args.append(to_iso_utc(before))

        if after is not None:
            where_parts.append("obs_time >= ?")
            args.append(to_iso_utc(after))

        if not where_parts:
            raise ValueError("Refusing delete_rows() with no filters")

        where_sql = " AND ".join(where_parts)
        sql = f"DELETE FROM observations WHERE {where_sql}"

        with self._connect() as conn:
            before_changes = conn.total_changes
            conn.execute(sql, args)
            deleted = conn.total_changes - before_changes
        return deleted

    def prune_older_than(self, keep_days: int, obs_types: list[str] | None = None) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
        return self.delete_rows(
            obs_types=obs_types,
            source_names=None,
            before=cutoff,
            after=None,
        )

    def vacuum(self) -> None:
        with self._connect() as conn:
            conn.execute("VACUUM")
