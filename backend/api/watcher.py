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
import re
from datetime import datetime, timezone
from pathlib import Path

from watchdog.events import FileSystemEventHandler, FileCreatedEvent
from watchdog.observers import Observer

from .sources.registry import SOURCES

# The shared asyncio Queue that SSE clients read from.
# It's a "broadcast" queue — all connected clients share the same queue,
# so every connected browser gets notified about every new file.
_event_queue: asyncio.Queue | None = None
_loop: asyncio.AbstractEventLoop | None = None


def get_event_queue() -> asyncio.Queue:
    """Return the shared event queue, creating it if necessary."""
    global _event_queue
    if _event_queue is None:
        _event_queue = asyncio.Queue(maxsize=500)
    return _event_queue


class NewFileHandler(FileSystemEventHandler):
    """
    Handles file system events from watchdog.
    Runs in a background thread — must not call async functions directly.
    """

    def __init__(self, source_id: str, source):
        super().__init__()
        self.source_id = source_id
        self.source    = source

    def on_created(self, event: FileCreatedEvent):
        """Called by watchdog (in its thread) when a new file appears."""
        if event.is_directory:
            return

        path = Path(event.src_path)

        # Check that the filename matches this source's pattern
        times = []  # We'll do a quick regex check without the full async scan
        vt = self.source._extract_time(path.name)
        if vt is None:
            return  # Doesn't match this source's pattern

        key   = self.source._make_key(vt)
        event_data = {
            "source_id"  : self.source_id,
            "key"        : key,
            "valid_time" : vt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "filename"   : path.name,
            "size_bytes" : path.stat().st_size if path.exists() else None,
        }

        # Thread-safe: put the event onto the asyncio queue from this thread
        if _loop is not None and _event_queue is not None:
            _loop.call_soon_threadsafe(_event_queue.put_nowait, event_data)


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
    queue = get_event_queue()

    print(f"[db-watcher] Polling {source_id} every {interval_seconds}s")

    while True:
        await asyncio.sleep(interval_seconds)
        try:
            table = getattr(source, 'table', 'points')
            sql   = text(
                f"SELECT MAX(valid_time) FROM {table} WHERE source_id = :sid"
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
                try:
                    queue.put_nowait(event_data)
                    print(f"[db-watcher] {source_id} new time: {key}")
                except asyncio.QueueFull:
                    pass   # drop silently; clients will catch up on next poll
        except Exception as exc:
            # Non-fatal: log and continue polling
            print(f"[db-watcher] {source_id} poll error: {exc}")


def start_db_polling(interval_seconds: int = 30) -> list[asyncio.Task]:
    """
    Start async polling tasks for all DB-backed sources in SOURCES.

    Returns the list of created Tasks so main.py can cancel them on shutdown.
    Call this from within an async context (e.g. FastAPI lifespan).
    """
    from .sources.types.db_source import PointDBSource   # avoid circular import at module load

    tasks = []
    for source_id, source in SOURCES.items():
        if not isinstance(source, PointDBSource):
            continue
        task = asyncio.create_task(
            _poll_db_source(source_id, source, interval_seconds),
            name=f"db-watcher-{source_id}",
        )
        tasks.append(task)

    if tasks:
        print(f"[db-watcher] Started {len(tasks)} DB polling task(s).")
    return tasks

