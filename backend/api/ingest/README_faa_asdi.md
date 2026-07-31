# FAA ASDI ingestion

Apply the schema once. The application DSN uses SQLAlchemy's
`postgresql+asyncpg://` scheme; `psql` needs the equivalent `postgresql://`
scheme:

```bash
psql "${TIMESCALE_CONN/postgresql+asyncpg/postgresql}" \
  -f backend/api/db/migrations/008_create_aircraft_positions.sql
```

Run the continuous consumer:

```bash
export TIMESCALE_CONN='postgresql+asyncpg://user:password@host/wxdata'
export FAA_SWIM_RUN_CMD='/home/gblumberg/ingest/faa_swim/bin/run'
export FAA_SWIM_CONFIG='/home/gblumberg/ingest/faa_swim/application.conf'
export FAA_SWIM_LINE_LIMIT_MB=16
python -m backend.api.ingest.faa_asdi_ingest
```

The process runs until SIGINT or SIGTERM, batches messages for TimescaleDB,
flushes once per second by default, and terminates the child Java client on
shutdown. Aircraft position history is retained for 24 hours.

By default, all aircraft are retained and the API performs carrier filtering.
To permanently limit ingestion, set an ICAO callsign-prefix whitelist:

```bash
export FAA_ASDI_CARRIERS=major
# Or: FAA_ASDI_CARRIERS=AAL,DAL,SWA,UAL
```

To retain only flights arriving at or departing from one of the FAA Core 30
airports, use the `core30` airport whitelist:

```bash
export FAA_ASDI_AIRPORTS=core30
# Equivalent command-line option:
python -m backend.api.ingest.faa_asdi_ingest --airports core30
```

`--airports` and `FAA_ASDI_AIRPORTS` also accept comma-separated ICAO or
three-letter FAA/IATA identifiers, for example `KATL,PHNL` or `ATL,HNL`.
When airport and carrier filters are both configured, a flight must match both.

For a production background process, configure systemd with the same
environment:

```ini
[Unit]
Description=WebNMAP FAA SWIM ASDI ingest
After=network-online.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/home/gblumberg/code/web-nmap
EnvironmentFile=/home/gblumberg/code/web-nmap/.env
ExecStart=/home/gblumberg/conda-env/nmap_api/bin/python -m backend.api.ingest.faa_asdi_ingest
Restart=always
RestartSec=10
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

The API endpoint is:

```text
GET /api/v1/geometries/FAA_ASDI/features
    ?key=20260730_2200
    &window_minutes=30
    &airports=KPSP,KOAK
    &carriers=major
    &operation=both
    &bbox=-125,30,-110,45
```

`operation` accepts `arrival`, `departure`, or `both`. Without `airports`,
all flights in the requested time window are returned.
