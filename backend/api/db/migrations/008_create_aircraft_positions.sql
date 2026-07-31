-- FAA SWIM/ASDI aircraft position history.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS aircraft_positions (
  observation_time  TIMESTAMPTZ NOT NULL,
  flight_ref        TEXT NOT NULL,
  acid              TEXT,
  departure_airport TEXT,
  arrival_airport   TEXT,
  altitude_ft       INTEGER,
  ground_speed_kt   REAL,
  geom              GEOMETRY(POINT, 4326) NOT NULL,
  message_type      TEXT,
  source_timestamp  TIMESTAMPTZ,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_message       JSONB,
  PRIMARY KEY (flight_ref, observation_time)
);

SELECT create_hypertable(
  'aircraft_positions', 'observation_time',
  chunk_time_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS aircraft_positions_geom_gist
  ON aircraft_positions USING GIST (geom);
CREATE INDEX IF NOT EXISTS aircraft_positions_flight_time_idx
  ON aircraft_positions (flight_ref, observation_time DESC);
CREATE INDEX IF NOT EXISTS aircraft_positions_departure_time_idx
  ON aircraft_positions (departure_airport, observation_time DESC);
CREATE INDEX IF NOT EXISTS aircraft_positions_arrival_time_idx
  ON aircraft_positions (arrival_airport, observation_time DESC);

ALTER TABLE aircraft_positions SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'flight_ref',
  timescaledb.compress_orderby = 'observation_time DESC'
);
SELECT add_compression_policy(
  'aircraft_positions', INTERVAL '6 hours', if_not_exists => TRUE
);
SELECT add_retention_policy(
  'aircraft_positions', INTERVAL '24 hours', if_not_exists => TRUE
);
