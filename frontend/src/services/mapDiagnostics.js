const MAX_EVENTS = 400;
const MAX_SNAPSHOTS = 600;
const BACKEND_INSTANCE_RETENTION_MS = 10 * 60 * 1000;
const events = [];
const snapshots = [];
const backendSnapshots = [];
const backendInstanceSnapshots = [];
const backendRequests = [];
const latestBackendByInstance = new Map();
let backendPollStatus = {
    attempts: 0, successes: 0, failures: 0,
    lastAttemptAt: null, lastSuccessAt: null, lastErrorAt: null,
    lastError: null, backendInstanceId: null,
};
const listeners = new Set();
let snapshotProvider = () => ({});

export function estimateValueBytes(value, seen = new Set(), seenBuffers = new Set()) {
    if (value == null) return 0;
    if (typeof value === 'string') return value.length * 2;
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
        if (seenBuffers.has(value.buffer)) return 0;
        seenBuffers.add(value.buffer);
        return value.buffer.byteLength;
    }
    if (value instanceof ArrayBuffer) {
        if (seenBuffers.has(value)) return 0;
        seenBuffers.add(value);
        return value.byteLength;
    }
    let bytes = 0;
    if (value instanceof Map) {
        for (const [key, child] of value) {
            bytes += estimateValueBytes(key, seen, seenBuffers);
            bytes += estimateValueBytes(child, seen, seenBuffers);
        }
        return bytes;
    }
    if (value instanceof Set) {
        for (const child of value) bytes += estimateValueBytes(child, seen, seenBuffers);
        return bytes;
    }
    for (const [key, child] of Object.entries(value)) {
        if (key === 'grid' || key === 'map' || key === 'gl' || key === 'gl_elems') continue;
        bytes += key.length * 2 + estimateValueBytes(child, seen, seenBuffers);
    }
    return bytes;
}

export function recordDiagnostic(type, details = {}) {
    const event = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        timestamp: new Date().toISOString(),
        type,
        ...details,
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    listeners.forEach(listener => listener(event));
    return event;
}

export function getDiagnosticEvents() { return events.slice(); }
export function clearDiagnosticEvents() {
    events.length = 0;
    listeners.forEach(listener => listener(null));
}
export function subscribeDiagnostics(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
export function setDiagnosticSnapshotProvider(provider) {
    snapshotProvider = typeof provider === 'function' ? provider : () => ({});
}
export function getDiagnosticSnapshot() {
    return {capturedAt: new Date().toISOString(), ...snapshotProvider()};
}

export function sampleDiagnosticSnapshot() {
    const snapshot = getDiagnosticSnapshot();
    snapshots.push(snapshot);
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.splice(0, snapshots.length - MAX_SNAPSHOTS);
    return snapshot;
}

export function getDiagnosticSnapshots() { return snapshots.slice(); }
export function clearDiagnosticSnapshots() { snapshots.length = 0; }
export function getBackendDiagnosticSnapshots() { return backendSnapshots.slice(); }
export function getBackendInstanceSnapshots() { return backendInstanceSnapshots.slice(); }
export function getBackendDiagnosticRequests() { return backendRequests.slice(); }
export function getBackendDiagnosticPollStatus() { return {...backendPollStatus}; }
export function recordBackendDiagnosticPoll({ok, error = null, backendInstanceId = null} = {}) {
    const now = new Date().toISOString();
    backendPollStatus.attempts++;
    backendPollStatus.lastAttemptAt = now;
    if (ok) {
        backendPollStatus.successes++;
        backendPollStatus.lastSuccessAt = now;
        backendPollStatus.lastError = null;
        if (backendInstanceId) backendPollStatus.backendInstanceId = backendInstanceId;
    } else {
        backendPollStatus.failures++;
        backendPollStatus.lastErrorAt = now;
        backendPollStatus.lastError = error || 'Unknown backend diagnostics polling error';
    }
    return getBackendDiagnosticPollStatus();
}
export function recordBackendDiagnosticSnapshot(report) {
    if (!report || typeof report !== 'object') return null;
    const snapshot = {
        ...report,
        capturedAt: new Date(Number(report.captured_at) * 1000 || Date.now()).toISOString(),
    };
    const instanceId = report.instance_id || 'legacy';
    backendInstanceSnapshots.push(snapshot);
    if (backendInstanceSnapshots.length > 240) backendInstanceSnapshots.splice(0, backendInstanceSnapshots.length - 240);
    latestBackendByInstance.set(instanceId, snapshot);
    const known = new Set(backendRequests.map(request => `${request.backend_instance_id || 'legacy'}:${request.sequence}`));
    for (const request of report.requests || []) {
        const requestKey = `${instanceId}:${request.sequence}`;
        if (!known.has(requestKey)) backendRequests.push({...request, backend_instance_id: instanceId});
    }
    if (backendRequests.length > 1000) backendRequests.splice(0, backendRequests.length - 1000);

    // A process behind a multi-worker load balancer may not answer a polling
    // request for several minutes even though it is still healthy. Keep it for
    // the same ten-minute window as the frontend timeline to avoid process
    // counts and aggregate totals oscillating with load-balancer selection.
    const cutoffMs = Date.now() - BACKEND_INSTANCE_RETENTION_MS;
    const activeInstances = [...latestBackendByInstance.entries()]
        .filter(([, item]) => Date.parse(item.capturedAt) >= cutoffMs);
    for (const [id, item] of latestBackendByInstance) {
        if (Date.parse(item.capturedAt) < cutoffMs) latestBackendByInstance.delete(id);
    }
    const sum = getter => activeInstances.reduce((total, [, item]) => total + (Number(getter(item)) || 0), 0);
    const requestCount = sum(item => item.window?.request_count);
    const weightedLatency = requestCount ? activeInstances.reduce((total, [, item]) =>
        total + (Number(item.window?.latency_ms?.average) || 0) * (Number(item.window?.request_count) || 0), 0) / requestCount : null;
    const weightedTtfb = requestCount ? activeInstances.reduce((total, [, item]) =>
        total + (Number(item.window?.ttfb_ms?.average) || 0) * (Number(item.window?.request_count) || 0), 0) / requestCount : null;
    const maximum = getter => {
        const values = activeInstances.map(([, item]) => Number(getter(item))).filter(Number.isFinite);
        return values.length ? Math.max(...values) : null;
    };
    const endpoints = new Map();
    for (const [, item] of activeInstances) {
        for (const [endpoint, count] of item.window?.top_endpoints || []) {
            endpoints.set(endpoint, (endpoints.get(endpoint) || 0) + (Number(count) || 0));
        }
    }
    const aggregate = {
        capturedAt: new Date().toISOString(),
        captured_at: Date.now() / 1000,
        aggregated: true,
        instance_count: activeInstances.length,
        instance_ids: activeInstances.map(([id]) => id),
        active_requests: sum(item => item.active_requests),
        totals: {
            requests: sum(item => item.totals?.requests),
            errors: sum(item => item.totals?.errors),
            response_bytes: sum(item => item.totals?.response_bytes),
        },
        window: {
            capacity: sum(item => item.window?.capacity),
            request_count: requestCount,
            error_count: sum(item => item.window?.error_count),
            response_bytes: sum(item => item.window?.response_bytes),
            latency_ms: {
                average: weightedLatency,
                p50: maximum(item => item.window?.latency_ms?.p50),
                p95: maximum(item => item.window?.latency_ms?.p95),
                maximum: maximum(item => item.window?.latency_ms?.maximum),
            },
            ttfb_ms: {
                average: weightedTtfb,
                p95: maximum(item => item.window?.ttfb_ms?.p95),
            },
            top_endpoints: [...endpoints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
            percentile_note: 'Aggregated percentiles are the maximum reported by any active backend process.',
        },
        grid_cache: {
            entries: sum(item => item.grid_cache?.entries),
            bytes: sum(item => item.grid_cache?.bytes),
            // Every backend worker owns an independent cache configured with
            // the same limit. Present max_bytes as the configured per-process
            // limit instead of making a four-worker deployment look like one
            // 2 GiB cache. Keep the theoretical aggregate ceiling explicit for
            // capacity planning without conflating it with cache configuration.
            max_bytes: maximum(item => item.grid_cache?.max_bytes),
            max_bytes_per_process: maximum(item => item.grid_cache?.max_bytes),
            aggregate_max_bytes: sum(item => item.grid_cache?.max_bytes),
            capacity_scope: 'per-process',
            process_count: activeInstances.length,
            hits: sum(item => item.grid_cache?.hits),
            misses: sum(item => item.grid_cache?.misses),
        },
    };
    backendSnapshots.push(aggregate);
    if (backendSnapshots.length > 120) backendSnapshots.splice(0, backendSnapshots.length - 120);
    return aggregate;
}
export function clearBackendDiagnostics() {
    backendSnapshots.length = 0;
    backendInstanceSnapshots.length = 0;
    backendRequests.length = 0;
    latestBackendByInstance.clear();
    backendPollStatus = {
        attempts: 0, successes: 0, failures: 0,
        lastAttemptAt: null, lastSuccessAt: null, lastErrorAt: null,
        lastError: null, backendInstanceId: null,
    };
}

function numericValues(path) {
    return snapshots.map(snapshot => path.split('.').reduce((value, key) => value?.[key], snapshot))
        .map(Number).filter(Number.isFinite);
}

function metricSummary(path) {
    const values = numericValues(path);
    if (!values.length) return null;
    return {
        first: values[0],
        latest: values.at(-1),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        change: values.at(-1) - values[0],
    };
}

/** Build a portable, versioned diagnostics report without mutating history. */
export function buildDiagnosticExport() {
    const durations = events.map(event => Number(event.durationMs)).filter(Number.isFinite).sort((a, b) => a - b);
    const eventTypeCounts = events.reduce((counts, event) => {
        counts[event.type] = (counts[event.type] || 0) + 1;
        return counts;
    }, {});
    const percentile = fraction => durations.length
        ? durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * fraction))]
        : null;
    return {
        schema: 'web-nmap-map-diagnostics',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        retention: {targetSnapshotIntervalMs: 1000, samplingPolicy: 'browser-idle', maximumSnapshots: MAX_SNAPSHOTS, maximumEvents: MAX_EVENTS},
        notes: {
            fieldCache: 'Decoded protobuf/JSON gridded fields only; Zarr-transport products are counted under zarrCache.',
            memory: 'Released references may not immediately reduce browser memory because garbage collection and GPU cleanup are asynchronous.',
        },
        summary: {
            sampleCount: snapshots.length,
            eventCount: events.length,
            eventTypeCounts,
            totalReclaimedBytes: events.reduce((sum, event) => sum + (Number(event.reclaimedBytes) || 0), 0),
            latencyMs: durations.length ? {
                count: durations.length,
                average: durations.reduce((sum, value) => sum + value, 0) / durations.length,
                p50: percentile(0.5), p95: percentile(0.95), maximum: durations.at(-1),
            } : null,
            trends: {
                usedJSHeapBytes: metricSummary('browserMemory.usedJSHeapSize'),
                cpuTypedArrayBytes: metricSummary('cpuTypedArrayBytes'),
                gpuResourceCount: metricSummary('gpuResourceCount'),
                gpuResourceBytes: metricSummary('gpuResourceBytes'),
                cpuReleasedAfterUploadBytes: metricSummary('cpuReleasedAfterUploadBytes'),
                geometryRetainedBytes: metricSummary('geometry.retainedBytes'),
                geometrySharedBytes: metricSummary('geometry.sharedBytes'),
                fieldCacheBytes: metricSummary('caches.field.bytes'),
                zarrCacheBytes: metricSummary('caches.zarr.bytes'),
                pointCacheBytes: metricSummary('caches.point.bytes'),
                totalCacheBytes: metricSummary('totalCacheBytes'),
            },
        },
        currentSnapshot: getDiagnosticSnapshot(),
        snapshots: getDiagnosticSnapshots(),
        events: getDiagnosticEvents(),
        backend: {
            pollStatus: getBackendDiagnosticPollStatus(),
            snapshots: getBackendDiagnosticSnapshots(),
            instanceSnapshots: getBackendInstanceSnapshots(),
            requests: getBackendDiagnosticRequests(),
        },
    };
}
