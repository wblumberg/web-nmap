-- Initial migration: create points and geometries tables for TimescaleDB + PostGIS
-- Run this manually or via Alembic: psql -f 001_create_points.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;


-- Generic points table
-- NOTE: Timescale requires any unique constraint/index on a hypertable
-- to include the time partitioning column. Define a composite primary
-- key that includes valid_time to satisfy that requirement.
CREATE TABLE IF NOT EXISTS points (
  id BIGSERIAL NOT NULL,
  source_id TEXT NOT NULL,
  valid_time TIMESTAMPTZ NOT NULL,
  geom GEOMETRY(POINT,4326) NOT NULL,
  properties JSONB,
  cycle TIMESTAMPTZ NULL,
  fhr INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, valid_time)
);

-- Create hypertable on valid_time (chunk interval tuned later)
SELECT create_hypertable('points', 'valid_time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS points_geom_gist ON points USING GIST (geom);
CREATE INDEX IF NOT EXISTS points_source_time_idx ON points (source_id, valid_time DESC);
CREATE INDEX IF NOT EXISTS points_time_idx ON points (valid_time DESC);

-- Geometries table (watches, warnings)
CREATE TABLE IF NOT EXISTS geometries (
  id BIGSERIAL NOT NULL,
  source_id TEXT NOT NULL,
  valid_time TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  geom GEOMETRY(MULTIPOLYGON,4326) NOT NULL,
  properties JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, valid_time)
);
SELECT create_hypertable('geometries', 'valid_time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS geometries_geom_gist ON geometries USING GIST (geom);
CREATE INDEX IF NOT EXISTS geometries_source_time_idx ON geometries (source_id, valid_time DESC);
