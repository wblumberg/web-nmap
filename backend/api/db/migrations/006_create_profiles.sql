-- Migration: create `profiles` hypertable for vertical profile observations.
-- Run with: psql -f 006_create_profiles.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS profiles (
  id BIGSERIAL NOT NULL,
  source_id TEXT NOT NULL,
  station_id TEXT,
  valid_time TIMESTAMPTZ NOT NULL,
  geom GEOMETRY(POINT,4326) NOT NULL,
  profile JSONB NOT NULL,
  metadata JSONB,
  cycle TIMESTAMPTZ NULL,
  fhr INT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, valid_time)
);

SELECT create_hypertable('profiles', 'valid_time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS profiles_geom_gist ON profiles USING GIST (geom);
CREATE INDEX IF NOT EXISTS profiles_source_time_idx ON profiles (source_id, valid_time DESC);
CREATE INDEX IF NOT EXISTS profiles_station_time_idx ON profiles (source_id, station_id, valid_time DESC);
