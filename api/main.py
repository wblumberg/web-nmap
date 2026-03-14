from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .routers import catalog, lightning, observations, timematch, events, points, gridded, geometries
from .watcher import start_watching

_observer = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """ 
    FastAPI lifespan context manager.
    Code before `yield` runs on startup; code after runs on shutdown.
    This replaces the deprecated @app.on_event("startup") pattern.
    """
    global _observer
    # Start watching data directories for new files
    _observer = start_watching()
    yield
    # Clean shutdown: stop the watchdog observer thread
    if _observer:
        _observer.stop()
        _observer.join()


app = FastAPI(
    title       = "WebNMAP Data API",
    description = "Serves meteorological data products to the WebNMAP frontend.",
    version     = "0.1.0",
    lifespan    = lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins = ["http://localhost:8080", "http://localhost:5173"],
    allow_methods = ["GET"],
    allow_headers = ["*"],
)
## Add compression to responses larger than 1000 bytes to improve performance and reduce bandwidth usage.
# https://medium.com/@b.antoine.se/supercharge-your-fastapi-mastering-middlewares-for-robust-and-efficient-apis-e79bece902f3

app.add_middleware(GZipMiddleware, minimum_size=1000)  # Compress responses larger than 1000 bytes

# Include routers (added timematch, removed duplicate observations)
app.include_router(catalog.router,      prefix="/api/v1/catalog")
app.include_router(lightning.router,    prefix="/api/v1/lightning")
app.include_router(observations.router, prefix="/api/v1/observations")
app.include_router(timematch.router,    prefix="/api/v1/timematch")  # Added missing inclusion
app.include_router(events.router,       prefix="/api/v1/events")
app.include_router(points.router,       prefix="/api/v1/points")
app.include_router(gridded.router,      prefix="/api/v1/gridded")
app.include_router(geometries.router,   prefix="/api/v1/geometries")

@app.get("/")
def read_root():
    return {"message": "API is running"}

@app.get("/api/v1/health")
def health():
    return {"status": "ok"}

@app.get("/metrics")
def get_metrics():
    # ... logic to return metrics
    pass
