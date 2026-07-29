#!/usr/bin/env python3
"""
inspect_db.py — TimescaleDB inspection CLI for WebNMAP
=======================================================

Run from the repo root (or anywhere) with:

  python backend/api/db/inspect_db.py <command> [options]

Commands
--------
  timeseries <options>               Time series for a specific station ID
  tables                          List every table with live row estimate
  schema    <table>               Column names, types, nullability, defaults
  sources                         Distinct source_ids in the points table
  points    [options]             Query the points hypertable
  alerts    [options]             Query the alerts hypertable
  geometries [options]            Query the geometries hypertable
  recent    <table>  [--limit N]  Most-recent N rows from any table
  count     <table>  [--where "…"] Row count with optional filter
  sql       "<SELECT …>"          Run any read-only SQL (SELECT / EXPLAIN / WITH)

Options for `timeseries`
------------------------
  --station STATION_ID            Station identifier to extract (required, e.g. KPNC)
  --source  SOURCE_ID             Filter by source_id (default: SAO)
  --start   "2025-01-01 00:00"    Earliest valid_time (UTC)
  --end     "2025-01-02 00:00"    Latest valid_time  (UTC)
  --props                         Expand the full properties JSONB column

Options for `points`
---------------------
  --source SOURCE_ID              Filter by source_id
  --start  "2025-01-01 00:00"     Earliest valid_time (UTC)
  --end    "2025-01-02 00:00"     Latest valid_time  (UTC)
  --bbox   "lon_min,lat_min,lon_max,lat_max"
  --limit  N                      Max rows to show (default 25)
  --props                         Expand the properties JSONB column

Options for `alerts`
---------------------
  --key        CANONICAL_KEY      Exact canonical_key match
  --office     OFFICE             CWA office (e.g. KTLX)
  --phen       PHENOMENA          2-char phenomena code (e.g. TO, SV)
  --sig        SIGNIFICANCE       Significance code (e.g. A, W)
  --action     ACTION             Action code (e.g. NEW, CON, CAN)
  --start      "2025-01-01"       Earliest start_utc
  --end        "2025-01-02"       Latest   start_utc
  --active-at  "2025-01-01 18:00" Alerts active at this instant
  --limit  N                      Max rows (default 25)

Options for `geometries`
-------------------------
  --source SOURCE_ID
  --start / --end
  --limit  N

Environment
-----------
  TIMESCALE_CONN   Override default DSN.
  
  # Examples
    python backend/api/db/inspect_db.py tables
    python backend/api/db/inspect_db.py schema alerts
    python backend/api/db/inspect_db.py sources
    python backend/api/db/inspect_db.py keys --source SHIP
    python backend/api/db/inspect_db.py keys --source AIRNOW --sample-rows 500
    python backend/api/db/inspect_db.py points --source LIGHTNING --limit 10
    python backend/api/db/inspect_db.py timeseries --station KPNC --source SAO
    python backend/api/db/inspect_db.py timeseries --station KPNC --source SAO --start "2026-04-22" --props
    python backend/api/db/inspect_db.py points --source AIRNOW --start "2026-04-07" --bbox "-100,25,-80,40"
    python backend/api/db/inspect_db.py alerts --phen SV --sig W --limit 20
    python backend/api/db/inspect_db.py alerts --active-at "2026-04-07 18:00"
    python backend/api/db/inspect_db.py recent points --limit 5
    python backend/api/db/inspect_db.py count points --where "source_id = 'LIGHTNING'"
    python backend/api/db/inspect_db.py sql "SELECT source_id, COUNT(*) FROM points GROUP BY source_id"
  
"""

import argparse
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timezone
from textwrap import shorten

import asyncpg
from dateutil import parser as _dtparser
from rich.console import Console
from rich.table import Table
from rich import box

# ── Datetime parsing ─────────────────────────────────────────────────────────

def _parse_dt(s: str) -> datetime:
    """Parse a flexible datetime string and return a timezone-aware datetime (UTC)."""
    dt = _dtparser.parse(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ── Connection ────────────────────────────────────────────────────────────────

_DEFAULT_DSN = "postgresql://webnmap:SH%40RPpyFunt1m3z@localhost:5432/wxdata"

# asyncpg uses the plain postgresql:// scheme (not +asyncpg)
def _get_dsn() -> str:
    raw = os.environ.get("TIMESCALE_CONN", _DEFAULT_DSN)
    return raw.replace("postgresql+asyncpg://", "postgresql://")


async def _connect() -> asyncpg.Connection:
    return await asyncpg.connect(_get_dsn())


# ── Display helpers ───────────────────────────────────────────────────────────

console = Console()


def _fmt_val(v) -> str:
    """Format a single cell value for display."""
    if v is None:
        return "[dim]NULL[/dim]"
    if isinstance(v, dict):
        s = json.dumps(v, default=str)
        return shorten(s, width=80, placeholder="…")
    if isinstance(v, str) and len(v) > 100:
        return v[:97] + "…"
    if isinstance(v, (bytes, bytearray)):
        return f"<binary {len(v)} bytes>"
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M:%S UTC")
    return str(v)


def _print_rows(rows: list, title: str = "") -> None:
    """Render a list of asyncpg Record objects as a Rich table."""
    if not rows:
        console.print(f"[yellow]No rows returned.[/yellow]")
        return

    tbl = Table(title=title, box=box.SIMPLE_HEAVY, show_lines=False,
                header_style="bold cyan")
    for col in rows[0].keys():
        tbl.add_column(col, overflow="fold", no_wrap=False)

    for row in rows:
        tbl.add_row(*[_fmt_val(row[k]) for k in row.keys()])

    console.print(tbl)
    console.print(f"[dim]{len(rows)} row(s)[/dim]")


# ── Subcommand handlers ───────────────────────────────────────────────────────

async def cmd_tables(_args) -> None:
    """List tables with estimated row counts."""
    conn = await _connect()
    try:
        rows = await conn.fetch("""
            SELECT
                n.nspname                                AS schema,
                c.relname                                AS table,
                pg_size_pretty(pg_table_size(c.oid))    AS table_size,
                c.reltuples::bigint                      AS row_estimate
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r'
              AND n.nspname NOT IN ('pg_catalog', 'information_schema',
                                    '_timescaledb_catalog', '_timescaledb_internal',
                                    '_timescaledb_config', '_timescaledb_cache')
            ORDER BY n.nspname, c.relname;
        """)
    finally:
        await conn.close()
    _print_rows(rows, title="Tables")


async def cmd_schema(args) -> None:
    """Show column-level details for a table."""
    table = args.table
    conn = await _connect()
    try:
        rows = await conn.fetch("""
            SELECT
                ordinal_position  AS "#",
                column_name       AS column,
                data_type         AS type,
                udt_name          AS udt,
                character_maximum_length AS max_len,
                is_nullable       AS nullable,
                column_default    AS default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name   = $1
            ORDER BY ordinal_position;
        """, table)
    finally:
        await conn.close()
    if not rows:
        console.print(f"[red]Table '{table}' not found in schema 'public'.[/red]")
        return
    _print_rows(rows, title=f"Schema: {table}")


async def cmd_sources(_args) -> None:
    """List distinct source_ids present in the points table."""
    conn = await _connect()
    try:
        rows = await conn.fetch("""
            SELECT
                source_id,
                COUNT(*)                       AS total_points,
                MIN(valid_time)                AS earliest,
                MAX(valid_time)                AS latest
            FROM points
            GROUP BY source_id
            ORDER BY source_id;
        """)
    finally:
        await conn.close()
    _print_rows(rows, title="point sources")


async def cmd_points(args) -> None:
    """Query the points hypertable."""
    conditions = []
    params: list = []

    def _add(expr: str, val):
        params.append(val)
        conditions.append(expr.replace("?", f"${len(params)}"))

    if args.source:
        _add("source_id = ?", args.source)
    if getattr(args, 'station', None):
        _add("station_id = ?", args.station)
    if args.start:
        _add("valid_time >= ?", _parse_dt(args.start))
    if args.end:
        _add("valid_time <= ?", _parse_dt(args.end))
    if args.bbox:
        try:
            lon_min, lat_min, lon_max, lat_max = [float(x) for x in args.bbox.split(",")]
        except ValueError:
            console.print("[red]--bbox must be lon_min,lat_min,lon_max,lat_max[/red]")
            return
        _add(
            "ST_Within(geom, ST_MakeEnvelope(?, ?, ?, ?, 4326))",
            (lon_min, lat_min, lon_max, lat_max),
        )
        # asyncpg doesn't accept a tuple; expand to 4 separate params
        params.pop()
        n = len(params)
        conditions[-1] = (
            f"ST_Within(geom, ST_MakeEnvelope(${n+1}, ${n+2}, ${n+3}, ${n+4}, 4326))"
        )
        params += [lon_min, lat_min, lon_max, lat_max]

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    props_col = "properties" if args.props else "LEFT(properties::text, 200) AS properties"

    sql = f"""
        SELECT
            id,
            source_id,
            station_id,
            valid_time,
            ST_Y(geom) AS lat,
            ST_X(geom) AS lon,
            {props_col},
            cycle,
            fhr
        FROM points
        {where}
        ORDER BY valid_time DESC
        LIMIT {int(args.limit)};
    """

    conn = await _connect()
    try:
        rows = await conn.fetch(sql, *params)
    finally:
        await conn.close()
    _print_rows(rows, title=f"points — {args.source or 'all sources'}")


async def cmd_alerts(args) -> None:
    """Query the alerts hypertable."""
    conditions = []
    params: list = []

    def _p(val):
        params.append(val)
        return f"${len(params)}"

    if args.key:
        conditions.append(f"canonical_key = {_p(args.key)}")
    if args.office:
        conditions.append(f"office = {_p(args.office.upper())}")
    if args.phen:
        conditions.append(f"phen = {_p(args.phen.upper())}")
    if args.sig:
        conditions.append(f"significance = {_p(args.sig.upper())}")
    if args.action:
        conditions.append(f"action = {_p(args.action.upper())}")
    if args.start:
        conditions.append(f"start_utc >= {_p(_parse_dt(args.start))}")
    if args.end:
        conditions.append(f"start_utc <= {_p(_parse_dt(args.end))}")
    if args.active_at:
        # asyncpg infers the $N type from the @> operator on a tstzrange column
        # and expects a Range object, not a datetime.  Rewrite as plain
        # timestamp bounds so asyncpg sees straightforward timestamptz params.
        at = _parse_dt(args.active_at)
        conditions.append(f"start_utc <= {_p(at)} AND (end_utc IS NULL OR end_utc >= {_p(at)})")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sql = f"""
        SELECT
            id,
            canonical_key,
            office,
            phen,
            significance,
            action,
            start_utc,
            end_utc,
            source,
            updated_at
        FROM alerts
        {where}
        ORDER BY start_utc DESC
        LIMIT {int(args.limit)};
    """

    conn = await _connect()
    try:
        rows = await conn.fetch(sql, *params)
    finally:
        await conn.close()
    _print_rows(rows, title="alerts")


async def cmd_timeseries(args) -> None:
    """Extract a time-ordered observation record for a single station."""
    conditions: list[str] = []
    params: list = []

    def _p(val) -> str:
        params.append(val)
        return f"${len(params)}"

    conditions.append(f"station_id = {_p(args.station)}")
    if args.source:
        conditions.append(f"source_id = {_p(args.source)}")
    if args.start:
        conditions.append(f"valid_time >= {_p(_parse_dt(args.start))}")
    if args.end:
        conditions.append(f"valid_time <= {_p(_parse_dt(args.end))}")

    where = "WHERE " + " AND ".join(conditions)

    # Build the SELECT list for properties.
    # --fields key1,key2,...  → one column per key, cast to text
    # --props                 → full JSONB blob
    # (default)               → truncated blob
    fields = [f.strip() for f in args.fields.split(",") if f.strip()] \
             if getattr(args, 'fields', None) else []

    if fields:
        # Each field becomes a separate column: properties->>'key' AS key
        field_cols = ",\n            ".join(
            # Use double-dollar quoting to safely embed arbitrary key names
            f"properties->>'{f}' AS \"{f}\"" for f in fields
        )
        props_sql = field_cols
    elif getattr(args, 'props', False):
        props_sql = "properties"
    else:
        props_sql = "LEFT(properties::text, 200) AS properties"

    sql = f"""
        SELECT
            valid_time,
            source_id,
            station_id,
            ST_Y(geom) AS lat,
            ST_X(geom) AS lon,
            {props_sql}
        FROM points
        {where}
        ORDER BY valid_time ASC
        LIMIT {int(getattr(args, 'limit', 500))};
    """

    conn = await _connect()
    try:
        rows = await conn.fetch(sql, *params)
    finally:
        await conn.close()
    _print_rows(rows, title=f"time series — {args.station} ({args.source or 'all sources'})")


async def cmd_geometries(args) -> None:
    """Query the geometries hypertable."""
    conditions = []
    params: list = []

    def _p(val):
        params.append(val)
        return f"${len(params)}"

    if args.source:
        conditions.append(f"source_id = {_p(args.source)}")
    if args.start:
        conditions.append(f"valid_time >= {_p(_parse_dt(args.start))}")
    if args.end:
        conditions.append(f"valid_time <= {_p(_parse_dt(args.end))}")

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    sql = f"""
        SELECT
            id,
            source_id,
            valid_time,
            expires_at,
            ST_GeometryType(geom)    AS geom_type,
            ST_NPoints(geom)         AS n_points,
            LEFT(properties::text, 80) AS properties,
            created_at
        FROM geometries
        {where}
        ORDER BY valid_time DESC
        LIMIT {int(args.limit)};
    """

    conn = await _connect()
    try:
        rows = await conn.fetch(sql, *params)
    finally:
        await conn.close()
    _print_rows(rows, title=f"geometries — {args.source or 'all sources'}")


async def cmd_keys(args) -> None:
    """Show all distinct property keys for a source, with occurrence counts and a sample value."""
    source = args.source
    sample = int(args.sample_rows)

    # Use a CTE to sample rows, then unnest jsonb_object_keys to get key-level stats.
    # For each key we count how many rows carry it (rows_with_key), how many of those
    # have a non-null value (non_null_count), and pull one sample value so you can
    # see what the data actually looks like.
    sql = f"""
        WITH sampled AS (
            SELECT properties
            FROM   points
            WHERE  source_id = $1
            ORDER  BY valid_time DESC
            LIMIT  {sample}
        ),
        keys AS (
            SELECT key,
                   COUNT(*)                                              AS rows_with_key,
                   COUNT(*) FILTER (WHERE (s.properties->>key) IS NOT NULL
                                      AND  s.properties->>key <> 'null') AS non_null_count
            FROM   sampled s,
                   jsonb_object_keys(s.properties) AS key
            GROUP  BY key
        )
        SELECT k.key,
               k.rows_with_key,
               k.non_null_count,
               round(k.non_null_count * 100.0 / NULLIF(k.rows_with_key, 0), 1) AS pct_non_null,
               (SELECT s.properties->>k.key
                FROM   sampled s
                WHERE  s.properties->>k.key IS NOT NULL
                  AND  s.properties->>k.key <> 'null'
                LIMIT  1) AS sample_value
        FROM   keys k
        ORDER  BY k.non_null_count DESC, k.key;
    """

    conn = await _connect()
    try:
        rows = await conn.fetch(sql, source)
    finally:
        await conn.close()
    _print_rows(rows, title=f"property keys — {source} (sampled {sample} rows)")


async def cmd_recent(args) -> None:
    """Show the most recent N rows from any table."""
    table = args.table
    # Discover the best time column
    conn = await _connect()
    try:
        time_cols = await conn.fetch("""
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name   = $1
              AND data_type IN ('timestamp with time zone',
                                'timestamp without time zone')
            ORDER BY ordinal_position;
        """, table)

        if not time_cols:
            console.print(f"[red]No timestamp column found in '{table}'.[/red]")
            return

        time_col = time_cols[0]["column_name"]
        rows = await conn.fetch(
            f"SELECT * FROM {table} ORDER BY {time_col} DESC LIMIT $1;",
            int(args.limit),
        )
    finally:
        await conn.close()
    _print_rows(rows, title=f"{table} — {args.limit} most recent (by {time_col})")


async def cmd_count(args) -> None:
    """Count rows, with optional WHERE clause."""
    table = args.table
    where = f"WHERE {args.where}" if args.where else ""
    sql = f"SELECT COUNT(*) AS row_count FROM {table} {where};"

    conn = await _connect()
    try:
        # Validate it's really just a WHERE expression (no subquery injection)
        rows = await conn.fetch(sql)
    except asyncpg.PostgresError as e:
        console.print(f"[red]Query error: {e}[/red]")
        return
    finally:
        await conn.close()
    _print_rows(rows, title=f"count({table})")


_SAFE_SQL_RE = re.compile(
    r"^\s*(select|explain|with|show)\b",
    re.IGNORECASE,
)


async def cmd_sql(args) -> None:
    """Run an arbitrary read-only SQL statement."""
    query = args.query
    if not _SAFE_SQL_RE.match(query):
        console.print(
            "[red]Only SELECT / EXPLAIN / WITH / SHOW statements are allowed.[/red]"
        )
        return

    conn = await _connect()
    try:
        # Enforce read-only transaction
        await conn.execute("SET TRANSACTION READ ONLY;")
        rows = await conn.fetch(query)
    except asyncpg.PostgresError as e:
        console.print(f"[red]Query error: {e}[/red]")
        return
    finally:
        await conn.close()
    _print_rows(rows, title="custom SQL")


# ── CLI wiring ────────────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="inspect_db.py",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="command", required=True)

    # tables
    sub.add_parser("tables", help="List all tables with row estimates")

    # schema
    s = sub.add_parser("schema", help="Show column info for a table")
    s.add_argument("table", help="Table name (e.g. points, alerts, geometries)")

    # sources
    sub.add_parser("sources", help="Distinct source_ids in the points table")

    # points
    pts = sub.add_parser("points", help="Query the points hypertable")
    pts.add_argument("--source", default=None, help="Filter by source_id")
    pts.add_argument("--station", default=None, help="Filter by station_id (e.g. KPNC)")
    pts.add_argument("--start",  default=None, help="Earliest valid_time (UTC)")
    pts.add_argument("--end",    default=None, help="Latest   valid_time (UTC)")
    pts.add_argument("--bbox",   default=None, help="lon_min,lat_min,lon_max,lat_max")
    pts.add_argument("--limit",  default=25,   type=int, help="Max rows (default 25)")
    pts.add_argument("--props",  action="store_true",
                     help="Show full properties JSONB (may be wide)")

    # alerts
    alt = sub.add_parser("alerts", help="Query the alerts hypertable")
    alt.add_argument("--key",       default=None, help="Exact canonical_key")
    alt.add_argument("--office",    default=None, help="CWA office (e.g. KTLX)")
    alt.add_argument("--phen",      default=None, help="Phenomena code (e.g. TO, SV)")
    alt.add_argument("--sig",       default=None, help="Significance (A/W/Y/…)")
    alt.add_argument("--action",    default=None, help="Action code (NEW/CON/CAN/…)")
    alt.add_argument("--start",     default=None, help="Earliest start_utc")
    alt.add_argument("--end",       default=None, help="Latest   start_utc")
    alt.add_argument("--active-at", default=None, dest="active_at",
                     help="Alerts active at this timestamp")
    alt.add_argument("--limit",     default=25,   type=int)

    # geometries
    geo = sub.add_parser("geometries", help="Query the geometries hypertable")
    geo.add_argument("--source", default=None)
    geo.add_argument("--start",  default=None)
    geo.add_argument("--end",    default=None)
    geo.add_argument("--limit",  default=25,  type=int)

    # keys
    kys = sub.add_parser("keys", help="List all property keys for a source with occurrence counts")
    kys.add_argument("--source", required=True, help="source_id to inspect (e.g. SHIP, AIRNOW)")
    kys.add_argument("--sample-rows", default=1000, type=int,
                     help="Number of most-recent rows to sample (default 1000)")

    # timeseries
    ts = sub.add_parser("timeseries", help="Time series for a specific station ID")
    ts.add_argument("--station", required=True, help="Station identifier (e.g. KPNC, KLGA)")
    ts.add_argument("--source",  default=None,  help="Filter by source_id (e.g. SAO, SHIP)")
    ts.add_argument("--start",   default=None,  help="Earliest valid_time (UTC)")
    ts.add_argument("--end",     default=None,  help="Latest   valid_time (UTC)")
    ts.add_argument("--props",   action="store_true",
                    help="Show full properties JSONB (may be wide)")
    ts.add_argument("--fields",  default=None,
                    help="Comma-separated JSONB keys to extract as columns, e.g. 'drct,sknt,tmpc'")
    ts.add_argument("--limit",   default=500,   type=int, help="Max rows (default 500)")

    # recent
    rec = sub.add_parser("recent", help="Most-recent N rows from any table")
    rec.add_argument("table", help="Table name")
    rec.add_argument("--limit", default=10, type=int, help="Rows to show (default 10)")

    # count
    cnt = sub.add_parser("count", help="Count rows in a table")
    cnt.add_argument("table", help="Table name")
    cnt.add_argument("--where", default=None,
                     help="Optional WHERE expression, e.g. \"source_id = 'LIGHTNING'\"")

    # sql
    sql_ = sub.add_parser("sql", help="Run a read-only SQL statement")
    sql_.add_argument("query", help="SQL query string (must start with SELECT/EXPLAIN/WITH/SHOW)")

    return p


_HANDLERS = {
    "tables":     cmd_tables,
    "schema":     cmd_schema,
    "sources":    cmd_sources,
    "points":     cmd_points,
    "timeseries": cmd_timeseries,
    "alerts":     cmd_alerts,
    "geometries": cmd_geometries,
    "keys":       cmd_keys,
    "recent":     cmd_recent,
    "count":      cmd_count,
    "sql":        cmd_sql,
}


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    handler = _HANDLERS.get(args.command)
    if handler is None:
        parser.print_help()
        sys.exit(1)

    try:
        asyncio.run(handler(args))
    except asyncpg.InvalidPasswordError:
        console.print("[red]Authentication failed — check TIMESCALE_CONN credentials.[/red]")
        sys.exit(1)
    except (asyncpg.CannotConnectNowError, OSError) as e:
        console.print(f"[red]Cannot connect to database: {e}[/red]")
        sys.exit(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
