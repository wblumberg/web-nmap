-- Preserve FAA NAS reported-altitude suffixes and backfill the numeric level
-- from retained raw SWIM messages. Values are in hundreds of feet. A T suffix
-- denotes an interim altitude and is retained but intentionally not plotted as
-- an ordinary reported/beacon altitude.
ALTER TABLE aircraft_positions
  ADD COLUMN IF NOT EXISTS altitude_suffix TEXT;

WITH parsed AS (
  SELECT
    flight_ref,
    observation_time,
    COALESCE(
      raw_message #>>
        '{fdm:trackInformation,nxcm:reportedAltitude,nxce:simpleAltitude}',
      raw_message #>>
        '{fdm:trackInformation,nxcm:reportedAltitude,nxce:assignedAltitude,nxce:simpleAltitude}'
    ) AS raw_altitude
  FROM aircraft_positions
  WHERE altitude_ft IS NULL
    AND altitude_suffix IS NULL
), valid AS (
  SELECT
    flight_ref,
    observation_time,
    raw_altitude,
    substring(upper(raw_altitude) FROM '([BCT])$') AS suffix
  FROM parsed
  WHERE upper(raw_altitude) ~ '^[+-]?[0-9]+(\.[0-9]+)?[BCT]?$'
)
UPDATE aircraft_positions AS position
SET
  altitude_suffix = valid.suffix,
  altitude_ft = CASE
    WHEN valid.suffix = 'T' THEN NULL
    ELSE round(
      regexp_replace(upper(valid.raw_altitude), '[BCT]$', '')::numeric * 100
    )::integer
  END
FROM valid
WHERE position.flight_ref = valid.flight_ref
  AND position.observation_time = valid.observation_time;

ALTER TABLE aircraft_positions
  DROP CONSTRAINT IF EXISTS aircraft_positions_altitude_suffix_check;
ALTER TABLE aircraft_positions
  ADD CONSTRAINT aircraft_positions_altitude_suffix_check
  CHECK (altitude_suffix IN ('B', 'C', 'T'));
