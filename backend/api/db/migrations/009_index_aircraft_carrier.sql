-- Accelerate filtering aircraft callsigns by three-letter ICAO carrier code.
CREATE INDEX IF NOT EXISTS aircraft_positions_carrier_time_idx
  ON aircraft_positions ((left(upper(acid), 3)), observation_time DESC)
  WHERE acid IS NOT NULL;
