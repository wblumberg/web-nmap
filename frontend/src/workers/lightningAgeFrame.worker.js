import { decodePointResponse } from '../services/decoding/protobufPoints.js';

function appendQueryParams(url, queryParams = {}) {
    Object.entries(queryParams || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    });
}

async function fetchAndPack({sourceId, fields, startIso, endIso, centerMs, frameSpecs, beforeMinutes = 60, afterMinutes = 0, binflag = true, queryParams, limit, paginate}) {
    const started = performance.now();
    const rows = [];
    let cursor = '';
    let meta = {};
    let pages = 0;
    let payloadBytes = 0;
    let networkMs = 0;
    let decodeMs = 0;
    const seenCursors = new Set();

    do {
        const requestStarted = performance.now();
        const url = new URL(`/api/v1/db-points/${sourceId}`, self.location.origin);
        appendQueryParams(url, queryParams);
        url.searchParams.set('start', startIso);
        url.searchParams.set('end', endIso);
        url.searchParams.set('raw', 'true');
        if (fields.length) url.searchParams.set('fields', fields.join(','));
        if (limit) url.searchParams.set('limit', String(limit));
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url, {headers: {'Accept': 'application/x-protobuf'}});
        if (!response.ok) throw new Error(`Lightning worker page ${pages + 1} failed: HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const downloaded = performance.now();
        const decoded = decodePointResponse(buffer);
        const decodedAt = performance.now();
        networkMs += downloaded - requestStarted;
        decodeMs += decodedAt - downloaded;
        payloadBytes += buffer.byteLength;
        pages++;
        meta = {...meta, ...(decoded.meta || {})};

        for (const point of decoded.points) {
            const timeMs = Number.isFinite(point.valid_time_ms) ? point.valid_time_ms : Date.parse(point.valid_time);
            const lon = Number(point.coord?.lon);
            const lat = Number(point.coord?.lat);
            if (!Number.isFinite(timeMs) || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
            let polarity = String(point.data?.polarity ?? '').trim();
            if (!polarity && Number.isFinite(Number(point.data?.peak_current))) {
                const peak = Number(point.data.peak_current);
                polarity = peak > 0 ? '+' : peak < 0 ? '-' : '';
            }
            rows.push({timeMs, lon, lat, polarity: polarity.startsWith('+') ? 1 : polarity.startsWith('-') ? -1 : 0});
        }

        const nextCursor = paginate ? String(decoded.meta?.next_cursor || '') : '';
        if (nextCursor && seenCursors.has(nextCursor)) throw new Error('Lightning worker received a repeated pagination cursor');
        if (nextCursor) seenCursors.add(nextCursor);
        cursor = nextCursor;
    } while (cursor);

    const prepareStarted = performance.now();
    // Oldest first: newer strikes are uploaded last and remain visible when
    // labels overlap, matching the existing product behavior.
    rows.sort((a, b) => a.timeMs - b.timeMs);
    const specs = frameSpecs?.length ? [...frameSpecs].sort((a, b) => a.centerMs - b.centerMs) : [{frameKey: null, centerMs}];
    const frames = [];
    let first = 0;
    let last = 0;
    for (const spec of specs) {
        const startMs = spec.centerMs - beforeMinutes * 60_000;
        const endMs = spec.centerMs + (binflag ? afterMinutes : beforeMinutes) * 60_000;
        while (first < rows.length && rows[first].timeMs < startMs) first++;
        if (last < first) last = first;
        while (last < rows.length && rows[last].timeMs <= endMs) last++;
        const count = last - first;
        const coordinates = new Float32Array(count * 2);
        const ages = new Float32Array(count);
        const polarityCodes = new Int8Array(count);
        for (let sourceIndex = first, index = 0; sourceIndex < last; sourceIndex++, index++) {
            const row = rows[sourceIndex];
            coordinates[index * 2] = row.lon;
            coordinates[index * 2 + 1] = row.lat;
            ages[index] = (spec.centerMs - row.timeMs) / 60_000;
            polarityCodes[index] = row.polarity;
        }
        frames.push({frameKey: spec.frameKey, data: {lightning_columns: {coordinates, ages, polarityCodes}}});
    }
    return {
        frames,
        meta: {...meta, pages: String(pages), possibly_truncated: 'false'},
        timing: {
            workerMs: performance.now() - started,
            networkMs,
            decodeMs,
            prepareMs: performance.now() - prepareStarted,
            payloadBytes,
            points: rows.length,
            framePoints: frames.map(frame => frame.data.lightning_columns.ages.length),
        },
    };
}

self.onmessage = async event => {
    const {id, request} = event.data;
    try {
        const result = await fetchAndPack(request);
        const transfers = result.frames.flatMap(frame => {
            const columns = frame.data.lightning_columns;
            return [columns.coordinates.buffer, columns.ages.buffer, columns.polarityCodes.buffer];
        });
        self.postMessage({id, result}, transfers);
    } catch (error) {
        self.postMessage({id, error: error?.message || String(error)});
    }
};
