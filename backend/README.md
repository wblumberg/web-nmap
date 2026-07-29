# Web-NMAP Backend README

To start the API backend, use the following command and run it from the root of the web-nmap repository directory:

`uvicorn backend.api.main:app --reload --port 8000 --workers 2`

The port specifies the port the API will be accessible from, and the number of workers will help enable more connections to the API.

# Backend Infrastructure

Currently, the backend serves data from two primary data structures:

- Zarr v2 (v3 is not supported due to it not being adopted widely)
- A TimescaleDB with PostGIS 

These two data structures are useful for serving various data sets to the frontend rapidly.

## How the backend works and interacts with the frontend:

The backend for this application uses the FastAPI framework.

The following roles for this backend are:

- Providing the frontend a data source catalog and any metadata corresponding to those data (e.g., MRMS, GOES-E, ECMWF, HREF, Surface Obs, Upper air obs).
- Providing the frontend with information about the frames/times available for a specific data source (valid times) to be displayed in the timeline.
- Providing the frontend with information about how many frames/times to show in the timeline by default.
- Providing the frontend with information about how many frames/times should be selected by default for this data source.
- Watching the data directories for new datasets that arrive that the frontend should know about (e.g., auto-updating loops).
- Sending the frontend information about how to configure the AutumnPlot-GL grids for a specific data source (e.g., LambertGrid, Geostationary, PlateCarree, UnstructuredGrid)

- Sending the frontend data to be visualized.  For example:
    - Forecast Grids (e.g., mean 2-m dewpoint temperature, paintball plots, forecast precip types.)
    - Analysis Grids (e.g., surface objective analysis, mesoanalysis grids, etc.)
    - Raster Imagery (e.g., MRMS, GOES-E)
    - Point Data (e.g., surface observations, lightning strikes, upper air observations, local storm reports).
    - Geometric Data (e.g., watch outlines, storm-based warnings, outlooks)
        - Forecast tracks of cyclones (e.g., ECMWF ensemble cyclone tracks, ATCF grids, etc.)
        - Individual contours for spaghetti-type plots from ensemble numerical weather prediction.

To optimize the sending of data, we will rely primarily on binary formats, like the ProtocolBuffer format.  The scripts in this repository are there to act as the intermediary between the frontend and the different datasets that exist on disk.

The various dataProduct scripts in the frontend specify the variables we will need to get from the backend for a specific data source.

## How the directories are structured:

The directories here are structure as such:
- `api/` contains the FastAPI framework and their respective Python files.
- `assets/` contains some mapping assets to help support the backend (e.g., county outlines)
- `data/` currently has some temporary datasets (will be deleted at some point)
- `processing/` has some processing scripts to help create datasets that will be available via the backend (these will be moved).

Here's some information on the structure of the Web-NMAP backend:

```
|-- db/                                     <-- Tools for managing the TimescaleDB
|   |-- engine.py                           <-- Functions to connect to the TimescaleDB via Python
|   |-- inspect_db.py                       <-- CLI to inspect the database (for debugging insertions)
|   |-- migrations/                         <-- Scripts to make incremental changes to the database schemas.
|   |   |-- 001_create_points.sql
|   |   |-- 002_create_alerts.sql
|   |   |-- 003_retention_policies.sql
|   |   |-- 004_add_station_id.sql
|   |   |-- 005_backfill_station_id.sql
|   |   |-- 006_create_profiles.sql
|   |   `-- 007_create_atcf_tracks.sql
|   |-- README.md
|   `-- Untitled.ipynb
|
|-- ingest/                                 <-- Scripts to help ingest Wx data to the TimescaleDB
|   |-- a-deck.example                      <-- Example A-Deck from ATCF to guide its ingest into the TimescaleDB
|   |-- airnow_ingest.py                    <-- Ingest Hourly AirNow Observations
|   |-- alerts/
|   |   |-- access_sqp
|   |   |-- cap_parser.py                   <-- Parsing the NWS CAP Feed VTEC strings, etc.
|   |   |-- contact_api.ipynb               <-- Testing contacting the API for alert geometries
|   |   |-- counties.py                     <-- County shapefile helper (to help union counties listed in alert)
|   |   |-- ingest.py                       <-- Helpers to insert alert into TimescaleDB/PostGRES
|   |   |-- run_ingest.py                   <-- Ingest current NWS Alerts (Advisory, Watch, Warnings) into TimescaleDB
|   |   `-- weather_alerts.json             <-- Example alerts JSON response from NWS CAP Service
|   |-- atcf_db_ingest.py                   <-- Ingest the ATCF A-Deck Tracks for different cyclones
|   |-- gempak_sfc_ingest.py                <-- Ingest the GEMPAK Surface files that have been decoded (SAO/SHIP/METAR)
|   |-- ingest_1min.sh*                     <-- Run ingest on data that has 1-min update intervals
|   |-- ingest_20min.sh*                    <-- Run ingest on data that has approximately 20-min update intervals
|   |-- ingest_5min.sh*                     <-- Run ingest on data that has approximately 5-min update intervals
|   |-- ingest_atcf.py                      <-- DEPRECIATED script to download the a-decks from the ATCF.
|   |-- lightning_ingest.py                 <-- Ingest the lightning strikes from NLDN into TimescaleDB
|   |-- lsr_ingest.py                       <-- Ingest the local storm reports into TimescaleDB
|   |-- rechunk_forecast_zarr.py            <-- DEPRECIATED (old script to rechunk forecast grid zarrs.)
|   |-- recon_ingest.py                     <-- Ingest the NHC Aircraft Reconnaisssance High Frequency Observations into TimescaleDB
|   |-- synoptic_ingest.py                  <-- Ingest observations from the SynopticAPI into the TimescaleDB
|   `-- vad_ingest.py                       <-- Ingest the NEXRAD VAD Vertical Wind Profiles into the TimescaleDB
|
|-- __init__.py
|-- main.py                                 <-- Setup FastAPI service.
|-- metrics.py                              <-- Collect metrics on API performance for Promethieus (DEPRECIATED)
|-- NEW_SOURCE_TEMPLATE.py                  <-- A template for a new data source.
|
|-- readers/                                <-- Helpers to read the files on the disk containing data.
|   |-- __init__.py
|   |-- acad_ltng_reader.py                 <-- Helper to read the ACAD lightning formatted text files
|   |-- base.py
|   |-- gempak_reader.py                    <-- Helper to read GEMPAK files (surface, etc.)
|   |-- geojson_reader.py                   <-- Helper to read GEOJSON files (not used very much)
|   |-- goes_reader.py                      <-- Helper to read GOES data?
|   |-- mrms_reader.py                      <-- Helper to read MRMS GRIB2 files.
|   `-- zarr_reader.py                      <-- Helper to read ZARR datasets
|
|-- README.md
|-- requirements.txt
|-- routers/                                <-- Software components for routing API requests (like a mail sorting room)
|   |-- __init__.py
|   |-- catalog.py                          <-- Endpoints to obtain information about the Data Catalog
|   |-- events.py                           <-- Endpoints to emit server-side events (e.g., new data available)
|   |-- geometries.py                       <-- Endpoints to serve geometric data from TimescaleDB (e.g, watches, warnings, ATCF tracks)
|   |-- gridded.py                          <-- Endpoints to serve gridded data (via ProtocolBuffer)
|   |-- lightning.py                        <-- Endpoints to serve lightning points (not used; DEPRECIATED)
|   |-- points_db.py                        <-- Endpoints to serve point data from TimescaleDB (e.g., recon, surface obs, lightning strikes)
|   |-- profiles_db.py                      <-- Endpoints to serve profile data from TimescaleDB (e.g., VAD winds, radiosondes, dropsondes, etc.)
|   |-- timematch.py                        <-- Endpoints to perform time matching of data sources when building maps.
|   `-- zarr_proxy.py                       <-- Endpoints to forward Zarr chunks to the frontend.
|
|-- services/
|   |-- __init__.py
|   |-- alerts_sql.py                       <-- Queries TimescaleDB for Alerts (Advisories/Watch/Warnings and filters them)
|   |-- atcf_sql.py                         <-- Queries TimescaleDB ATCF for a LineString per storm/model/cycle or PointFeatures at a fhr
|   |-- grid_cache.py                       <-- Caches grid requests to avoid rereading Zarr data or reserializing ProtoBufs
|   |-- points_sql.py                       <-- Queries TimescaleDB for Point data.  Spatial filtering done by PostGIS.
|   |-- profiles_sql.py                     <-- Queries TimescaleDB for Profile data.
|
|-- sources/                                <-- Describes the DataSources available to be served by the API.
|   |-- __init__.py
|   |-- cyclones.py                         <-- Instantiates the ATCF Database source.
|   |-- gridded_analyses.py                 <-- Instantiates Gridded Analysis sources (e.g., the mesoanalysis)
|   |-- imagery.py                          <-- Instantiates Imagery data sources (e.g., GOES imagery, MRMS)
|   |-- nwp_forecasts.py                    <-- Instantiates NWP gridded forecast data sources (e.g., HREF, ECMWF HIRES, GFS)
|   |-- observations.py                     <-- Instantiates observed point data sources (e.g., SAO, LIGHTNING, RECON)
|   |-- registry.py                         <-- Holds the registry that lists all the available data sources for the frontend.
|   `-- types/
|       |-- __init__.py
|       |-- base.py                         <-- Abstract base class for Data Sources.  2Q: what valid times & where is file.
|       |-- db_source.py                    <-- Classes for TimescaleDB Data Sources (e.g., Point, Generic, Profile, Alert, etc.)
|       |-- filesystem.py                   <-- Classes for FileSystem-based Data Sources
|       `-- raster_source.py                <-- Classes for Raster-like Data Sources (e.g., GOES-E/CONUS)
|
|-- utils/                                  <-- Utilities for the API
|   |-- human_regex.py                      <-- Helpers for converting human-readable to regex mapping for date/times
|   |-- met_features.py                     <-- Encoder for compressing met features (e.g., lat/lon/polygon) DEPRECIATED
|   |-- time_helper.py                      <-- Helpers for datetime objects (converting time key string to datetime object)
|   `-- zarr_conventions.py                 <-- Conventions for Zarr files (format version, compression strategy, field precision)
|
`-- watcher.py                              <-- Uses the watchdog library to monitor for new data that becomes available.
```

## Future Backend TODOs:

- Create FAA ASDI endpoint and insert flight tracks into TimescaleDB
- Serve scatterometer data via the API to the frontend.
- Permit datasets with moving grids (e.g., GOES Mesoscale Domains, MIMIC-TC, HWRF)
- Suppliment the ATCF with metadata (https://ftp.nhc.noaa.gov/atcf/docs/nhc_techlist.dat)
- Label the ATCF output by type https://www.nhc.noaa.gov/modelsummary.shtml
- Send data using ProtocolBuffer instead of GeoJSON?

# Additional Analysis Datasets:
- QPE Datasets https://water.noaa.gov/about/precipitation-data-access

# Additional NWP Dataset:

- Ensemble forecasted spaghetti contours.  Could output GeoJSON of the contours when generating the
  ECMWF or GEFS forecast grids and then insert them into the TimescaleDB.  They then could be retrieved
  and set to the frontend.
- Met Office Global Deterministic 10 km (https://registry.opendata.aws/met-office-global-deterministic/) forecasts.
- Met Office Global Ensemble Prediction System (MOGREPS-G; https://registry.opendata.aws/met-office-global-ensemble/) forecasts.
- CMC Global Deterministic Prediction System (GDPS) (https://eccc-msc.github.io/open-data/msc-data/nwp_geps/readme_geps-datamart_en/) forecasts.
- CMC Global Ensemble Prediction System (GEPS) (https://eccc-msc.github.io/open-data/msc-data/nwp_geps/readme_geps-datamart_en/) forecasts.
- NSSL MPAS Runs.
- RRFS (when it becomes operational).
- REFS (when it becomes operational).
- AirNow PM2.5 and PM10 Grids.


https://www.metoffice.gov.uk/api/assets/file/mogreps-g-ps47-asdi-pdf-updates-20pdf?prefix=assets


# Additional Misc. Dataset:
- FAA ASDI Flight Tracks

# Additional Tropical Datasets:
- MIMIC-TC (https://tropic.ssec.wisc.edu/real-time/mimtc2/tc.shtml)
- TC Tracks from NOMADS (https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/v1.3/) (FENS is the FNMOC Ensemble)
- TC-Scale Atmospheric Motion Vectors (https://tropic.ssec.wisc.edu/real-time/mesoamv/mesoamv.html)
- GOES Atmospheric Motion Vectors (on the LDM)
- KNMI Scatterometers Grids from ASCAT-B, ASCAT-C, HY-2B, HY-2C, HY-2D, Oceansat-3

# Ideas for Scatterometer Data:

Scatterometer data comes in compressed netCDF files with the dimensions (NUMROWS, NUMCELLS). 
What if we converted this to Zarr and saved each row as a chunk?  Or each chunk was 5-minutes?
Then I could send each relevant chunk to the frontend?  Then the chunks could just be plotted
as barbs.

# Resources:
https://science.nrlmry.navy.mil/atcf/docs/database/new/abrdeck.html
