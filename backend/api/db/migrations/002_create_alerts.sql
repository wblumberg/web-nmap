-- Migration: create alerts table for watches/warnings (alerts)
-- Run with: psql -f 002_create_alerts.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Alerts table: canonical grouping for watches/warnings
CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL NOT NULL,
  canonical_key TEXT,
  event_id TEXT,
  office TEXT,
  etn TEXT,
  phen TEXT,
  significance TEXT,
  action TEXT,
  start_utc TIMESTAMPTZ,
  end_utc TIMESTAMPTZ,
  geom GEOMETRY(MULTIPOLYGON,4326),
  counties JSONB,
  raw_message JSONB,
  source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id)
);

-- If a primary key exists that doesn't include the partitioning column,
-- TimescaleDB will reject creating the hypertable. Drop the existing
-- primary key constraint if present so we can create the hypertable.
-- Drop any UNIQUE constraint/index created by a previous `canonical_key TEXT UNIQUE` column
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_canonical_key_key;
DROP INDEX IF EXISTS alerts_canonical_key_key;

-- Also drop primary key constraint if present
ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_pkey;

-- create hypertable partitioned by start_utc for timeseries-friendly storage
SELECT create_hypertable('alerts', 'start_utc', if_not_exists => TRUE);

-- Spatial index for geometry queries
CREATE INDEX IF NOT EXISTS alerts_geom_gist ON alerts USING GIST (geom);

-- Create a composite unique index including the partitioning column
-- TimescaleDB requires any unique index to include the time partitioning column.
-- Use a non-unique index to avoid TimescaleDB primary-key/partitioning constraints
CREATE INDEX IF NOT EXISTS alerts_canonical_time_idx ON alerts (canonical_key, start_utc);

-- Range column for easier temporal containment queries
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS active_range TSTZRANGE GENERATED ALWAYS AS (tstzrange(start_utc, end_utc, '[]')) STORED;
CREATE INDEX IF NOT EXISTS alerts_active_range_gist ON alerts USING GIST (active_range);
