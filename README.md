# WebNMAP

WebNMAP is a browser-based meteorological analysis and display system inspired by the NMAP2 workflow from NAWIPS/GEMPAK. It combines an interactive [MapLibre GL JS](https://maplibre.org/) map with the WebGL-based [autumnplot-gl](https://github.com/tsupinie/autumnplot-gl) rendering library, a FastAPI data service, chunked Zarr stores, and TimescaleDB/PostGIS.

The application is designed for operational-style workflows: discover available datasets, select a source and product, build layered maps, time-match fields from different sources, animate through frames, and receive updates as new data arrives.

> WebNMAP is under active development. The source registry contains deployment-specific paths under `/data/store`, so a fresh checkout provides the application code but not the operational meteorological datasets.

## What it can display

- Deterministic and ensemble numerical guidance, including ECMWF, HRRR, NAM Nest, HREF, NSSL WRF, and ensemble products enabled in the source registry
- MRMS radar mosaics and GOES raster imagery
- Gridded analyses such as the mesoanalysis
- Surface, ship, air-quality, lightning, local storm report, reconnaissance, and ASCAT point observations
- VAD vertical wind profiles
- NWS watches, warnings, and advisories
- ATCF tropical cyclone tracks
- FAA ASDI aircraft positions and tracks
- Filled and line contours, wind barbs, station plots, rasters, probability fields, paintballs, overlays, labels, color bars, and sampled map readouts

The exact datasets shown by a running instance come from [`backend/api/sources/registry.py`](backend/api/sources/registry.py), not from a hard-coded frontend list. A registered source may still appear as empty or unavailable when its files or database are absent.

## Architecture

```text
Meteorological files             Point/profile/vector feeds
(GRIB2, NetCDF, GEMPAK, etc.)    (obs, alerts, ATCF, FAA, ...)
             |                                |
             v                                v
       processing/ingest scripts       TimescaleDB + PostGIS
             |                                |
             v                                |
      chunked Zarr v2 stores -----------------+
                         |
                         v
              FastAPI catalog and data API
         (protobuf, GeoJSON, Zarr chunks, SSE)
                         |
             webpack development proxy
                         |
                         v
       MapLibre + autumnplot-gl browser client
```

### FastAPI backend

The API in [`backend/api`](backend/api) is the catalog and delivery layer between the data stores and the browser. It:

- Builds a catalog from registered filesystem and database sources
- Inventories valid times, forecast cycles, forecast hours, variables, vertical levels, and grid metadata
- Serves gridded fields and streaming forecast/analysis responses
- Proxies Zarr metadata and chunks without re-compressing already compressed payloads
- Queries spatial and temporal point, profile, alert, track, and aircraft data from TimescaleDB/PostGIS
- Performs cross-source time matching
- Watches source directories and polls database sources, then publishes new-data notifications with Server-Sent Events (SSE)
- Applies Brotli/gzip transport compression where useful and exposes Prometheus metrics
- Caches/coalesces catalog scans and grid work to reduce repeated I/O

Useful development endpoints after startup:

| Endpoint | Purpose |
| --- | --- |
| `http://localhost:8000/docs` | Interactive OpenAPI documentation |
| `http://localhost:8000/api/v1/health` | API health check |
| `http://localhost:8000/api/v1/catalog/sources` | Active source catalog |
| `http://localhost:8000/api/v1/catalog/status` | Dataset freshness and availability |
| `http://localhost:8000/metrics` | Prometheus metrics |

### Frontend and webpack server

The frontend in [`frontend`](frontend) is a JavaScript application built with webpack. The development server:

- Serves the UI and static map assets at `http://localhost:5173`
- Hot-reloads frontend changes
- Proxies `/api` to FastAPI at `http://127.0.0.1:8000`, avoiding separate API URLs in browser code
- Keeps the SSE proxy uncompressed and open-ended so live update events are delivered immediately

The browser fetches the backend catalog, presents compatible products for each source, retrieves the requested variables and frames, constructs autumnplot-gl grids and layers, and manages multi-layer animation on the MapLibre map.

### Product Generation and procedures

WebNMAP includes a browser-side authoring workflow for manually drawn meteorological products:

- ProductGen supports contour, front, and text products with map-based drawing/editing, undo/redo, and GeoJSON export.
- Forecast-suite mode provides predefined suites, products, and level defaults (color, pattern, width) for faster and more consistent forecast graphics.
- Validation checks enforce suite geometry rules (for example, mutually exclusive categorical areas and nested threshold rules where configured).
- Procedure Manager stores full map configurations (sources, timeline, map view, basemap settings, and auto-update state) in browser localStorage.
- Procedures can be saved, updated, loaded, exported to JSON, and imported back into another browser session.

### Zarr stores and efficient chunking

Large gridded datasets live primarily in **Zarr v2** stores. Zarr lets the application fetch only the array metadata and chunks required for a selected field and time instead of reading or transferring an entire model file. WebNMAP uses compressed chunks (typically Blosc with Zstandard for floating-point fields), display-oriented numeric precision, lazy xarray/Dask processing, and a FastAPI Zarr proxy that streams the stored bytes directly to the browser.

Chunk shape is important:

- General conversion defaults to configurable spatial tiles (for example `256 x 256`), which limits memory use and supports partial access.
- The fastest forecast-serving path expects time-indexed arrays chunked as `(time=1, y=ny, x=nx)`; ensemble fields additionally use `member=1`. One request can then return a stored frame chunk without decoding and recompressing it.
- Choose worker counts conservatively when rechunking because each worker may hold a complete grid frame in memory.

See [`docs/data_structuring.md`](docs/data_structuring.md) and [`docs/dataset_monitoring.md`](docs/dataset_monitoring.md) for conventions and the forecast fast path.

### TimescaleDB and PostGIS

TimescaleDB stores time-oriented, spatial records that are a poor fit for gridded Zarr arrays. PostGIS supplies spatial indexes and bounding-box queries. Versioned SQL migrations create and evolve hypertables for:

- Generic point observations and geometries
- NWS alerts
- Vertical profiles
- ATCF forecast track points
- FAA aircraft position history

The migrations also define indexes, compression, and retention policies for operationally high-volume data. Database access is asynchronous through SQLAlchemy and `asyncpg`; configure it with `TIMESCALE_CONN`.

### Efficient point-observation loops

Point overlays are delivered differently from gridded frames. For a loop with overlapping lightning or surface-observation windows, the frontend computes the union of all required windows and makes one raw-range request to `/api/v1/db-points/{source_id}`. The Protobuf response contains each observation once plus the source's selection policy. The browser then reconstructs every frame locally, preserving `binflag`, `before_minutes`, `after_minutes`, `use_most_recent_filter`, and `most_recent_by` behavior.

When `return_age` is enabled, the browser calculates `age_minutes` relative to each frame. This is necessary because one observation reused by several frames has a different age in each frame. The existing center-based point request remains available and continues to perform server-side selection and age calculation for single-frame callers.

## Prerequisites

- Python 3.10 or newer
- Node.js 18 or newer and npm
- TimescaleDB with PostGIS for database-backed sources (optional if working only with filesystem sources)
- Docker with Compose for the optional Prometheus/Grafana monitoring stack
- System libraries required by GRIB/NetCDF packages when running the conversion or ingestion tools

The backend dependency list includes FastAPI/Uvicorn, SQLAlchemy/asyncpg, NumPy, xarray/Dask, Zarr, GRIB and NetCDF readers, MetPy, pandas, Brotli, and monitoring/file-watching libraries. Frontend dependencies include autumnplot-gl, protobufjs, Zarr clients, webpack, and Vitest.

## Quick start for development

All commands below start at the repository root.

### 1. Install the backend

Create and activate an environment using your preferred tool, then install the API requirements:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r backend/api/requirements.txt
```

Some ingestion scripts integrate with external packages or services and may need additional source-specific dependencies and credentials.

### 2. Configure the environment

```bash
cp .env.example .env
```

Edit `.env` as appropriate. Shells and Uvicorn do not automatically load this file, so export it before starting processes:

```bash
set -a
source .env
set +a
```

`TIMESCALE_CONN` is required when database-backed sources are inventoried, queried, or ingested. `WEBNMAP_DATA_ROOT` defaults to `/data/store/`, although individual source definitions currently contain their own deployment paths and may need adjustment in [`backend/api/sources`](backend/api/sources).

### 3. Install the frontend

`autumnplot-gl` is a local file dependency at `frontend/external/autumnplot-gl`. This repository tracks that directory as a Git submodule, so initialize it if your clone did not include its contents:

```bash
git submodule update --init --recursive
```

The active npm project is inside `frontend/`:

```bash
cd frontend
npm install
cd ..
```

### 4. Start FastAPI

From the repository root, with the Python environment and configuration active:

```bash
uvicorn backend.api.main:app --host 127.0.0.1 --port 8000 --reload
```

Use `--host 0.0.0.0` when Prometheus in Docker must scrape the host API. For a production-style launch, remove `--reload` and select an appropriate worker/process supervisor configuration.

### 5. Start webpack

In a second terminal:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`. Keep FastAPI running on port `8000`; webpack forwards browser API requests to it.

## Database setup

Create a PostgreSQL database with the TimescaleDB and PostGIS extensions available, set `TIMESCALE_CONN` to an async SQLAlchemy DSN, and apply migrations in numeric order. `psql` uses the regular PostgreSQL driver name, so convert the example DSN when invoking it:

```bash
export TIMESCALE_CONN='postgresql+asyncpg://webnmap:password@localhost:5432/wxdata'
export PSQL_CONN="${TIMESCALE_CONN/postgresql+asyncpg/postgresql}"

for migration in backend/api/db/migrations/*.sql; do
  psql "$PSQL_CONN" -v ON_ERROR_STOP=1 -f "$migration"
done
```

Review migrations before applying them to an existing deployment: they include retention/compression policies and migration `010` removes aircraft rows older than 24 hours.

## Preparing gridded data

Convert one GRIB2 file to a Zarr store:

```bash
python backend/processing/grib2_to_zarr.py \
  --input /path/to/model.grib2 \
  --output /data/store/grid/model/model.zarr \
  --chunk-y 256 \
  --chunk-x 256 \
  --compressor zstd \
  --compression-level 5
```

Convert a directory recursively:

```bash
python backend/processing/grib2_to_zarr.py \
  --input /path/to/grib/files \
  --output /data/store/grid/model \
  --pattern '*.grib2,*.grb2,*.grib,*.grb' \
  --recursive
```

The converter reads GRIB2 messages one at a time, writes chunked variables and optional latitude/longitude arrays, and preserves identification, level, units, cycle/valid-time, and forecast-hour metadata in Zarr attributes. Use `--overwrite` deliberately when replacing stores.

To inspect or optimize an existing forecast store for direct frame serving:

```bash
python -m backend.api.ingest.rechunk_forecast_zarr \
  --store /data/store/grid/model/example.zarr \
  --dry-run
```

Remove `--dry-run` only after reviewing the proposed layout. The rewrite uses a sibling temporary store and replaces the original after successful completion.

## How data products work

Frontend data-product modules in [`frontend/src/domain/dataProducts`](frontend/src/domain/dataProducts) play a role similar to NMAP restore files. They describe how available source variables become a meteorological visualization; they do not read files or know storage paths.

Each product definition generally provides:

- A stable product ID, display label, group, and title template
- `available_for`, listing compatible backend source IDs
- `data_keys`, listing variables the browser must request
- `make_layers(data, grid)`, which creates autumnplot-gl contours, fills, barbs, station models, rasters, labels, or other layers
- Optional color bars, map samplers, controls, or special loaders

[`productIndex.js`](frontend/src/domain/dataProducts/productIndex.js) merges the product families into one registry and defines UI group names. At runtime the frontend follows this flow:

1. Fetch source metadata and available times from FastAPI.
2. Filter the product registry by `available_for`.
3. Request the selected product's `data_keys` through the appropriate gridded, Zarr, point, profile, or geometry client.
4. Build the grid from backend `grid_info` metadata.
5. Call `make_layers` for each selected frame.
6. Wrap corresponding layers in multi-frame layers for animation and synchronize sources through time matching.

To add a conventional product, add it to the appropriate family module and ensure its variables agree with the backend source's exposed names or variable mapping. To add an entirely new dataset, start with [`backend/api/NEW_SOURCE_TEMPLATE.py`](backend/api/NEW_SOURCE_TEMPLATE.py), register the source, then add compatible frontend products.

## Ingestion and processing

The repository includes adapters under [`backend/api/ingest`](backend/api/ingest) for AirNow, ASCAT, ATCF, FAA ASDI, GEMPAK surface data, lightning, local storm reports, reconnaissance, Synoptic observations, VAD data, and NWS alerts. These scripts typically:

1. Download, stream, or read the upstream format.
2. Normalize times, identifiers, coordinates, and meteorological properties.
3. Insert deduplicated rows into the appropriate TimescaleDB hypertable, or generate a filesystem product.
4. Let the API's polling/watching layer detect the new inventory and notify connected clients.

Run a module with `--help` and inspect its docstring before using it; inputs, credentials, and destructive replacement behavior differ by feed. The example environment file documents KNMI ASCAT FTP and FAA SWIM settings. FAA-specific setup is in [`backend/api/ingest/README_faa_asdi.md`](backend/api/ingest/README_faa_asdi.md).

Additional processing utilities in [`backend/processing`](backend/processing) cover GRIB2-to-Zarr conversion, ensemble diagnostics/post-processing, contour extraction, and observation conversion.

## Building and testing

Build the browser application:

```bash
cd frontend
npm run build
```

Webpack writes the deployable frontend to `frontend/dist/`. The current FastAPI static mount serves `frontend/public/`, so serving a production build requires pointing the web server/static deployment at `frontend/dist/` or copying the built assets as part of deployment.

Run frontend tests:

```bash
cd frontend
npm test
```

Run backend tests from the repository root:

```bash
python -m pytest backend/api/tests
```

`pytest` is a development dependency and is not currently listed in the runtime requirements file.

## Monitoring

With FastAPI running on `0.0.0.0:8000`, start the optional monitoring stack:

```bash
docker compose up -d
```

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3000`
- Default local Grafana credentials: `admin` / `admin` unless overridden with `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD`

Grafana is provisioned with dataset-health and API-performance dashboards. Prometheus scrapes `host.docker.internal:8000/metrics` and evaluates stale/unavailable dataset alerts. See [`docs/dataset_monitoring.md`](docs/dataset_monitoring.md) for freshness settings, cache controls, dashboard behavior, and alerting limitations.

Stop the stack with `docker compose down`. Named volumes preserve Prometheus and Grafana state.

## Configuration reference

Common settings include:

| Variable | Purpose | Default |
| --- | --- | --- |
| `TIMESCALE_CONN` | Async SQLAlchemy DSN for TimescaleDB/PostGIS | Required for DB sources |
| `WEBNMAP_DATA_ROOT` | General filesystem data root | `/data/store/` |
| `WEBNMAP_CATALOG_CACHE_SECONDS` | Source inventory cache duration | `30` seconds |
| `WEBNMAP_STATUS_FORECAST_MAX_AGE_MINUTES` | Default forecast staleness threshold | `720` |
| `WEBNMAP_STATUS_OBS_MAX_AGE_MINUTES` | Default non-forecast staleness threshold | `180` |
| `WEBNMAP_STATUS_TIMEOUT_SECONDS` | Per-source status check timeout | See monitoring docs |
| `WEBNMAP_STATUS_CACHE_SECONDS` | Dataset-status cache duration | See monitoring docs |
| `ASCAT_FTP_*` | KNMI scatterometer download credentials/options | See `.env.example` |
| `FAA_SWIM_*` / `FAA_ASDI_CARRIERS` | FAA streaming client and optional filter | See `.env.example` |

Never commit `.env`, credentials, or provider configuration containing secrets.

## Repository guide

| Path | Contents |
| --- | --- |
| `backend/api/` | FastAPI app, routes, source registry, readers, database services, watchers, and metrics |
| `backend/api/db/migrations/` | Ordered TimescaleDB/PostGIS schema migrations |
| `backend/api/ingest/` | Feed-specific ingestion programs |
| `backend/processing/` | Offline conversion and derived-product tools |
| `frontend/src/controllers/` | Application orchestration and UI control flow |
| `frontend/src/config/forecastSuites.js` | Declarative forecast-suite product/level definitions for ProductGen |
| `frontend/src/domain/forecastValidation.js` | Forecast-suite geometry validation rules and polygon overlap/containment logic |
| `frontend/src/domain/dataProducts/` | Product/restore-style visualization definitions |
| `frontend/src/services/` | API clients and binary decoders |
| `frontend/src/services/procedureStore.js` | Local persistence and schema validation for saved procedures |
| `frontend/src/views/panels/procedureManager.js` | Procedure save/load/import/export user interface |
| `frontend/public/` | Static styles, map configuration, fonts, and WASM assets |
| `frontend/external/autumnplot-gl/` | Local autumnplot-gl dependency/submodule |
| `proto/` | Shared Protocol Buffer schemas and generated Python bindings |
| `monitoring/` | Prometheus rules/configuration and provisioned Grafana dashboards |
| `docs/` | Architecture, data layout, product, and operational notes |

## Troubleshooting

- **The UI opens but no sources contain data:** the registry points to operational paths under `/data/store`; mount/populate those paths or update the relevant source definitions.
- **Catalog or DB endpoints return errors:** confirm `TIMESCALE_CONN`, database connectivity, installed extensions, and migration state.
- **Frontend API calls fail:** start FastAPI on port `8000` and webpack from `frontend/` on port `5173`.
- **Live updates do not arrive:** use the webpack development proxy or ensure a production reverse proxy disables buffering/compression for `/api/v1/events`.
- **Prometheus reports the API target down:** bind Uvicorn to `0.0.0.0` and check `http://localhost:9090/targets`.
- **A Zarr forecast is slow:** inspect its chunks; the direct forecast fast path requires one time/member per chunk and a full spatial frame.
- **The basemap is blank:** inspect `frontend/public/styles/style.json` and `tiles.json`; configured tile/font endpoints must be reachable from the browser.

## Further documentation

- [Backend overview](backend/README.md)
- [Frontend overview](frontend/README.md)
- [Architecture](docs/architecture.md)
- [Data structuring](docs/data_structuring.md)
- [Dataset monitoring](docs/dataset_monitoring.md)
- [Spaghetti plotting](docs/spaghetti_plotting.md)
- [Protocol Buffers](proto/README.md)

## Screenshots

Screenshots and architecture diagrams would be valuable additions. When they are available, place optimized assets in a repository documentation directory such as `docs/images/` and add concise captions and alt text here. Useful views would include the main map and timeline, the data/product selector, a multi-layer severe-weather display, and the Grafana dataset-health dashboard.
