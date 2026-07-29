-- Migration 005: backfill station_id from the properties JSONB column
--
-- Each source stored the station identifier under a different JSONB key.
-- We extract those values into the new station_id column for all rows
-- that still have station_id IS NULL (i.e. rows inserted before migration 004).
--
-- Source mapping:
--   SAO / SHIP  → properties->>'station_id'   (MetPy ICAO field, e.g. KPNC)
--   SYNOPTIC    → properties->>'STID'          (Synoptic stid / MesoWest mid)
--   AIRNOW      → properties->>'AQSID'         (AQS site identifier)
--   LIGHTNING   → NULL (no identifier, left untouched)
--   LSR         → NULL (no identifier, left untouched)
--
-- Apply with:
--   psql -h localhost -U webnmap -d wxdata -W -f 005_backfill_station_id.sql
-- or via the Python helper used for 004.

-- SAO and SHIP
UPDATE points
SET    station_id = NULLIF(TRIM(properties->>'station_id'), '')
WHERE  source_id IN ('SAO', 'SHIP')
  AND  station_id IS NULL
  AND  properties ? 'station_id';

-- SYNOPTIC
UPDATE points
SET    station_id = NULLIF(TRIM(properties->>'STID'), '')
WHERE  source_id = 'SYNOPTIC'
  AND  station_id IS NULL
  AND  properties ? 'STID';

-- AIRNOW
UPDATE points
SET    station_id = NULLIF(TRIM(properties->>'AQSID'), '')
WHERE  source_id = 'AIRNOW'
  AND  station_id IS NULL
  AND  properties ? 'AQSID';
