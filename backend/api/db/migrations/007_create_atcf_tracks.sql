-- Migration: create `atcf_tracks` hypertable for cyclone forecast track points.
-- Run with: psql -f 007_create_atcf_tracks.sql

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS atcf_tracks (
  id BIGSERIAL NOT NULL,
  source_id TEXT NOT NULL,
  cycle_time TIMESTAMPTZ NOT NULL,
  valid_time TIMESTAMPTZ NOT NULL,
  fhr INT NOT NULL,
  basin TEXT,
  storm_id TEXT,
  storm_name TEXT,
  model TEXT,
  advisory_num INT,
  max_wind_kt INT,
  min_pressure_mb INT,
  geom GEOMETRY(POINT,4326) NOT NULL,
  raw_record JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, valid_time)
);

SELECT create_hypertable('atcf_tracks', 'valid_time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS atcf_tracks_geom_gist ON atcf_tracks USING GIST (geom);
CREATE INDEX IF NOT EXISTS atcf_tracks_source_cycle_idx ON atcf_tracks (source_id, cycle_time DESC);
CREATE INDEX IF NOT EXISTS atcf_tracks_storm_model_idx ON atcf_tracks (source_id, storm_id, basin, model, cycle_time DESC);
CREATE INDEX IF NOT EXISTS atcf_tracks_fhr_idx ON atcf_tracks (source_id, cycle_time DESC, fhr);
