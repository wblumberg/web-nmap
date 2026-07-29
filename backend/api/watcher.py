"""
watcher.py — Directory Watcher + DB Poller

Uses the `watchdog` library to monitor configured data directories.
When a new file appears, publishes an event to an asyncio Queue that
the SSE endpoint reads from.

DB-backed sources (PointDBSource) have no files to watch. Instead,
`start_db_polling()` runs an asyncio background task that periodically
queries MAX(valid_time) per DB source and publishes the same event shape
when it detects a new ingestion.

─── How watchdog works ──────────────────────────────────────────────────────
watchdog runs a background OS-native file system monitor (inotify on Linux,
FSEvents on macOS, ReadDirectoryChangesW on Windows). It calls our handler
when files are created, modified, moved, or deleted.

We only care about file creation (a new data file arrived).

─── asyncio + threading ─────────────────────────────────────────────────────
watchdog runs in a background thread. FastAPI runs in an asyncio event loop.
To safely pass events from the watchdog thread to the async event loop,
we use asyncio.Queue with loop.call_soon_threadsafe().

This is a standard Python pattern for bridging threads and asyncio.
"""

import asyncio
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .sources.registry import SOURCES

# --------------------------------------------------------------------------
# Event broadcast infrastructure
# --------------------------------------------------------------------------
# Each connected SSE client registers a private asyncio.Queue here.  When a
# new-data event arrives from watchdog (running in a background thread) it is
# copied into *every* registered queue so all clients receive it.

_client_queues: list[asyncio.Queue] = []
_client_queues_lock = threading.Lock()


def register_client_queue() -> asyncio.Queue:
    """Create a per-client queue and add it to the broadcast list."""
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    with _client_queues_lock:
        _client_queues.append(q)
    return q


def unregister_client_queue(q: asyncio.Queue) -> None:
    """Remove a client queue when the SSE connection closes."""
    with _client_queues_lock:
        try:
            _client_queues.remove(q)
        except ValueError:
            pass


# Kept for backwards compatibility (db-poller uses it to emit events).
_event_queue: asyncio.Queue | None = None
_loop: asyncio.AbstractEventLoop | None = None


class NewFileHandler(FileSystemEventHandler):
    """
    Handles file system events from watchdog.
    Runs in a background thread — must not call async functions directly.

    Zarr stores are *directories*, so a DirCreatedEvent fires as soon as the
    store directory is first created — well before data chunks are written.
    Using recursive=True to catch the nested zarr.json has a race condition on
    Linux/inotify: the watch on the new sub-directory may not be registered in
    time to see events inside it.

    Instead we use recursive=False and *poll* the root zarr.json after directory
    creation.  The zarr.json gets a ``consolidated_metadata`` key only after
    zarr.consolidate_metadata() is called at the very end of the write.  We
    check every 2 s and give up after 30 s.
    """

    def __init__(self, source_id: str, source):
        super().__init__()
        self.source_id     = source_id
        self.source        = source
        self._emitted_stores: set[Path] = set()
        self._stores_lock  = threading.Lock()

    def on_created(self, event):
        path = Path(event.src_path)
        print(f"[watcher] on_created: is_dir={event.is_directory} suffix={path.suffix!r} name={path.name!r} src={self.source_id}")

        # Zarr stores are directories.  Schedule a completion poll.
        if event.is_directory and path.suffix == ".zarr":
            vt = self.source._extract_time(path.name)
            print(f"[watcher] zarr dir detected, _extract_time={vt}")
            if vt is not None:
                self._schedule_zarr_check(path, vt)
            return

        # Skip all other directory events.
        if event.is_directory:
            return

        # Regular flat-file source: emit immediately.
        vt = self.source._extract_time(path.name)
        if vt is None:
            return
        self._emit(path, vt)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _schedule_zarr_check(self, store_path: Path, vt, attempt: int = 0):
        """
        Poll store_path until the zarr store is ready to serve, then fire.

        ── zarr v3 stores (zarr.json) ────────────────────────────────────────
        zarr.json with consolidated_metadata is written as the very last step
        of the Python ingest pipeline.  We poll every 2 s and give up after
        15 attempts (~30 s).

        ── zarr v2 stores (.zgroup) ─────────────────────────────────────────
        zarr v2 has no consolidated metadata file.  The 2-second initial delay
        is sufficient — by the time the first check fires, the store is complete.
        We just verify .zgroup exists (written as the first file in the store).
        """
        def check():
            print(f"[watcher] Polling zarr check attempt={attempt} store={store_path.name}")
            with self._stores_lock:
                if store_path in self._emitted_stores:
                    print(f"[watcher] Already emitted for {store_path.name}, skipping")
                    return

            zarr_json = store_path / "zarr.json"
            zgroup    = store_path / ".zgroup"

            if zarr_json.exists():
                # ── zarr v3: wait for consolidated_metadata ──────────────────
                print(f"[watcher] zarr.json exists={zarr_json.exists()}")
                ready = False
                try:
                    with open(zarr_json) as f:
                        meta = json.load(f)
                    ready = "consolidated_metadata" in meta
                    print(f"[watcher] consolidated_metadata present={ready}")
                except Exception as exc:
                    print(f"[watcher] Error reading zarr.json: {exc}")

                if ready:
                    print(f"[watcher] READY (v3) — emitting event for {store_path.name}")
                    with self._stores_lock:
                        self._emitted_stores.add(store_path)
                    self._emit(store_path, vt)
                elif attempt < 14:
                    threading.Timer(
                        2.0,
                        lambda: self._schedule_zarr_check(store_path, vt, attempt + 1),
                    ).start()
                else:
                    print(f"[watcher] Timed out waiting for zarr store to be ready: {store_path}")

            elif zgroup.exists():
                # ── zarr v2: .zgroup present — store is ready ────────────────
                print(f"[watcher] READY (v2) — emitting event for {store_path.name}")
                with self._stores_lock:
                    self._emitted_stores.add(store_path)
                self._emit(store_path, vt)

            elif attempt < 14:
                # Neither format marker present yet — store directory just created
                print(f"[watcher] zarr store not ready yet (attempt {attempt}), retrying…")
                threading.Timer(
                    2.0,
                    lambda: self._schedule_zarr_check(store_path, vt, attempt + 1),
                ).start()
            else:
                print(f"[watcher] Timed out waiting for zarr store to be ready: {store_path}")

        threading.Timer(2.0, check).start()

    def _emit(self, path: Path, vt):
        key = self.source._make_key(vt)
        event_data = {
            "source_id"  : self.source_id,
            "key"        : key,
            "valid_time" : vt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "filename"   : path.name,
            "size_bytes" : path.stat().st_size if path.exists() else None,
        }
        if _loop is None:
            return
        # Fan-out: deliver to every connected client's private queue.
        with _client_queues_lock:
            queues = list(_client_queues)
        for q in queues:
            try:
                _loop.call_soon_threadsafe(q.put_nowait, event_data)
            except asyncio.QueueFull:
                pass  # Slow client; drop rather than block the watcher thread


def start_watching():
    """
    Start watching all configured data source directories.
    Call this once at API startup (from main.py's startup event).
    """
    global _loop
    _loop = asyncio.get_event_loop()

    observer = Observer()

    for source_id, source in SOURCES.items():
        data_dir = getattr(source, '_data_dir', None)
        if data_dir is None:
            continue   # DB-backed or non-filesystem source; nothing to watch
        if not data_dir.exists():
            print(f"[watcher] Warning: {data_dir} does not exist, skipping.")
            continue

        handler = NewFileHandler(source_id, source)
        observer.schedule(handler, str(data_dir), recursive=False)
        print(f"[watcher] Watching {data_dir} for {source_id}")

    observer.start()
    print("[watcher] File system watcher started.")
    return observer


async def _poll_db_source(source_id: str, source, interval_seconds: int) -> None:
    """Poll MAX(valid_time) for one DB source and emit an event when it advances."""
    from sqlalchemy import text
    from .db.engine import get_engine

    engine = get_engine()
    last_seen: datetime | None = None

    print(f"[db-watcher] Polling {source_id} every {interval_seconds}s")

    while True:
        await asyncio.sleep(interval_seconds)
        try:
            table = getattr(source, 'table', 'points')
            time_column = getattr(source, 'time_column', 'valid_time')
            sql   = text(
                f"SELECT MAX({time_column}) FROM {table} WHERE source_id = :sid"
            )
            async with engine.connect() as conn:
                latest = await conn.scalar(sql, {"sid": source_id})

            if latest is None:
                continue

            # Ensure timezone-aware for comparison
            if latest.tzinfo is None:
                latest = latest.replace(tzinfo=timezone.utc)

            if last_seen is None or latest > last_seen:
                last_seen = latest
                key = latest.strftime("%Y%m%d_%H%M")
                event_data = {
                    "source_id" : source_id,
                    "key"       : key,
                    "valid_time": latest.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "filename"  : None,   # no file — DB row
                    "size_bytes": None,
                }
                with _client_queues_lock:
                    queues = list(_client_queues)
                for q in queues:
                    try:
                        q.put_nowait(event_data)
                    except asyncio.QueueFull:
                        pass
                print(f"[db-watcher] {source_id} new time: {key}")
        except Exception as exc:
            # Non-fatal: log and continue polling
            print(f"[db-watcher] {source_id} poll error: {exc}")


def start_db_polling(interval_seconds: int = 30) -> list[asyncio.Task]:
    """
    Start async polling tasks for all DB-backed sources in SOURCES.

    Returns the list of created Tasks so main.py can cancel them on shutdown.
    Call this from within an async context (e.g. FastAPI lifespan).
    """
    from .sources.types.db_source import (
        PointDBSource,
        ProfileDBSource,
        CycloneTrackDBSource,
    )  # avoid circular import at module load

    tasks = []
    for source_id, source in SOURCES.items():
        if not isinstance(source, (PointDBSource, ProfileDBSource, CycloneTrackDBSource)):
            continue
        task = asyncio.create_task(
            _poll_db_source(source_id, source, interval_seconds),
            name=f"db-watcher-{source_id}",
        )
        tasks.append(task)

    if tasks:
        print(f"[db-watcher] Started {len(tasks)} DB polling task(s).")
    return tasks

