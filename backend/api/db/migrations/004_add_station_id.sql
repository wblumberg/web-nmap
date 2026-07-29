-- Migration 004: add station_id column to points table
--
-- station_id stores the human-readable station identifier (e.g. KPNC, KLGA)
-- for sources that have one.  Sources without station identifiers (e.g.
-- LIGHTNING) leave this column NULL.
--
-- Apply with:
--   psql -f 004_add_station_id.sql

ALTER TABLE points ADD COLUMN IF NOT EXISTS station_id TEXT NULL;

-- Partial index for time-series queries by station; ignores NULL rows so the
-- index stays compact for high-volume sources like LIGHTNING.
CREATE INDEX IF NOT EXISTS points_station_idx
    ON points (source_id, station_id, valid_time DESC)
    WHERE station_id IS NOT NULL;
