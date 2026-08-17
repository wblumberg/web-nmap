"""Small, bounded request window for the in-app diagnostics panel.

Prometheus remains the durable metrics store.  This module retains only enough
recent request detail to correlate a browser session with backend behavior.
"""

from __future__ import annotations

import itertools
import threading
import time
import uuid
from collections import Counter, deque
from dataclasses import dataclass
from typing import Any

from .grid_cache import CACHE_HITS, CACHE_MISSES, grid_cache

_MAX_REQUESTS = 500


@dataclass(frozen=True)
class RequestToken:
    request_id: str
    started: float


class BackendDiagnostics:
    """Thread-safe bounded request recorder with cheap snapshot aggregation."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._instance_id = uuid.uuid4().hex[:12]
        self._started_at = time.time()
        self._sequence = itertools.count(1)
        self._requests: deque[dict[str, Any]] = deque(maxlen=_MAX_REQUESTS)
        self._active = 0
        self._total_requests = 0
        self._total_errors = 0
        self._total_bytes = 0

    def start(self) -> RequestToken:
        with self._lock:
            self._active += 1
        return RequestToken(uuid.uuid4().hex[:12], time.perf_counter())

    def finish(
        self, token: RequestToken, *, method: str, endpoint: str,
        status: int, source_id: str, variable_group: str,
        ttfb_ms: float, response_bytes: int, completed: bool = True,
    ) -> None:
        elapsed_ms = (time.perf_counter() - token.started) * 1000
        with self._lock:
            self._active = max(0, self._active - 1)
            sequence = next(self._sequence)
            record = {
                "sequence": sequence,
                "request_id": token.request_id,
                "timestamp": time.time(),
                "method": method,
                "endpoint": endpoint,
                "status": status,
                "source_id": source_id,
                "variable_group": variable_group,
                "ttfb_ms": round(ttfb_ms, 3),
                "duration_ms": round(elapsed_ms, 3),
                "response_bytes": response_bytes,
                "completed": completed,
            }
            self._requests.append(record)
            self._total_requests += 1
            self._total_bytes += response_bytes
            if status >= 400 or not completed:
                self._total_errors += 1

    def snapshot(self, since_sequence: int = 0, recent_limit: int | None = None) -> dict[str, Any]:
        with self._lock:
            window = list(self._requests)
            if recent_limit is not None:
                recent = [item.copy() for item in window[-max(0, recent_limit):]]
            else:
                recent = [item.copy() for item in window if item["sequence"] > since_sequence]
            active = self._active
            totals = {
                "requests": self._total_requests,
                "errors": self._total_errors,
                "response_bytes": self._total_bytes,
            }

        durations = sorted(item["duration_ms"] for item in window)
        ttfb = sorted(item["ttfb_ms"] for item in window)
        counts = Counter(item["endpoint"] for item in window)

        def percentile(values: list[float], fraction: float) -> float | None:
            if not values:
                return None
            return values[int((len(values) - 1) * fraction)]

        return {
            "instance_id": self._instance_id,
            "started_at": self._started_at,
            "captured_at": time.time(),
            "active_requests": active,
            "latest_sequence": window[-1]["sequence"] if window else since_sequence,
            "totals": totals,
            "window": {
                "capacity": _MAX_REQUESTS,
                "request_count": len(window),
                "error_count": sum(item["status"] >= 400 or not item["completed"] for item in window),
                "response_bytes": sum(item["response_bytes"] for item in window),
                "latency_ms": {
                    "average": sum(durations) / len(durations) if durations else None,
                    "p50": percentile(durations, .5),
                    "p95": percentile(durations, .95),
                    "maximum": durations[-1] if durations else None,
                },
                "ttfb_ms": {
                    "average": sum(ttfb) / len(ttfb) if ttfb else None,
                    "p95": percentile(ttfb, .95),
                },
                "top_endpoints": counts.most_common(8),
            },
            "grid_cache": {
                "entries": grid_cache.entry_count,
                "bytes": grid_cache.current_bytes,
                "max_bytes": grid_cache.max_bytes,
                "hits": int(CACHE_HITS._value.get()),
                "misses": int(CACHE_MISSES._value.get()),
            },
            "requests": recent,
        }


backend_diagnostics = BackendDiagnostics()
