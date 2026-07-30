import time
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from brotli_asgi import BrotliMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST

from .metrics import REQUEST_COUNT, REQUEST_LATENCY, RESPONSE_SIZE
from .routers import catalog, lightning, timematch, events, gridded, geometries, points_db, profiles_db, zarr_proxy
from .watcher import start_watching, start_db_polling
from .services.dataset_status import status_refresh_loop

_observer = None
_TRACKED_QUERY_PARAMS = (
    "center", "window_minutes", "level", "bbox", "cycle", "fhr",
    "storm_id", "basin", "model",
)


def _sanitize_label_value(value: str, max_len: int = 48) -> str:
    value = value.strip()
    if len(value) > max_len:
        value = value[:max_len] + "..."
    return value or "none"


def _extract_source_id(request: Request) -> str:
    """Extract source_id from path params (e.g. /gridded/{source_id}/field)."""
    raw = request.path_params.get("source_id")
    if raw is None:
        return "none"
    return _sanitize_label_value(str(raw))


def _extract_variable_group(request: Request) -> str:
    """Extract variables from query params or a Zarr chunk path."""
    raw_chunks = []
    for key in ("variables", "variable", "var"):
        raw_chunks.extend(request.query_params.getlist(key))

    if not raw_chunks:
        # Zarr encodes the variable in the catch-all chunk path:
        #   {variable}/0.0 or {variable}/.zarray
        # Keep root/group metadata distinguishable from actual field payloads.
        chunk_path = request.path_params.get("chunk_path")
        if chunk_path:
            first_segment = str(chunk_path).split("/", 1)[0]
            if first_segment.startswith("."):
                return "zarr_metadata"
            return _sanitize_label_value(first_segment, max_len=64)
        return "none"

    values = []
    seen = set()
    for chunk in raw_chunks:
        for token in chunk.split(","):
            token = _sanitize_label_value(token, max_len=32)
            if token == "none" or token in seen:
                continue
            seen.add(token)
            values.append(token)
            if len(values) >= 4:
                break
        if len(values) >= 4:
            break

    return "|".join(values) if values else "none"


def _build_query_group(request: Request) -> str:
    """Build a bounded label for auxiliary (non-source/non-variable) query params."""
    parts = []
    for key in _TRACKED_QUERY_PARAMS:
        values = request.query_params.getlist(key)
        if not values:
            continue

        trimmed_values = []
        for value in values[:3]:
            value = _sanitize_label_value(value)
            trimmed_values.append(value)

        parts.append(f"{key}={'|'.join(trimmed_values)}")

    return ",".join(parts) if parts else "none"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """ 
    FastAPI lifespan context manager.
    Code before `yield` runs on startup; code after runs on shutdown.
    """
    global _observer
    _observer = start_watching()
    _db_tasks = start_db_polling(interval_seconds=30)
    _status_task = asyncio.create_task(status_refresh_loop())
    yield
    if _observer:
        _observer.stop()
        _observer.join()
    for task in _db_tasks:
        task.cancel()
    _status_task.cancel()


_openapi_tags = [
    {
        "name": "Catalog",
        "description": "List available data sources and their valid time inventories.",
    },
    {
        "name": "Gridded Data",
        "description": (
            "Serve 2-D gridded fields (analyses and forecasts) as raw float32/float16 arrays "
            "consumable by autumnplot-gl. Supports single-time analysis, cycle+fhr forecast, "
            "and batch streaming endpoints."
        ),
    },
    {
        "name": "DB Points",
        "description": (
            "Query point observations stored in the TimescaleDB `points` hypertable "
            "(e.g. lightning strikes, AirNow air-quality readings). Returns protobuf or GeoJSON."
        ),
    },
    {
        "name": "DB Profiles",
        "description": (
            "Query vertical profile observations stored in the TimescaleDB `profiles` hypertable "
            "(for example VAD wind profiles). Returns GeoJSON point features with profile arrays "
            "in properties."
        ),
    },
    {
        "name": "Lightning",
        "description": (
            "Lightning strike data. Defaults to the TimescaleDB source; "
            "pass `?source=file` to fall back to file-based ingestion.  This endpoint is depreciated"
            "and you should use the DB Points endpoint instead to access the lightning data."
        ),
    },
    {
        "name": "Geometry Data",
        "description": (
            "GeoJSON polygon/line geometries for NWS watches and warnings, surface fronts, "
            "SPC convective outlooks, and other vector products. "
            "DB-backed alert types (e.g. `tornado_warning`, `severe_thunderstorm_watch`) are "
            "accessible via the same endpoint using an `at` timestamp parameter; see "
            "`GET /geometries/alerts/variables` for the full list of supported names."
        ),
    },
    {
        "name": "Time Matching",
        "description": "Utilities for finding the closest available time step across one or more sources.",
    },
    {
        "name": "Events",
        "description": (
            "Server-Sent Events (SSE) stream that pushes real-time notifications to the frontend "
            "whenever new data arrives (filesystem or database)."
        ),
    },
]

app = FastAPI(
    title        = "WebNMAP Data API",
    description  = "Serves meteorological data products to the WebNMAP frontend.",
    version      = "0.1.0",
    lifespan     = lifespan,
    openapi_tags = _openapi_tags,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins = ["http://localhost:5173"],
    allow_methods = ["GET"],
    allow_headers = ["*"],
)
app.add_middleware(
    BrotliMiddleware,
    quality=9,                # fast compression (0–11 scale)
    minimum_size=1000,
    gzip_fallback=True,       # fall back to gzip if client doesn't accept br
    excluded_handlers=[       # don't compress the protobuf stream — it adds
        r"/api/v1/gridded/.*/forecast_stream",  # latency between frames
        r"/api/v1/gridded/.*/analysis_stream",
        r"/api/v1/events/.*",  # SSE — compression middleware buffers the stream
        r"/api/v1/zarr/.*",    # zarr chunks are already Blosc-compressed; re-compressing wastes CPU
    ],
)


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    """
    Record per-endpoint request count, latency, and response size.

    The endpoint label is normalised to the matched route template
    (e.g. /api/v1/observations/surface) rather than the raw URL so
    that path parameters don't explode the cardinality of the metrics.

    Response bytes are counted as the existing body iterator emits them. This
    works for finite streaming responses and Zarr chunks without buffering or
    delaying delivery to the client.
    """
    start = time.perf_counter()
    response = await call_next(request)
    duration = time.perf_counter() - start

    # Prefer the matched route pattern; fall back to the raw path.
    route = request.scope.get("route")
    endpoint = route.path if route else request.url.path

    status = str(response.status_code)
    method = request.method
    source_id = _extract_source_id(request)
    variable_group = _extract_variable_group(request)
    query_group = _build_query_group(request)

    # Avoid polluting metrics with Prometheus self-scrapes.
    if endpoint != "/metrics":
        REQUEST_COUNT.labels(
            method=method,
            endpoint=endpoint,
            status=status,
            source_id=source_id,
            variable_group=variable_group,
            query_group=query_group,
        ).inc()
        REQUEST_LATENCY.labels(
            method=method,
            endpoint=endpoint,
            source_id=source_id,
            variable_group=variable_group,
            query_group=query_group,
        ).observe(duration)

        size_metric = RESPONSE_SIZE.labels(
            method=method, endpoint=endpoint, source_id=source_id,
            variable_group=variable_group, query_group=query_group,
        )

        # call_next exposes an async body iterator even for ordinary responses.
        # Wrap it to count the bytes already flowing to the ASGI server. Do not
        # eagerly consume it: finite streams retain progressive delivery and
        # large Zarr chunks do not acquire an extra in-memory copy.
        body_iterator = getattr(response, "body_iterator", None)
        if body_iterator is not None:
            async def count_response_bytes():
                response_size = 0
                completed = False
                try:
                    async for chunk in body_iterator:
                        response_size += len(chunk)
                        yield chunk
                    completed = True
                finally:
                    # A disconnected client produced only a partial transfer,
                    # so do not report it as the size of a complete response.
                    if completed:
                        size_metric.observe(response_size)

            response.body_iterator = count_response_bytes()
        else:
            # Defensive fallback for a custom Response without an iterator.
            body = getattr(response, "body", b"")
            size_metric.observe(len(body) if body is not None else 0)

    # Return the original response; the iterator wrapper records as it streams.
    return response


# ── Routers ───────────────────────────────────────────────────────────────────
app.include_router(catalog.router,      prefix="/api/v1/catalog")
app.include_router(lightning.router,    prefix="/api/v1/lightning")
app.include_router(timematch.router,    prefix="/api/v1/timematch")
app.include_router(events.router,       prefix="/api/v1/events")
app.include_router(gridded.router,      prefix="/api/v1/gridded")
app.include_router(geometries.router,   prefix="/api/v1/geometries")
app.include_router(points_db.router,    prefix="/api/v1/db-points")
app.include_router(profiles_db.router,  prefix="/api/v1/db-profiles")
app.include_router(zarr_proxy.router,   prefix="/api/v1/zarr")

PUBLIC_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public"

print("Serving: ", PUBLIC_DIR)


# ── Utility endpoints ─────────────────────────────────────────────────────────

@app.get("/api/v1/health")
def health():
    return {"status": "ok"}


@app.get("/metrics", tags=["metrics"], summary="Prometheus metrics scrape endpoint")
def prometheus_metrics():
    """Returns all registered Prometheus metrics in text exposition format."""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# Mount static files LAST so FastAPI routes above are matched first.
# A Mount at "/" acts as a catch-all and will shadow any routes registered after it.
@app.get("/")
async def index():
    return FileResponse(PUBLIC_DIR / "index.html")

app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")
