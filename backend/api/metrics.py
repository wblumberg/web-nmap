"""
metrics.py — Prometheus metrics definitions for the WebNMAP API.

All custom metrics live here so they can be imported wherever needed
and extended without touching main.py.

─── Exposed metrics ─────────────────────────────────────────────────────────

http_requests_total          Counter   — total requests by method/endpoint/status
http_request_duration_seconds  Histogram — request latency by method/endpoint
http_response_size_bytes     Histogram — compressed response body size by endpoint

─── Adding new metrics ──────────────────────────────────────────────────────

1.  Define the metric here using prometheus_client primitives.
2.  Import and update it in the appropriate router or middleware.
3.  The /metrics endpoint will pick it up automatically.

─── Usage ───────────────────────────────────────────────────────────────────

    from .metrics import REQUEST_COUNT, REQUEST_LATENCY, RESPONSE_SIZE

    REQUEST_COUNT.labels(method="GET", endpoint="/api/v1/observations/surface", status=200).inc()
    RESPONSE_SIZE.labels(endpoint="/api/v1/observations/surface").observe(len(body_bytes))

─── Prometheus scrape ───────────────────────────────────────────────────────

    GET /metrics  →  Prometheus text format

"""

from prometheus_client import Counter, Gauge, Histogram, REGISTRY  # noqa: F401  (re-exported)

# ── Request counter ───────────────────────────────────────────────────────────
REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests received.",
    labelnames=["method", "endpoint", "status", "source_id", "variable_group", "query_group"],
)

# ── Latency histogram ─────────────────────────────────────────────────────────
# Buckets cover the range from fast in-memory reads (~5 ms) to slow GRIB/NetCDF
# reads that may take a few seconds.
REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request processing time in seconds.",
    labelnames=["method", "endpoint", "source_id", "variable_group", "query_group"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# ── Response size histogram ───────────────────────────────────────────────────
# Tracks bytes emitted by the application body iterator. Depending on middleware
# ordering this is the compressed payload for compressed responses; Zarr chunks
# are already compressed and are always counted exactly as served.
RESPONSE_SIZE = Histogram(
    "http_response_size_bytes",
    "HTTP response payload bytes emitted by the application.",
    labelnames=["method", "endpoint", "source_id", "variable_group", "query_group"],
    buckets=(
        500, 1_000, 5_000, 10_000, 50_000,
        100_000, 500_000, 1_000_000, 5_000_000,
        10_000_000, 25_000_000, 50_000_000, 100_000_000,
    ),
)

# ── Proactive dataset health ─────────────────────────────────────────────────
# These are updated by dataset_status.py independently of normal user traffic.
DATASET_HEALTH = Gauge(
    "webnmap_dataset_health",
    "Dataset health: 1 healthy, 0.5 stale, 0 unavailable/empty/error.",
    labelnames=["source_id", "label", "data_category"],
)
DATASET_AVAILABLE = Gauge(
    "webnmap_dataset_available",
    "Whether the dataset inventory check succeeded and found at least one time.",
    labelnames=["source_id", "label", "data_category"],
)
DATASET_LATEST_TIMESTAMP = Gauge(
    "webnmap_dataset_latest_timestamp_seconds",
    "Unix timestamp of the latest dataset cycle or valid time.",
    labelnames=["source_id", "label", "data_category"],
)
DATASET_AGE = Gauge(
    "webnmap_dataset_age_seconds",
    "Age of the latest dataset cycle or valid time.",
    labelnames=["source_id", "label", "data_category"],
)
DATASET_CHECK_DURATION = Gauge(
    "webnmap_dataset_check_duration_seconds",
    "Duration of the most recent dataset inventory check.",
    labelnames=["source_id", "label", "data_category"],
)
