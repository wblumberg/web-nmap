# Dataset monitoring

WebNMAP proactively checks every source in the backend source registry. The
checks run concurrently once per minute and are also exposed to the application
at `GET /api/v1/catalog/status`.

Statuses:

- `healthy`: latest cycle/time is within its freshness limit
- `stale`: the inventory works, but the latest data is too old
- `empty`: the inventory works, but contains no data
- `unavailable`: the inventory raised an error or exceeded its timeout

Forecast freshness uses the model cycle, not its latest (possibly future) valid
time. The default maximum age is 12 hours for forecast sources and 3 hours for
other sources. A source may override this by defining
`status_max_age_minutes`. Global defaults and behavior can be adjusted with:

- `WEBNMAP_STATUS_FORECAST_MAX_AGE_MINUTES`
- `WEBNMAP_STATUS_OBS_MAX_AGE_MINUTES`
- `WEBNMAP_STATUS_TIMEOUT_SECONDS`
- `WEBNMAP_STATUS_CACHE_SECONDS`

Run `docker compose up -d` to start Prometheus and Grafana. Grafana is available
at `http://localhost:3000` and automatically loads the **WebNMAP Dataset
Health** and **WebNMAP API Metrics** dashboards in the **WebNMAP** folder.
The API dashboard shows request rate, errors, response size, and p50/p95
server response time, with filters for endpoint, source, variable, and query
group. Response size is counted incrementally from emitted body chunks, so
finite protobuf streams and Zarr chunks are included without buffering them in
the API. Zarr variable names are derived from the chunk path; geometry sources
such as ATCF are distinguished by their `source_id`.

If Grafana was already running when dashboard provisioning was added, restart
it so it reads the mounted provider:

```bash
docker compose restart grafana
```

Prometheus must be able to reach the API at
`host.docker.internal:8000/metrics`. Check target health at
`http://localhost:9090/targets`; change the target in
`monitoring/prometheus.yml` if the API listens elsewhere.

The API is intentionally not part of the monitoring Compose stack. Start it
separately with `./start.sh`. The launcher binds Uvicorn to `0.0.0.0:8000`;
binding only to `127.0.0.1` prevents a Docker container from reaching it.

## Forecast Zarr fast path

The Zarr proxy can return a forecast slice without decoding it when every
time-indexed field uses a one-step time chunk and a full spatial chunk:
`(time=1, y=ny, x=nx)`. Ensemble fields additionally use `member=1`.
Inspect an HREF store without changing it:

```bash
conda run -n nmap_api python backend/api/ingest/rechunk_forecast_zarr.py \
  --store /data/store/grid/href/<store>.zarr --dry-run
```

Then remove `--dry-run` to rewrite that store. To process all HREF stores:

```bash
conda run -n nmap_api python backend/api/ingest/rechunk_forecast_zarr.py \
  --dirs /data/store/grid/href --workers 1
```

The rewrite uses a sibling temporary store and atomically replaces the
original after completion. It preserves dtype, fill value, attributes, and
compression settings. Each worker can hold a full grid frame in memory, so
increase `--workers` conservatively.

The `GF_SECURITY_ADMIN_*` settings only initialize a new Grafana database; they
do not replace credentials already stored in the persistent `grafana_data`
volume. Reset an existing local admin password with:

```bash
docker compose exec grafana grafana cli admin reset-admin-password admin
```

Change the password immediately if Grafana is exposed beyond localhost.

Prometheus evaluates `WebNMAPDatasetUnavailable` after 5 minutes and
`WebNMAPDatasetStale` after 15 minutes. Delivery to email, Slack, or another
receiver requires an Alertmanager/contact-point configuration appropriate for
the deployment.

## Catalog inventory cache

Catalog time and cycle endpoints cache identical source inventory scans for 30
seconds and coalesce concurrent requests for the same inventory. This avoids
repeated filesystem walks or database queries while navigating between
products. Set `WEBNMAP_CATALOG_CACHE_SECONDS` to adjust the freshness window;
new data can take at most that long to appear in an already-cached query.
