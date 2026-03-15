/**
 * DynamicViewManager.js
 *
 * Replaces the static VIEW_REGISTRY pattern from views.js for forecast sources.
 *
 * ─── The old way (static views.js) ───────────────────────────────────────────
 *
 *   export const VIEW_REGISTRY = {
 *       'rap_mslp': {
 *           source_id:     'RAP',
 *           product_id:    'mslp_fill',
 *           time:          { cycle: '2025030200', fhr: 0 },   ← hardcoded!
 *           available_fhrs: [0, 1, 2, 3, ...21],              ← hardcoded!
 *       }
 *   };
 *
 * ─── The new way ──────────────────────────────────────────────────────────────
 *
 * Views are still declared in views.js but without hardcoded cycle/fhr info.
 * Instead they declare their intent:
 *
 *   export const VIEW_REGISTRY = {
 *       'rap_mslp': {
 *           source_id:      'RAP',
 *           product_id:     'mslp_fill',
 *           time_mode:      'forecast',    ← NEW: tells DVM what to fetch
 *           fhr_range:      'all',         ← NEW: fetch all available fhrs
 *           // fhr_range: { min: 0, max: 12 }  ← OR restrict to a range
 *           // fhr_range: [0, 3, 6, 9, 12]     ← OR an explicit list
 *       }
 *   };
 *
 * DynamicViewManager.resolve(viewId) then:
 *   1. Calls /cycles/latest to get the newest cycle
 *   2. Calls /cycles/{cycle}/fhrs to get real fhrs
 *   3. Calls /grid_info to get ni/nj/dx/dy etc.
 *   4. Returns a fully resolved view descriptor ready for PanelManager
 *
 * ─── time_mode values ────────────────────────────────────────────────────────
 *   'analysis'   → use /times/latest (no cycle/fhr concept)
 *   'forecast'   → use /cycles/latest + /cycles/{cycle}/fhrs
 *   'realtime'   → like analysis but refreshes on SSE new_data events
 *   'static'     → no time concept (county shapefiles, political boundaries)
 *
 * ─── fhr_range values ────────────────────────────────────────────────────────
 *   'all'                → fetch all available fhrs from the API
 *   { min: 0, max: 24 } → only fhrs 0-24
 *   [0, 3, 6, 12, 24]   → explicit list; filtered to what's actually on disk
 */

import {
    latestCycle,
    listFhrs,
    listTimes,
    latestTime,
    fetchGridInfoCached,
} from './CatalogClient.js';

import { VIEW_REGISTRY } from '../config/views.js';

/**
 * Cache of resolved views.
 * Key: `${viewId}:${cycle}`  (cycle is 'latest' for analysis views)
 * Value: fully resolved view descriptor
 *
 * Cache is invalidated when an SSE new_data event arrives for the source.
 */
const _resolvedCache = new Map();
const _cycleCache    = new Map();  // sourceId → { cycle, resolvedAt }

/**
 * Resolve a view ID into a fully live descriptor.
 *
 * @param {string} viewId           - Key in VIEW_REGISTRY, e.g. 'rap_mslp'
 * @param {object} [opts]
 * @param {string} [opts.cycle]     - Override: use this cycle instead of latest
 * @param {boolean} [opts.fresh]    - Skip cache and re-fetch everything
 * @returns {Promise<ResolvedView>}
 */
export async function resolveView(viewId, opts = {}) {
    const viewDef = VIEW_REGISTRY[viewId];
    if (!viewDef) throw new Error(`Unknown viewId '${viewId}'`);

    const timeMode = viewDef.time_mode ?? _inferTimeMode(viewDef);
    const cacheKey = `${viewId}:${opts.cycle ?? 'latest'}`;

    if (!opts.fresh && _resolvedCache.has(cacheKey)) {
        return _resolvedCache.get(cacheKey);
    }

    let resolved;
    switch (timeMode) {
        case 'forecast':
            resolved = await _resolveForecastView(viewId, viewDef, opts);
            break;
        case 'analysis':
        case 'realtime':
            resolved = await _resolveAnalysisView(viewId, viewDef, opts);
            break;
        case 'static':
            resolved = _resolveStaticView(viewId, viewDef);
            break;
        default:
            throw new Error(`Unknown time_mode '${timeMode}' for view '${viewId}'`);
    }

    _resolvedCache.set(cacheKey, resolved);
    return resolved;
}

/**
 * Resolve all views for a given source (useful when adding a slot).
 *
 * @param {string} sourceId
 * @returns {Promise<ResolvedView[]>}
 */
export async function resolveViewsForSource(sourceId) {
    const viewIds = Object.entries(VIEW_REGISTRY)
        .filter(([, v]) => v.source_id === sourceId)
        .map(([id]) => id);

    return Promise.all(viewIds.map(id => resolveView(id)));
}

/**
 * Invalidate the cache for a source (call when SSE new_data arrives).
 *
 * @param {string} sourceId
 */
export function invalidateSource(sourceId) {
    for (const key of _resolvedCache.keys()) {
        const viewId = key.split(':')[0];
        const view   = VIEW_REGISTRY[viewId];
        if (view?.source_id === sourceId) {
            _resolvedCache.delete(key);
        }
    }
    _cycleCache.delete(sourceId);
}

/**
 * Switch to a different cycle for a forecast view.
 * Returns a new resolved view for that cycle.
 *
 * @param {string} viewId
 * @param {string} cycle   e.g. '2025030212'
 * @returns {Promise<ResolvedView>}
 */
export async function resolveCycle(viewId, cycle) {
    return resolveView(viewId, { cycle, fresh: true });
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _resolveForecastView(viewId, viewDef, opts) {
    const sourceId = viewDef.source_id;

    // Step 1: determine which cycle to use
    let cycleInfo;
    if (opts.cycle) {
        // Caller specified a cycle explicitly (e.g. user picked one from dropdown)
        const fhrResult = await listFhrs(sourceId, opts.cycle,
                                         _fhrRangeToOpts(viewDef.fhr_range));
        cycleInfo = {
            cycle      : opts.cycle,
            cycle_time : null,
            fhrs       : fhrResult.fhrs,
            fhr_min    : fhrResult.fhr_min,
            fhr_max    : fhrResult.fhr_max,
            fhr_count  : fhrResult.fhr_count,
            keys       : fhrResult.keys,
        };
    } else {
        // Use the most recent available cycle (most common case)
        const latest = await latestCycle(sourceId);
        _cycleCache.set(sourceId, { cycle: latest.cycle, resolvedAt: Date.now() });

        // Apply fhr_range filter from the view definition
        if (viewDef.fhr_range === 'all' || viewDef.fhr_range == null) {
            cycleInfo = latest;
        } else if (Array.isArray(viewDef.fhr_range)) {
            // Explicit list — filter to what's actually on disk
            const available = new Set(latest.fhrs);
            cycleInfo = {
                ...latest,
                fhrs : viewDef.fhr_range.filter(f => available.has(f)),
                keys : latest.keys?.filter((_, i) =>
                    viewDef.fhr_range.includes(latest.fhrs[i])),
            };
        } else if (typeof viewDef.fhr_range === 'object') {
            // { min, max } range filter
            const { min = 0, max = Infinity } = viewDef.fhr_range;
            const filtered = latest.fhrs.filter(f => f >= min && f <= max);
            cycleInfo = {
                ...latest,
                fhrs      : filtered,
                fhr_min   : filtered[0] ?? null,
                fhr_max   : filtered[filtered.length - 1] ?? null,
                fhr_count : filtered.length,
                keys      : latest.keys?.filter((_, i) =>
                    latest.fhrs[i] >= min && latest.fhrs[i] <= max),
            };
        } else {
            cycleInfo = latest;
        }
    }

    // Step 2: fetch grid info (cached after first call)
    const gridInfo = await fetchGridInfoCached(sourceId);

    // Step 3: build MultiPlotLayer-compatible ordered keys
    // Keys are formatted as '{cycle}_f{fhr:03d}' to be unique and sortable
    const orderedKeys = cycleInfo.fhrs.map(
        f => `${cycleInfo.cycle}_f${String(f).padStart(3, '0')}`
    );

    return {
        viewId,
        ...viewDef,                // spread the static definition
        time_mode : 'forecast',
        cycle     : cycleInfo.cycle,
        cycle_time: cycleInfo.cycle_time,
        fhrs      : cycleInfo.fhrs,
        fhr_min   : cycleInfo.fhr_min,
        fhr_max   : cycleInfo.fhr_max,
        fhr_count : cycleInfo.fhr_count,
        orderedKeys,
        gridInfo,
        // Convenience: the current time dict for DataLoader
        time: {
            cycle: cycleInfo.cycle,
            fhr  : cycleInfo.fhrs[0] ?? 0,
        },
        // available_fhrs stays for backward compat with any existing code
        available_fhrs: cycleInfo.fhrs,
    };
}

async function _resolveAnalysisView(viewId, viewDef, opts) {
    const sourceId = viewDef.source_id;

    const key      = opts.key ?? await latestTime(sourceId);
    const gridInfo = viewDef.data_category === 'point_obs'
                     ? null
                     : await fetchGridInfoCached(sourceId);

    return {
        viewId,
        ...viewDef,
        time_mode   : viewDef.time_mode ?? 'analysis',
        time        : { valid_time: key },
        orderedKeys : [key],
        gridInfo,
        available_fhrs: null,
    };
}

function _resolveStaticView(viewId, viewDef) {
    return {
        viewId,
        ...viewDef,
        time_mode   : 'static',
        time        : null,
        orderedKeys : ['static'],
        gridInfo    : null,
        available_fhrs: null,
    };
}

function _fhrRangeToOpts(fhrRange) {
    if (!fhrRange || fhrRange === 'all') return {};
    if (typeof fhrRange === 'object' && !Array.isArray(fhrRange)) {
        return { fhrMin: fhrRange.min, fhrMax: fhrRange.max };
    }
    if (Array.isArray(fhrRange)) {
        return { fhrMin: Math.min(...fhrRange), fhrMax: Math.max(...fhrRange) };
    }
    return {};
}

function _inferTimeMode(viewDef) {
    // Backward compatibility: infer time_mode from old-style view definitions
    if (viewDef.available_fhrs !== undefined) return 'forecast';
    if (viewDef.time?.valid_time !== undefined) return 'analysis';
    return 'analysis';
}
