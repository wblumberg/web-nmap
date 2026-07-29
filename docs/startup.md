# Forward frontend
ssh -L 5173:localhost:5173 meso
# Run frontend
cd frontend/
npm run dev

# Forward backend
ssh -L 8000:localhost:8000 meso
# Run backend
cd web-nmap/
uvicorn backend.api.main:app --reload --host 0.0.0.0 --port 8000


# Observation SQL store (new)

## Initialize DB schema
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	init

## Ingest METAR-like JSON observations
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	ingest \
	--obs-type METAR \
	--format json \
	--input backend/data/metar/surface_20260301_1800.json

## Ingest lightning text observations
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	ingest \
	--obs-type LIGHTNING \
	--format lightning_txt \
	--input /data/base/lightning/acad.2026.03.01.18.00.txt

## Ingest GEMPAK Surface/Ship observations directly
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	ingest \
	--obs-type SHIP \
	--format gempak_surface \
	--gempak-country US \
	--gempak-date-time 202603162000 \
	--input /data/store/point/ship/20260316_ship.sfc

## Ingest precomputed sfjson exported from GempakSurface.sfjson()
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	ingest \
	--obs-type METAR \
	--format gempak_sfjson \
	--assume-time 20260316_2000 \
	--input /data/store/point/metar/metar_20260316_2000.sfjson

## List unique times in SQL DB
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	list-times \
	--obs-types METAR,LIGHTNING

## Query latest snapshot per type (CLI)
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	query \
	--obs-types METAR,SHIP,RECON,LIGHTNING,AIR_QUALITY \
	--center 20260301_1800 \
	--minutes-before 30 \
	--minutes-after 30 \
	--latest-only

## Prune old rows to keep DB size manageable
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	prune \
	--keep-days 14

## Undo an accidental ingest batch (targeted delete)
python backend/processing/obs2sql.py \
	--db backend/data/observations.sqlite \
	delete \
	--obs-types METAR \
	--source-names wrong_batch

## CRON pattern (example: every 5 minutes for latest lightning file)
*/5 * * * * cd /home/gblumberg/code/web-nmap && /home/gblumberg/conda-env/nmap_api/bin/python backend/processing/obs2sql.py --db /data/store/point/observations.sqlite ingest --obs-type LTNG --format lightning_txt --input /data/base/lightning/acad.$(date -u +\%Y.\%m.\%d.\%H.\%M).txt >> /data/store/logs/obs2sql_ltng.log 2>&1


# SQL observation API endpoints

- GET /api/v1/observations/sql/times?obs_types=METAR,SHIP
- GET /api/v1/observations/sql/query?obs_types=METAR,SHIP&center=20260301_1800&minutes_before=30&minutes_after=30
- GET /api/v1/observations/sql/query?obs_types=METAR,LIGHTNING&latest_only=true&prefer_most_data=true
- GET /api/v1/observations/sql/query?obs_types=METAR&center=20260301_1800&minutes_before=180&bin_minutes=15

Both SQL endpoints now include timing diagnostics:
- JSON: `metadata.timing` (parse, SQL, response-build, total in milliseconds)
- Header: `Server-Timing` with the same stage timings


# Optional env var

Set `WEBNMAP_OBS_DB` to point the API to a non-default SQLite file.


# GRIB2 to Zarr conversion

Convert one GRIB2 file to one chunked Zarr store:

python backend/processing/grib2_to_zarr.py \
	--input /data/store/grid/rap/rap.t12z.wrfprsf00.grib2 \
	--output /data/store/grid/rap_zarr/rap.t12z.wrfprsf00.zarr \
	--overwrite

Convert a directory of GRIB2 files into Zarr stores:

python backend/processing/grib2_to_zarr.py \
	--input /data/store/grid/rap \
	--output /data/store/grid/rap_zarr \
	--pattern "*.grib2,*.grb2,*.grib,*.grb" \
	--recursive \
	--chunk-y 256 \
	--chunk-x 256 \
	--compressor zstd \
	--compression-level 5 \
	--overwrite

Each message is read one-by-one via `grib2io`, and each written variable stores metadata including vertical level, valid time, forecast hour, units, and GRIB identification fields in Zarr attrs.

