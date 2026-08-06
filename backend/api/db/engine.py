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


def get_db_dsn() -> str:
    """Return the configured asynchronous database connection string."""
    dsn = os.environ.get("TIMESCALE_CONN")
    if not dsn:
        raise RuntimeError(
            "TIMESCALE_CONN environment variable is not set. "
            "Set it to a DSN such as: "
            "postgresql+asyncpg://user:pass@host:5432/dbname"
        )
    return dsn


def get_engine() -> AsyncEngine:
    """Return the shared SQLAlchemy asynchronous engine."""
    global _engine
    if _engine is None:
        dsn = get_db_dsn()
        _engine = create_async_engine(dsn, pool_size=10, max_overflow=20, pool_pre_ping=True)
    return _engine
