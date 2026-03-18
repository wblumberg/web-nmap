/**
 * CatalogClient.js
 *
 * Thin wrapper around the Python catalog API endpoints.
 * All API knowledge lives here — the rest of the JavaScript codebase
 * calls these functions and never constructs URLs directly.
 * 
 */

const API_BASE = '/api/v1/catalog';

// ---------------------------------------------------------------------------
// Category constants
// ---------------------------------------------------------------------------
const DataCategory = Object.freeze({
    MODEL_DET:    'MODEL_DET',
    MODEL_ENS:    'MODEL_ENS',
    ANALYSIS:     'ANALYSIS',
    SATELLITE:    'SATELLITE',
    RADAR_MOSAIC: 'RADAR_MOSAIC',
    RADAR_NEXRAD: 'RADAR_NEXRAD',
    OBS_UPPERAIR: 'OBS_UPPERAIR',
    OBS_SURFACE:  'OBS_SURFACE',
    MISC:         'MISC',
});

const DataCategoryLabel = Object.freeze({
    MODEL_DET:    'Deterministic Models',
    MODEL_ENS:    'Ensemble Models',
    ANALYSIS:     'Analyses',
    SATELLITE:    'Satellite',
    RADAR_MOSAIC: 'Radar Mosaics',
    RADAR_NEXRAD: 'NEXRAD (Single Site)',
    OBS_UPPERAIR: 'Upper Air Observations',
    OBS_SURFACE:  'Surface Observations',
    MISC:         'Miscellaneous',
});

// ─── Sources ──────────────────────────────────────────────────────────────────
// These functions get all of the information about the sources that are available
// in the catalog.
//
// The Data Sources available are obtained upon initialization of the application, and are used to populate the
// source selection dropdowns in the UI.  
//
/**
 * List all configured data sources.
 * @returns {Promise<Array<{source_id, label, data_category, has_cycles, has_fhrs}>>}
 */
export async function listSources() {
    const resp = await fetch(`${API_BASE}/sources`);
    if (!resp.ok) throw new Error(`listSources failed: ${resp.status}`);
    const json = await resp.json();
    return json.sources;
}

// ─── Valid times (analysis / observation sources) ─────────────────────────────
// These functions get the available valid-time keys for an observations or analysis
// source such as:
//
//  - SURFACE_OBS
//  - Hourly Mesoanalysis
//  - Upper air observations
// 
// which are used to fetch data for that source. The keys are typically timestamps in ISO format,
// but they can be any string that uniquely identifies a dataset for a given source.

/**
 * List available valid-time keys for a non-forecast source.
 * @param {string} sourceId
 * @param {{after?: string, before?: string, limit?: number}} [opts]
 * @returns {Promise<string[]>}  array of key strings, newest first
 */
export async function listTimes(sourceId, opts = {}) {
    const url = new URL(`${API_BASE}/${sourceId}/times`, window.location.origin);
    if (opts.after)  url.searchParams.set('after',  opts.after);
    if (opts.before) url.searchParams.set('before', opts.before);
    if (opts.limit)  url.searchParams.set('limit',  opts.limit);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`listTimes(${sourceId}) failed: ${resp.status}`);
    const json = await resp.json();
    return json.times.map(t => t.key);
}

/**
 * List available times with full metadata (key, valid_time, cycle, fhr).
 *
 * Same API call as listTimes(), but returns the complete time objects instead
 * of just key strings.  Used by appController for time-matching frames to
 * actual API keys.
 *
 * @param {string} sourceId
 * @param {{after?: string, before?: string, limit?: number}} [opts]
 * @returns {Promise<Array<{key: string, valid_time: string, cycle: string|null, fhr: number|null}>>}
 */
export async function listTimesDetailed(sourceId, opts = {}) {
    const url = new URL(`${API_BASE}/${sourceId}/times`, window.location.origin);
    if (opts.after)  url.searchParams.set('after',  opts.after);
    if (opts.before) url.searchParams.set('before', opts.before);
    if (opts.limit)  url.searchParams.set('limit',  opts.limit);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`listTimesDetailed(${sourceId}) failed: ${resp.status}`);
    const json = await resp.json();
    return json.times;  // full objects: [{ key, valid_time, cycle, fhr, path, size_bytes }, ...]
}

/**
 * Get the most recent available key for a source.
 * @param {string} sourceId
 * @returns {Promise<string>}
 */
export async function latestTime(sourceId) {
    const resp = await fetch(`${API_BASE}/${sourceId}/times/latest`);
    if (!resp.ok) throw new Error(`latestTime(${sourceId}) failed: ${resp.status}`);
    const json = await resp.json();
    return json.latest.key;
}

/**
 * Find the key nearest to a target key.  This is a time matching function for sources
 * that have valid-time keys.  The API will return the key that is closest to the 
 * target key, within a specified window of hours.
 * 
 * TODO: Add a direction parameter to allow searching only forward, only backward, 
 * or both directions in time.
 * 
 * @param {string} sourceId
 * @param {string} targetKey
 * @param {number} [windowHours=3]
 * @returns {Promise<string>}
 */
export async function nearestTime(sourceId, targetKey, windowHours = 3) {
    const url = new URL(`${API_BASE}/${sourceId}/times/nearest`, window.location.origin);
    url.searchParams.set('target', targetKey);
    url.searchParams.set('window_hours', windowHours);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`nearestTime(${sourceId}/${targetKey}) failed`);
    const json = await resp.json();
    return json.matched_key;
}

// ─── Cycles and forecast hours (NWP forecast sources) ─────────────────────────
// These functions get the available valid-time keys for NWP forecast sources such as:
//
//  - GEFS
//  - HREF
//  - ECMWF High Resolution
// 
// which are used to fetch data for that source. The keys are typically timestamps in ISO format,
// but they can be any string that uniquely identifies a dataset for a given source.

/**
 * List available model cycles.
 *
 * @param {string} sourceId
 * @param {{after?: string, before?: string, limit?: number}} [opts]
 * @returns {Promise<Array<{cycle, cycle_time, fhr_count, fhr_min, fhr_max, fhrs}>>}
 */
export async function listCycles(sourceId, opts = {}) {
    const url = new URL(`${API_BASE}/${sourceId}/cycles`, window.location.origin);
    if (opts.after)  url.searchParams.set('after',  opts.after);
    if (opts.before) url.searchParams.set('before', opts.before);
    if (opts.limit)  url.searchParams.set('limit',  opts.limit ?? 10);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`listCycles(${sourceId}) failed: ${resp.status}`);
    const json = await resp.json();
    return json.cycles;
}

/**
 * Get the most recent available cycle and its forecast hours.
 *
 * This is the primary call made when a forecast source slot is first added.
 *
 * @param {string} sourceId
 * @returns {Promise<{cycle, cycle_time, fhrs, fhr_min, fhr_max, fhr_count}>}
 */
export async function latestCycle(sourceId) {
    const resp = await fetch(`${API_BASE}/${sourceId}/cycles/latest`);
    if (!resp.ok) throw new Error(`latestCycle(${sourceId}) failed: ${resp.status}`);
    return await resp.json();
}

/**
 * Get forecast hours available for a specific cycle.
 *
 * Pass fhrMin / fhrMax to restrict the range returned.
 * Pass fhrs: 'all' in views.js — this function fetches the real list.
 *
 * @param {string} sourceId
 * @param {string} cycle       e.g. '2025030218'
 * @param {{fhrMin?: number, fhrMax?: number}} [opts]
 * @returns {Promise<{fhrs: number[], keys: string[], fhr_min, fhr_max, fhr_count}>}
 */
export async function listFhrs(sourceId, cycle, opts = {}) {
    const url = new URL(
        `${API_BASE}/${sourceId}/cycles/${cycle}/fhrs`,
        window.location.origin
    );
    if (opts.fhrMin != null) url.searchParams.set('fhr_min', opts.fhrMin);
    if (opts.fhrMax != null) url.searchParams.set('fhr_max', opts.fhrMax);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`listFhrs(${sourceId}/${cycle}) failed: ${resp.status}`);
    return await resp.json();
}

// ─── Grid info ────────────────────────────────────────────────────────────────

/**
 * Fetch the grid descriptor for a source from the API.
 *
 * Returns a GridInfo object:
 *   { grid_type, ni, nj, lat_min, lat_max, lon_min, lon_max, dx, dy, proj_params }
 *
 * Cache the result — the grid geometry never changes for a given source.
 *
 * @param {string} sourceId
 * @param {{key?: string, cycle?: string, fhr?: number, variable?: string}} [opts]
 * @returns {Promise<object>}  GridInfo dict
 */
export async function fetchGridInfo(sourceId, opts = {}) {
    const url = new URL(`${API_BASE}/${sourceId}/grid_info`, window.location.origin);
    if (opts.key)      url.searchParams.set('key',      opts.key);
    if (opts.cycle)    url.searchParams.set('cycle',    opts.cycle);
    if (opts.fhr)      url.searchParams.set('fhr',      opts.fhr);
    if (opts.variable) url.searchParams.set('variable', opts.variable);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`fetchGridInfo(${sourceId}) failed: ${resp.status}`);
    const json = await resp.json();
    return json.grid;
}

// ─── Grid info cache ──────────────────────────────────────────────────────────
// Grid geometry never changes for a source, so we cache it after the first fetch.
const _gridInfoCache = new Map();

export async function fetchGridInfoCached(sourceId, opts = {}) {
    const cacheKey = `${sourceId}:${opts.variable ?? ''}`;
    if (_gridInfoCache.has(cacheKey)) {
        return _gridInfoCache.get(cacheKey);
    }
    const info = await fetchGridInfo(sourceId, opts);
    _gridInfoCache.set(cacheKey, info);
    return info;
}
