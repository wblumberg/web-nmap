"""Async database engine helper for TimescaleDB/PostGIS connections.

Provides a minimal async engine and session helper using SQLAlchemy async.
Configure with the `TIMESCALE_CONN` environment variable, e.g.

  postgresql+asyncpg://user:pass@host:5432/dbname

This module is intentionally small — it's a thin wrapper used by a
prototype DB-backed DataSource implementation.
"""
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncEngine


_engine: AsyncEngine | None = None


TIMESCALE_CONN='postgresql+asyncpg://webnmap:SH%40RPpyFunt1m3z@localhost:5432/wxdata'

def get_db_dsn() -> str:
    dsn = os.environ.get("TIMESCALE_CONN")
    if not dsn:
        return TIMESCALE_CONN
        #raise RuntimeError("TIMESCALE_CONN not configured")
    return dsn


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        dsn = get_db_dsn()
        _engine = create_async_engine(dsn, pool_size=10, max_overflow=20)
    return _engine
