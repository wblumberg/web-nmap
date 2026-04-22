"""
routers/events.py — Server-Sent Events (SSE) for real-time notifications

This is how the API tells WebNMAP "new data just arrived, refresh your loop."

─── What are Server-Sent Events? ────────────────────────────────────────────
SSE is a one-way push channel from server → browser over a normal HTTP
connection. The browser opens one persistent GET request to /api/v1/events
and the server streams lines of text as data becomes available.

Unlike WebSockets, SSE:
  - Is one-directional (server → client only)
  - Works over plain HTTP (no upgrade needed)
  - Automatically reconnects if the connection drops
  - Is natively supported by every modern browser (EventSource API)

─── How WebNMAP uses this ───────────────────────────────────────────────────
The JavaScript frontend opens:
    const es = new EventSource('/api/v1/events/data');

When a new MRMS file lands on disk, the API sends:
    event: new_data
    data: {"source_id": "MRMS", "key": "20250302_1802", "valid_time": "..."}

The frontend receives this and calls:
    PanelManager.handleNewData(event.data)
    → which triggers a new fetch and extends the MultiPlotLayer

─── How new files are detected ──────────────────────────────────────────────
The watcher.py module uses the `watchdog` library to monitor directories.
When a new file appears, it publishes to an asyncio Queue.
The SSE endpoint reads from that Queue and streams events to connected clients.
"""

import asyncio
import json
from datetime import datetime, timezone
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..watcher import register_client_queue, unregister_client_queue

router = APIRouter(tags=["Events"])


@router.get("/data")
async def stream_data_events(request: Request):
    """
    SSE stream: notifies the browser when new data files arrive.

    Connect with JavaScript:
        const es = new EventSource('/api/v1/events/data');
        es.addEventListener('new_data', (e) => {
            const info = JSON.parse(e.data);
            console.log('New data:', info.source_id, info.key);
            // Trigger a refresh of that source's slot
        });
        es.addEventListener('heartbeat', () => {
            // Connection is alive (sent every 30s)
        });
    """
    return StreamingResponse(
        _event_generator(request),
        media_type = "text/event-stream",
        headers    = {
            "Cache-Control"    : "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering if behind a proxy
        },
    )


async def _event_generator(request: Request) -> AsyncGenerator[str, None]:
    """
    Async generator that yields SSE-formatted strings.

    SSE format:
        event: <event_type>\n
        data: <json_string>\n
        \n

    The double newline marks the end of one event.
    """
    queue = register_client_queue()
    try:
        # Send an initial connected confirmation
        yield _sse_event("connected", {"status": "ok", "message": "WebNMAP event stream connected"})

        while True:
            # Check if the client disconnected (browser closed tab, etc.)
            if await request.is_disconnected():
                break

            try:
                # Wait up to 30 seconds for a new event.
                # If nothing arrives, send a heartbeat to keep the connection alive.
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
                yield _sse_event("new_data", event)

            except asyncio.TimeoutError:
                # No new data in 30s — send a heartbeat so the browser knows
                # the connection is still open
                yield _sse_event("heartbeat", {"time": datetime.now(timezone.utc).isoformat()})

            except asyncio.CancelledError:
                break
    finally:
        unregister_client_queue(queue)


def _sse_event(event_type: str, data: dict) -> str:
    """Format a dict as an SSE event string."""
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
