/** Build frame-specific point collections from one range-oriented observation pool. */

const DEFAULT_BEFORE_MINUTES = 60;

function _asBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true';
}

function _asMinutes(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizePointPolicy(value = {}) {
    return {
        binflag: _asBoolean(value.binflag),
        beforeMinutes: _asMinutes(
            value.beforeMinutes ?? value.before_minutes,
            DEFAULT_BEFORE_MINUTES,
        ),
        afterMinutes: _asMinutes(value.afterMinutes ?? value.after_minutes, 0),
        useMostRecentFilter: _asBoolean(
            value.useMostRecentFilter ?? value.use_most_recent_filter,
        ),
        mostRecentBy: value.mostRecentBy ?? value.most_recent_by ?? 'geom',
        returnAge: _asBoolean(value.returnAge ?? value.return_age),
    };
}

export function pointWindow(centerMs, policyValue) {
    const policy = normalizePointPolicy(policyValue);
    const minute = 60_000;
    if (policy.binflag) {
        return {
            startMs: centerMs - policy.beforeMinutes * minute,
            endMs: centerMs + policy.afterMinutes * minute,
        };
    }
    return {
        startMs: centerMs - policy.beforeMinutes * minute,
        endMs: centerMs + policy.beforeMinutes * minute,
    };
}

/** Return the union range required for [{ frameKey, centerMs }, ...]. */
export function pointRangeForFrames(frameSpecs, policyValue) {
    if (!frameSpecs.length) return null;
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const { centerMs } of frameSpecs) {
        const window = pointWindow(centerMs, policyValue);
        startMs = Math.min(startMs, window.startMs);
        endMs = Math.max(endMs, window.endMs);
    }
    return { startMs, endMs };
}

function _identity(point, mostRecentBy) {
    if (mostRecentBy === 'station_id') {
        const stationId = point.data?.station_id;
        if (stationId === undefined || stationId === null) return null;
        const normalized = String(stationId).trim().toUpperCase();
        return normalized || null;
    }
    return `${point.coord?.lon},${point.coord?.lat}`;
}

function _compareByIdentity(a, b, mostRecentBy) {
    const aIdentity = _identity(a.point, mostRecentBy) ?? '';
    const bIdentity = _identity(b.point, mostRecentBy) ?? '';
    return aIdentity.localeCompare(bIdentity);
}

/**
 * Reproduce PointDBSource frame semantics without retransmitting overlapping rows.
 * Returned frame arrays reuse point objects unless frame-relative age is requested.
 */
export function buildPointFrames(points, frameSpecs, policyValue) {
    const policy = normalizePointPolicy(policyValue);
    const sorted = points
        .map(point => ({
            point,
            timeMs: Number.isFinite(point.valid_time_ms)
                ? point.valid_time_ms
                : Date.parse(point.valid_time),
        }))
        .filter(entry => Number.isFinite(entry.timeMs))
        .sort((a, b) => a.timeMs - b.timeMs);

    const frames = new Map();
    // Frame times normally arrive oldest → newest. Sorting defensively lets a
    // pair of moving indices reuse the previous frame's search position.
    const orderedSpecs = [...frameSpecs].sort((a, b) => a.centerMs - b.centerMs);
    let first = 0;
    let last = 0;

    for (const { frameKey, centerMs } of orderedSpecs) {
        const { startMs, endMs } = pointWindow(centerMs, policy);

        while (first < sorted.length && sorted[first].timeMs < startMs) first++;
        if (last < first) last = first;
        while (last < sorted.length && sorted[last].timeMs <= endMs) last++;

        // If callers supplied overlapping frames out of chronological order,
        // the sorted specs above still make both boundaries monotonic.
        let selected = sorted.slice(first, last);

        if (policy.useMostRecentFilter) {
            const newest = new Map();
            for (const entry of selected) {
                const identity = _identity(entry.point, policy.mostRecentBy);
                if (identity !== null) newest.set(identity, entry);
            }
            // StationPlot thinning depends on the UnstructuredGrid point/index
            // order. Sorting by report time reshuffles stations on every frame,
            // which makes thinned stations flicker even when they remain inside
            // the lookback window. Keep identity order stable across the loop.
            selected = [...newest.values()].sort(
                (a, b) => _compareByIdentity(a, b, policy.mostRecentBy)
            );
        }

        // Reuse decoded observation objects across overlapping frames. Products
        // that need frame-relative age derive it from these compact timestamps
        // and the frame reference instead of cloning every point and data map.
        const obsJson = selected.map(entry => entry.point);
        const frame = { obs_json: obsJson };
        if (policy.returnAge) {
            frame.age_reference_ms = centerMs;
            frame.obs_time_ms = Float64Array.from(selected, entry => entry.timeMs);
        }
        frames.set(frameKey, frame);
    }
    return frames;
}
