-- Migration: data retention and compression policies for all hypertables
-- Requires TimescaleDB >= 2.4.0 (for if_not_exists on policy functions)
-- Run with: psql $TIMESCALE_CONN -f 003_retention_policies.sql

-- ─────────────────────────────────────────────────────────────────────────────
-- 1.  Compression
--
--     We compress only points and geometries — both are high-volume tables
--     whose GIST indexes are on the unpartitioned column (geom), so they
--     remain usable on uncompressed (recent) chunks.
--
--     alerts is intentionally excluded: the active_range GIST index supports
--     temporal containment queries and would not be maintained on compressed
--     chunks.
-- ─────────────────────────────────────────────────────────────────────────────

-- points: segment by source_id so a query filtered on a single source only
--         decompresses the relevant segments.
ALTER TABLE points SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'source_id',
    timescaledb.compress_orderby   = 'valid_time DESC'
);
SELECT add_compression_policy('points',     INTERVAL '7 days',  if_not_exists => TRUE);

-- geometries: watches/warnings have similar access patterns.
ALTER TABLE geometries SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'source_id',
    timescaledb.compress_orderby   = 'valid_time DESC'
);
SELECT add_compression_policy('geometries', INTERVAL '3 days',  if_not_exists => TRUE);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2.  Table-level retention policies
--
--     These drop entire time-range chunks once all data in a chunk is older
--     than the configured interval.  Setting the interval to a multiple of
--     the chunk size (default 7 days) minimises the "grace period" between
--     the nominal retention window and actual deletion.
-- ─────────────────────────────────────────────────────────────────────────────

-- points: 90 days covers the longest-lived sources (AIRNOW, SAO, SYNOPTIC, SHIP).
SELECT add_retention_policy('points',     INTERVAL '90 days', if_not_exists => TRUE);

-- geometries: watches/warnings have no operational value beyond ~30 days.
SELECT add_retention_policy('geometries', INTERVAL '30 days', if_not_exists => TRUE);

-- alerts: 30 days provides a rolling seasonal window for NWS alert history.
SELECT add_retention_policy('alerts',     INTERVAL '30 days', if_not_exists => TRUE);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3.  Per-source fine-grained cleanup within the points table
--
--     add_retention_policy drops whole chunks regardless of source_id, so the
--     effective retention for all sources is the table-wide maximum (90 days).
--     High-volume, short-lived sources need earlier row-level pruning to keep
--     disk usage and query latency in check.
--
--     Retention windows by source:
--       LIGHTNING  — 14 days  (very high volume, radar-era data supersedes it)
--       LSR        — 30 days  (local storm reports, short operational window)
--       AIRNOW     — 90 days  (covered by the table-level policy)  
--       SAO        — 90 days
--       SHIP       — 90 days
--       SYNOPTIC   — 90 days
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prune_points_by_source()
    RETURNS void
    LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM points
    WHERE  source_id = 'LIGHTNING'
      AND  valid_time < now() - INTERVAL '14 days';

    DELETE FROM points
    WHERE  source_id = 'LSR'
      AND  valid_time < now() - INTERVAL '30 days';
END;
$$;

-- Register the function as an hourly TimescaleDB background job.
-- The DO block makes this idempotent — re-running the migration will not
-- register a duplicate job.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   timescaledb_information.jobs
        WHERE  proc_schema = current_schema()
          AND  proc_name   = 'prune_points_by_source'
    ) THEN
        PERFORM add_job('prune_points_by_source', INTERVAL '1 hour');
    END IF;
END;
$$;
