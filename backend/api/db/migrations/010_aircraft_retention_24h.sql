-- Change an existing FAA aircraft installation from 72-hour to 24-hour
-- retention. TimescaleDB permits only one retention policy per hypertable.
SELECT set_chunk_time_interval('aircraft_positions', INTERVAL '1 hour');

SELECT remove_retention_policy('aircraft_positions', if_exists => TRUE);
SELECT add_retention_policy(
  'aircraft_positions', INTERVAL '24 hours', if_not_exists => TRUE
);

-- The new chunk interval applies only to chunks created from this point
-- forward. Prune old rows once so a pre-existing large chunk does not retain
-- historical aircraft data until that entire chunk becomes droppable.
DELETE FROM aircraft_positions
WHERE observation_time < now() - INTERVAL '24 hours';
