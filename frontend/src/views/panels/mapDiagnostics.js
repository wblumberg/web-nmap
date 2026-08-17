import {
    clearDiagnosticEvents,
    clearDiagnosticSnapshots,
    buildDiagnosticExport,
    clearBackendDiagnostics,
    getBackendDiagnosticRequests,
    getBackendDiagnosticSnapshots,
    getBackendDiagnosticPollStatus,
    recordBackendDiagnosticSnapshot,
    recordBackendDiagnosticPoll,
    getDiagnosticEvents,
    getDiagnosticSnapshot,
    getDiagnosticSnapshots,
    sampleDiagnosticSnapshot,
    subscribeDiagnostics,
} from '../../services/mapDiagnostics.js';

let panel;
let unsubscribe;
let timer;
let idleHandle;
let backendTimer;
let backendAbort;
let backendTimeout;
let backendInFlight = false;
let backendError = '';
let backendSequence = 0;
let backendInstanceId = null;
let backendInstanceFilter = 'all';
let paused = false;
let eventTypeFilter = 'all';
let eventTextFilter = '';
let renderedEventKey = '';
let activeTab = 'overview';
let latestSnapshot;

const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function bytesLabel(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function durationLabel(ms) {
    if (!Number.isFinite(Number(ms))) return '—';
    return Number(ms) < 1000 ? `${Number(ms).toFixed(1)} ms` : `${(Number(ms) / 1000).toFixed(2)} s`;
}

function detailLabel(event) {
    return [event.source, event.product, event.key, event.message].filter(Boolean).join(' · ') || '—';
}

function downloadText(filename, text, mimeType) {
    const url = URL.createObjectURL(new Blob([text], {type: mimeType}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportFilename(extension) {
    return `web-nmap-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

function exportJson() {
    downloadText(exportFilename('json'), JSON.stringify(buildDiagnosticExport(), null, 2), 'application/json');
}

function csvCell(value) {
    const text = value == null ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
    const headers = ['timestamp', 'used_js_heap_bytes', 'total_js_heap_bytes', 'cpu_typed_array_bytes', 'gpu_resource_bytes', 'gpu_resources', 'cpu_released_after_upload_bytes', 'geometry_retained_bytes', 'geometry_shared_bytes', 'geometry_features', 'geometry_coordinates', 'timeline_frames', 'layer_frames', 'field_cache_bytes', 'zarr_cache_bytes', 'point_cache_bytes', 'total_cache_bytes'];
    const rows = getDiagnosticSnapshots().map(snapshot => [
        snapshot.capturedAt, snapshot.browserMemory?.usedJSHeapSize, snapshot.browserMemory?.totalJSHeapSize,
        snapshot.cpuTypedArrayBytes, snapshot.gpuResourceBytes, snapshot.gpuResourceCount, snapshot.cpuReleasedAfterUploadBytes,
        snapshot.geometry?.retainedBytes, snapshot.geometry?.sharedBytes, snapshot.geometry?.featureCount, snapshot.geometry?.coordinateCount,
        snapshot.timelineFrames, snapshot.layerFrames,
        snapshot.caches?.field?.bytes, snapshot.caches?.zarr?.bytes, snapshot.caches?.point?.bytes, snapshot.totalCacheBytes,
    ].map(csvCell).join(','));
    downloadText(exportFilename('csv'), [headers.join(','), ...rows].join('\n'), 'text/csv');
}

const metricValue = (sample, path) => path.split('.').reduce((value, key) => value?.[key], sample);

const CHARTS = [
    {
        title: 'Memory usage', unit: 'bytes',
        series: [
            {label: 'JS heap', path: 'browserMemory.usedJSHeapSize', color: '#ffcc66'},
            {label: 'CPU arrays', path: 'cpuTypedArrayBytes', color: '#68d5ff'},
            {label: 'GPU textures', path: 'gpuResourceBytes', color: '#e599f7'},
            {label: 'Geometry objects', path: 'geometry.retainedBytes', color: '#51cf66'},
        ],
    },
    {
        title: 'Frames and GPU resources', unit: 'count',
        series: [
            {label: 'GPU resources', path: 'gpuResourceCount', color: '#e599f7'},
            {label: 'Layer frames', path: 'layerFrames', color: '#74c0fc'},
            {label: 'Timeline frames', path: 'timelineFrames', color: '#ffd43b'},
        ],
    },
    {
        title: 'Cache usage', unit: 'bytes',
        series: [
            {label: 'Field', path: 'caches.field.bytes', color: '#63e6be'},
            {label: 'Zarr', path: 'caches.zarr.bytes', color: '#da77f2'},
            {label: 'Point/profile', path: 'caches.point.bytes', color: '#ff8787'},
        ],
    },
];

function compactNumber(value, unit) {
    if (unit === 'bytes') return bytesLabel(value);
    if (unit === 'ms') return durationLabel(value);
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
}

function drawLineChart(canvas, chart, samples, timeRange) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(280, Math.floor(rect.width));
    const height = Math.max(150, Math.floor(rect.height));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const pad = {left: 58, right: 12, top: 12, bottom: 23};
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const startTime = timeRange?.start ?? new Date(samples[0]?.capturedAt ?? 0).getTime();
    const endTime = timeRange?.end ?? new Date(samples.at(-1)?.capturedAt ?? 1).getTime();
    const values = samples.flatMap(sample => chart.series.map(series => Number(metricValue(sample, series.path)) || 0));
    const maxValue = Math.max(1, ...values) * 1.08;
    ctx.font = '10px monospace';
    ctx.strokeStyle = '#303052';
    ctx.fillStyle = '#8585a5';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = pad.top + plotHeight * i / 4;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
        ctx.fillText(compactNumber(maxValue * (1 - i / 4), chart.unit), 4, y + 3);
    }
    canvas._chartMeta = {samples, chart, pad, plotWidth, startTime, endTime};
    if (samples.length < 2) {
        ctx.fillStyle = '#777796';
        ctx.fillText('Collecting samples…', pad.left + 12, pad.top + plotHeight / 2);
        return;
    }
    chart.series.forEach(series => {
        ctx.beginPath();
        ctx.strokeStyle = series.color;
        ctx.lineWidth = 1.5;
        samples.forEach((sample, index) => {
            const sampleTime = new Date(sample.capturedAt).getTime();
            const x = pad.left + plotWidth * (sampleTime - startTime) / Math.max(1, endTime - startTime);
            const value = Number(metricValue(sample, series.path)) || 0;
            const y = pad.top + plotHeight * (1 - value / maxValue);
            if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });
    ctx.fillStyle = '#8585a5';
    ctx.fillText(new Date(startTime).toLocaleTimeString(), pad.left, height - 5);
    const end = new Date(endTime).toLocaleTimeString();
    ctx.fillText(end, width - pad.right - ctx.measureText(end).width, height - 5);
}

function drawLatencyChart(canvas, samples, events) {
    const chart = {title: 'Operation latency', unit: 'ms', series: [{label: 'Duration', path: 'durationMs', color: '#ff922b'}]};
    if (!samples.length) return drawLineChart(canvas, chart, []);
    const start = new Date(samples[0].capturedAt).getTime();
    const end = new Date(samples.at(-1).capturedAt).getTime();
    const timed = events.filter(event => Number.isFinite(Number(event.durationMs)) && new Date(event.timestamp).getTime() >= start)
        .map(event => ({capturedAt: event.timestamp, durationMs: Number(event.durationMs), event}));
    drawLineChart(canvas, chart, timed.length > 1 ? timed : [], {start, end});
    canvas._chartMeta = {...(canvas._chartMeta || {}), samples: timed, chart};
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const markerEvents = events.filter(event => /frame-added|frame-purged|auto-update-complete/.test(event.type) && new Date(event.timestamp).getTime() >= start);
    markerEvents.forEach(event => {
        const x = 58 + (width - 70) * (new Date(event.timestamp).getTime() - start) / Math.max(1, end - start);
        ctx.fillStyle = event.type === 'frame-purged' ? '#ff6b6b' : event.type === 'frame-added' ? '#51cf66' : '#74c0fc';
        ctx.fillRect(x - 1, height - 20, 3, 8);
    });
}

function renderTimeline() {
    const samples = getDiagnosticSnapshots();
    const events = getDiagnosticEvents();
    CHARTS.forEach((chart, index) => drawLineChart(panel.querySelector(`#md-chart-${index}`), chart, samples));
    drawLatencyChart(panel.querySelector('#md-chart-latency'), samples, events);
    panel.querySelector('.md-history-status').textContent = `${samples.length} samples · ${samples.length ? `${new Date(samples[0].capturedAt).toLocaleTimeString()}–${new Date(samples.at(-1).capturedAt).toLocaleTimeString()}` : 'waiting'}`;
}

const BACKEND_CHARTS = [
    {title: 'Backend latency', unit: 'ms', series: [
        {label: 'Average', path: 'window.latency_ms.average', color: '#74c0fc'},
        {label: 'p95', path: 'window.latency_ms.p95', color: '#ff922b'},
        {label: 'TTFB p95', path: 'window.ttfb_ms.p95', color: '#e599f7'},
    ]},
    {title: 'Backend cache', unit: 'bytes', series: [
        {label: 'Grid cache', path: 'grid_cache.bytes', color: '#63e6be'},
    ]},
    {title: 'Request activity', unit: 'count', series: [
        {label: 'Active', path: 'active_requests', color: '#ffd43b'},
        {label: 'Window errors', path: 'window.error_count', color: '#ff6b6b'},
    ]},
];

function renderBackend() {
    const snapshots = getBackendDiagnosticSnapshots();
    const latest = snapshots.at(-1);
    const status = panel.querySelector('.md-backend-status');
    if (!latest) {
        const poll = getBackendDiagnosticPollStatus();
        status.textContent = backendError || (poll.attempts
            ? `Waiting for a successful backend sample · ${poll.attempts} attempt(s)`
            : 'Waiting for the first backend sample…');
        return;
    }
    const cache = latest.grid_cache || {};
    const windowStats = latest.window || {};
    const latency = windowStats.latency_ms || {};
    const hitTotal = (cache.hits || 0) + (cache.misses || 0);
    const hitRate = hitTotal ? `${(cache.hits / hitTotal * 100).toFixed(1)}%` : 'n/a';
    panel.querySelector('.md-backend-summary').innerHTML = `
      <div><strong>${durationLabel(latency.average)}</strong><span>average latency</span></div>
      <div><strong>${durationLabel(latency.p95)}</strong><span>p95 latency</span></div>
      <div><strong>${latest.active_requests ?? 0}</strong><span>active requests</span></div>
      <div><strong>${windowStats.error_count ?? 0}</strong><span>window errors</span></div>
      <div><strong>${latest.instance_count ?? 1}</strong><span>backend processes</span></div>
      <div><strong>${bytesLabel(cache.bytes)}</strong><span>server grid cache (${cache.entries ?? 0})</span></div>
      <div><strong>${hitRate}</strong><span>grid cache hit rate</span></div>`;
    BACKEND_CHARTS.forEach((chart, index) => drawLineChart(panel.querySelector(`#md-backend-chart-${index}`), chart, snapshots));
    const allRequests = getBackendDiagnosticRequests();
    const instanceIds = [...new Set(allRequests.map(request => request.backend_instance_id).filter(Boolean))].sort();
    const instanceSelect = panel.querySelector('#md-backend-instance');
    instanceSelect.innerHTML = '<option value="all">All processes</option>' + instanceIds.map(id =>
        `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
    if (backendInstanceFilter !== 'all' && !instanceIds.includes(backendInstanceFilter)) backendInstanceFilter = 'all';
    instanceSelect.value = backendInstanceFilter;
    const requests = allRequests.filter(request =>
        backendInstanceFilter === 'all' || request.backend_instance_id === backendInstanceFilter
    ).slice(-100).reverse();
    panel.querySelector('.md-backend-requests tbody').innerHTML = requests.map(request => `
      <tr><td>${new Date(request.timestamp * 1000).toLocaleTimeString()}</td>
      <td>${escapeHtml(request.backend_instance_id)}</td><td>${escapeHtml(request.request_id)}</td><td>${escapeHtml(request.endpoint)}</td>
      <td>${escapeHtml(request.source_id)}</td><td>${request.status}</td>
      <td>${durationLabel(request.ttfb_ms)}</td><td>${durationLabel(request.duration_ms)}</td>
      <td>${bytesLabel(request.response_bytes)}</td></tr>`).join('') ||
      '<tr><td colspan="9" class="md-empty">No completed backend requests yet</td></tr>';
    status.textContent = backendError || `Updated ${new Date(latest.capturedAt).toLocaleTimeString()} · ${latest.instance_count ?? 1} process(es) · polling every 10 s while diagnostics is open`;
}

function scheduleBackendPoll(delay = 10000) {
    window.clearTimeout(backendTimer);
    if (panel?.classList.contains('hidden')) return;
    backendTimer = window.setTimeout(pollBackend, delay);
}

function pollBackend() {
    if (backendInFlight || panel?.classList.contains('hidden') || document.hidden) {
        scheduleBackendPoll();
        return;
    }
    backendInFlight = true;
    backendAbort = new AbortController();
    let timedOut = false;
    backendTimeout = window.setTimeout(() => {
        timedOut = true;
        backendAbort?.abort();
    }, 8000);
    fetch('/api/v1/diagnostics/backend?recent_limit=100', {
        signal: backendAbort.signal,
        headers: {'Accept': 'application/json'},
        cache: 'no-store',
    }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }).then(report => {
        const reportInstanceId = report.instance_id || null;
        if (backendInstanceId && reportInstanceId && backendInstanceId !== reportInstanceId) {
            backendSequence = 0;
        }
        backendInstanceId = reportInstanceId || backendInstanceId;
        const reportedSequence = Number(report.latest_sequence) || 0;
        if (reportedSequence < backendSequence) backendSequence = 0;
        else backendSequence = reportedSequence;
        backendError = '';
        recordBackendDiagnosticPoll({ok: true, backendInstanceId: reportInstanceId});
        recordBackendDiagnosticSnapshot(report);
        if (activeTab === 'backend' && !paused) renderBackend();
    }).catch(error => {
        if (error.name === 'AbortError' && !timedOut) return;
        const message = timedOut ? 'request timed out after 8 s' : error.message;
        backendError = `Backend diagnostics unavailable: ${message}`;
        recordBackendDiagnosticPoll({ok: false, error: message});
        if (activeTab === 'backend' && !paused) renderBackend();
    }).finally(() => {
        window.clearTimeout(backendTimeout);
        backendInFlight = false;
        scheduleBackendPoll();
    });
}

function setTab(tab) {
    activeTab = tab;
    panel.querySelectorAll('.md-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    panel.querySelectorAll('.md-tab-panel').forEach(view => view.classList.toggle('active', view.dataset.tabPanel === tab));
    render();
    if (tab === 'backend' && !getBackendDiagnosticSnapshots().length) scheduleBackendPoll(0);
}

function render() {
    if (!panel || paused || panel.classList.contains('hidden')) return;
    const snapshot = latestSnapshot || getDiagnosticSnapshot();
    const caches = snapshot.caches || {};
    const fieldCache = caches.field || {};
    const zarrCache = caches.zarr || {};
    const pointCache = caches.point || {};
    const geometry = snapshot.geometry || {};
    const heap = snapshot.browserMemory?.usedJSHeapSize;
    panel.querySelector('.md-summary').innerHTML = `
      <div><strong>${snapshot.timelineFrames ?? 0}</strong><span>timeline frames</span></div>
      <div><strong>${snapshot.layerFrames ?? 0}</strong><span>retained layer frames</span></div>
      <div><strong>${bytesLabel(snapshot.cpuTypedArrayBytes)}</strong><span>mapped typed arrays</span></div>
      <div><strong>${bytesLabel(snapshot.gpuResourceBytes)}</strong><span>estimated GPU textures (${snapshot.gpuResourceCount ?? 0})</span></div>
      <div><strong>${bytesLabel(snapshot.cpuReleasedAfterUploadBytes)}</strong><span>CPU released after GPU upload</span></div>
      <div title="Used only by protobuf/JSON gridded products. Zarr-transport products appear in the Zarr cache."><strong>${bytesLabel(fieldCache.bytes)}</strong><span>protobuf field cache (${fieldCache.entries ?? 0})</span></div>
      <div><strong>${bytesLabel(zarrCache.bytes)}</strong><span>Zarr cache (${zarrCache.entries ?? 0})</span></div>
      <div><strong>${bytesLabel(pointCache.bytes)}</strong><span>point/profile cache (${pointCache.entries ?? 0})</span></div>
      <div><strong>${bytesLabel(snapshot.totalCacheBytes)}</strong><span>all reusable caches</span></div>
      <div title="Estimated JS object graphs for retained GeoJSON frames, after adjacent-frame sharing."><strong>${bytesLabel(geometry.retainedBytes)}</strong><span>geometry objects (${geometry.featureCount ?? 0} features)</span></div>
      <div title="Estimated duplicate geometry bytes avoided by reusing unchanged adjacent-frame features."><strong>${bytesLabel(geometry.sharedBytes)}</strong><span>shared geometry savings</span></div>
      <div><strong>${heap == null ? 'n/a' : bytesLabel(heap)}</strong><span>JS heap</span></div>`;

    const layers = snapshot.layers || [];
    panel.querySelector('.md-layers tbody').innerHTML = layers.map(layer => `
      <tr><td>${escapeHtml(layer.layerId)}</td><td>${layer.frameCount}</td>
      <td>${bytesLabel(layer.cpuBytes)}</td><td>${bytesLabel(layer.gpuBytes)}</td><td>${layer.gpuResources}</td></tr>`).join('') ||
      '<tr><td colspan="5" class="md-empty">No map data loaded</td></tr>';

    const allEvents = getDiagnosticEvents();
    const typeSelect = panel.querySelector('#md-event-type');
    const newestEventId = allEvents.at(-1)?.id ?? '';
    const eventKey = `${allEvents.length}:${newestEventId}:${eventTypeFilter}:${eventTextFilter}`;
    if (eventKey !== renderedEventKey) {
        const selectedType = eventTypeFilter;
        const eventTypes = [...new Set(allEvents.map(event => event.type))].sort();
        typeSelect.innerHTML = '<option value="all">All event types</option>' + eventTypes.map(type =>
            `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
        typeSelect.value = eventTypes.includes(selectedType) ? selectedType : 'all';
        if (typeSelect.value !== selectedType) eventTypeFilter = typeSelect.value;

        const needle = eventTextFilter.trim().toLowerCase();
        const recent = allEvents.filter(event => {
            if (eventTypeFilter !== 'all' && event.type !== eventTypeFilter) return false;
            if (!needle) return true;
            return [event.type, event.source, event.product, event.key, event.message]
                .some(value => String(value ?? '').toLowerCase().includes(needle));
        }).slice(-150).reverse();
        panel.querySelector('.md-events tbody').innerHTML = recent.map(event => `
          <tr class="md-event-${escapeHtml(event.type)}">
            <td>${new Date(event.timestamp).toLocaleTimeString()}</td>
            <td><span class="md-event-type">${escapeHtml(event.type)}</span></td>
            <td title="${escapeHtml(detailLabel(event))}">${escapeHtml(detailLabel(event))}</td>
            <td>${event.bytes == null ? '—' : bytesLabel(event.bytes)}${event.reclaimedBytes ? `<small class="md-reclaimed">reclaimed ${bytesLabel(event.reclaimedBytes)}</small>` : ''}</td>
            <td>${durationLabel(event.durationMs)}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="md-empty">No diagnostic events yet</td></tr>';
        renderedEventKey = `${allEvents.length}:${newestEventId}:${eventTypeFilter}:${eventTextFilter}`;
    }
    panel.querySelector('.md-updated').textContent = `Updated ${new Date(snapshot.capturedAt).toLocaleTimeString()}`;
    if (activeTab === 'timeline') renderTimeline();
    if (activeTab === 'backend') renderBackend();
}

function scheduleIdleSample() {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
        const collect = () => {
            idleHandle = undefined;
            latestSnapshot = sampleDiagnosticSnapshot();
            render();
            scheduleIdleSample();
        };
        if ('requestIdleCallback' in window) idleHandle = window.requestIdleCallback(collect);
        else collect();
    }, 1000);
}

export const MapDiagnostics = {
    init() {
        panel = document.createElement('section');
        panel.id = 'map-diagnostics-panel';
        panel.className = 'hidden';
        panel.innerHTML = `
          <header><div><h2>Map Diagnostics</h2><div class="md-updated">Waiting for activity</div></div>
            <div><button id="md-export-json" title="Export all samples, events, and summary statistics">Export JSON</button><button id="md-export-csv" title="Export timeline samples for plotting">Export CSV</button><button id="md-pause">Pause</button><button id="md-clear">Clear history</button><button id="md-close" aria-label="Close">×</button></div>
          </header>
          <div class="md-summary"></div>
          <nav class="md-tabs" aria-label="Diagnostic views">
            <button class="md-tab active" data-tab="overview">Overview</button><button class="md-tab" data-tab="timeline">Timeline</button><button class="md-tab" data-tab="backend">Backend</button><button class="md-tab" data-tab="events">Events</button>
          </nav>
          <div class="md-tab-panel active" data-tab-panel="overview"><div class="md-grid md-overview-grid">
            <section><h3>Retained map layers</h3><div class="md-table-wrap md-layers"><table><thead><tr>
              <th>Layer</th><th>Frames</th><th>CPU arrays</th><th>GPU textures</th><th>GPU resources</th>
            </tr></thead><tbody></tbody></table></div></section></div></div>
          <div class="md-tab-panel" data-tab-panel="timeline">
            <div class="md-timeline-header"><span>Rolling 10-minute history</span><span class="md-history-status"></span></div>
            <div class="md-charts">
              <section><h3>Memory usage</h3><div class="md-chart-legend"><span style="--series:#ffcc66">JS heap</span><span style="--series:#68d5ff">CPU arrays</span><span style="--series:#e599f7">GPU textures</span><span style="--series:#51cf66">Geometry objects</span></div><canvas id="md-chart-0"></canvas><div class="md-chart-tooltip"></div></section>
              <section><h3>Frames and GPU resources</h3><div class="md-chart-legend"><span style="--series:#e599f7">GPU resources</span><span style="--series:#74c0fc">Layer frames</span><span style="--series:#ffd43b">Timeline frames</span></div><canvas id="md-chart-1"></canvas><div class="md-chart-tooltip"></div></section>
              <section><h3>Cache usage</h3><div class="md-chart-legend"><span title="Decoded protobuf/JSON fields; Zarr products do not use this cache" style="--series:#63e6be">Protobuf field</span><span style="--series:#da77f2">Zarr</span><span style="--series:#ff8787">Point/profile</span></div><canvas id="md-chart-2"></canvas><div class="md-chart-tooltip"></div></section>
              <section class="md-latency-chart"><h3>Operation latency and lifecycle events</h3><div class="md-chart-legend"><span style="--series:#ff922b">Duration</span><span style="--series:#51cf66">Frame added</span><span style="--series:#ff6b6b">Frame purged</span><span style="--series:#74c0fc">Auto-update</span></div><canvas id="md-chart-latency"></canvas><div class="md-chart-tooltip"></div></section>
            </div>
          </div>
          <div class="md-tab-panel" data-tab-panel="backend">
            <div class="md-timeline-header"><span>Application backend · Prometheus remains enabled</span><span class="md-backend-status">Waiting for backend…</span></div>
            <div class="md-backend-summary md-summary"></div>
            <div class="md-backend-content">
              <div class="md-backend-charts">
                <section><h3>Request latency</h3><div class="md-chart-legend"><span style="--series:#74c0fc">Average</span><span style="--series:#ff922b">p95</span><span style="--series:#e599f7">TTFB p95</span></div><canvas id="md-backend-chart-0"></canvas><div class="md-chart-tooltip"></div></section>
                <section><h3>Server grid cache</h3><div class="md-chart-legend"><span style="--series:#63e6be">Bytes</span></div><canvas id="md-backend-chart-1"></canvas><div class="md-chart-tooltip"></div></section>
                <section><h3>Activity and errors</h3><div class="md-chart-legend"><span style="--series:#ffd43b">Active</span><span style="--series:#ff6b6b">Window errors</span></div><canvas id="md-backend-chart-2"></canvas><div class="md-chart-tooltip"></div></section>
              </div>
              <section class="md-backend-request-section"><h3>Recent correlated requests <select id="md-backend-instance" aria-label="Filter requests by backend process"><option value="all">All processes</option></select></h3><div class="md-table-wrap md-backend-requests"><table><thead><tr><th>Time</th><th>Process</th><th>Request ID</th><th>Endpoint</th><th>Source</th><th>Status</th><th>TTFB</th><th>Total</th><th>Bytes</th></tr></thead><tbody></tbody></table></div></section>
            </div>
          </div>
          <div class="md-tab-panel" data-tab-panel="events"><div class="md-grid md-events-grid">
            <section><div class="md-events-header"><h3>Construction and update events</h3>
              <div class="md-event-filters"><select id="md-event-type" aria-label="Filter diagnostic event type"><option value="all">All event types</option></select>
              <input id="md-event-search" type="search" placeholder="Filter source, frame, or message" aria-label="Filter diagnostic events"></div></div>
              <div class="md-table-wrap md-events"><table><thead><tr>
              <th>Time</th><th>Event</th><th>Source / frame</th><th>Size</th><th>Duration</th>
            </tr></thead><tbody></tbody></table></div></section>
          </div></div>`;
        document.body.appendChild(panel);
        panel.querySelector('#md-close').addEventListener('click', () => this.close());
        panel.querySelector('#md-export-json').addEventListener('click', exportJson);
        panel.querySelector('#md-export-csv').addEventListener('click', exportCsv);
        panel.querySelector('#md-clear').addEventListener('click', () => {
            clearDiagnosticEvents();
            clearDiagnosticSnapshots();
            clearBackendDiagnostics();
            backendSequence = 0;
            backendInstanceId = null;
            backendError = '';
            latestSnapshot = sampleDiagnosticSnapshot();
            renderedEventKey = '';
            render();
        });
        panel.querySelector('#md-pause').addEventListener('click', event => {
            paused = !paused;
            event.currentTarget.textContent = paused ? 'Resume' : 'Pause';
            if (!paused) render();
        });
        panel.querySelector('#md-event-type').addEventListener('change', event => {
            eventTypeFilter = event.currentTarget.value;
            render();
        });
        panel.querySelector('#md-event-search').addEventListener('input', event => {
            eventTextFilter = event.currentTarget.value;
            render();
            // render replaces table rows but deliberately preserves this input.
        });
        panel.querySelector('#md-backend-instance').addEventListener('change', event => {
            backendInstanceFilter = event.currentTarget.value;
            renderBackend();
        });
        panel.querySelectorAll('.md-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
        panel.querySelectorAll('canvas').forEach(canvas => canvas.addEventListener('mousemove', event => {
            const meta = canvas._chartMeta;
            if (!meta?.samples?.length) return;
            const rect = canvas.getBoundingClientRect();
            const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 58) / Math.max(1, rect.width - 70)));
            const targetTime = meta.startTime + fraction * (meta.endTime - meta.startTime);
            const sample = meta.samples.reduce((nearest, candidate) =>
                Math.abs(new Date(candidate.capturedAt).getTime() - targetTime) < Math.abs(new Date(nearest.capturedAt).getTime() - targetTime)
                    ? candidate : nearest);
            const tooltip = canvas.parentElement.querySelector('.md-chart-tooltip');
            tooltip.innerHTML = `<strong>${new Date(sample.capturedAt).toLocaleTimeString()}</strong>${meta.series ? '' : meta.chart.series.map(series => `<span style="--series:${series.color}">${escapeHtml(series.label)}: ${compactNumber(Number(metricValue(sample, series.path)) || 0, meta.chart.unit)}</span>`).join('')}${sample.event ? `<span>${escapeHtml(sample.event.type)} · ${durationLabel(sample.durationMs)}</span>` : ''}`;
            tooltip.style.left = `${Math.min(rect.width - 175, Math.max(4, event.clientX - rect.left + 8))}px`;
            tooltip.classList.add('visible');
        }));
        panel.querySelectorAll('canvas').forEach(canvas => canvas.addEventListener('mouseleave', () => canvas.parentElement.querySelector('.md-chart-tooltip')?.classList.remove('visible')));
        unsubscribe = subscribeDiagnostics(() => render());
        latestSnapshot = sampleDiagnosticSnapshot();
        scheduleIdleSample();
        render();
    },
    toggle() {
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        if (opening) render();
        if (opening) scheduleBackendPoll(0);
        if (!opening) {
            window.clearTimeout(backendTimer);
            window.clearTimeout(backendTimeout);
            backendAbort?.abort();
        }
        return opening;
    },
    close() {
        panel.classList.add('hidden');
        window.clearTimeout(backendTimer);
        window.clearTimeout(backendTimeout);
        backendAbort?.abort();
        document.querySelector('#btn-map-diagnostics')?.classList.remove('active');
    },
    destroy() {
        unsubscribe?.();
        window.clearTimeout(timer);
        if (idleHandle != null) window.cancelIdleCallback?.(idleHandle);
        window.clearTimeout(backendTimer);
        window.clearTimeout(backendTimeout);
        backendAbort?.abort();
        panel?.remove();
    },
};
