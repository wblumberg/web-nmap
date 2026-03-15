/**
 * DataLoader.js  (updated to use DynamicViewManager + CatalogClient)
 *
 * loadData() is now called with a fully resolved view from DynamicViewManager,
 * so it always has a real cycle, fhr list, grid info, and ordered keys.
 * No URL construction or time logic in PanelManager — all of that happens here.
 */

import * as CatalogClient from './catalog/CatalogClient.js';
import { resolveView, invalidateSource } from './catalog/DynamicViewManager.js';
import { subscribeToNewData } from './events.js';

const API_BASE = '/api/v1';

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Load all data needed for a given view at a specific time key.
 *
 * Called by PanelManager/LayerBuilder for each time step.
 *
 * @param {string} sourceId
 * @param {string[]} dataKeys   - variable names needed by make_layers()
 * @param {object}  time        - { valid_time, cycle, fhr } — from resolved view
 * @param {object}  varMap      - generic name → file name
 * @returns {Promise<object>}   - data object passed to make_layers()
 */
export async function loadData(sourceId, dataKeys, time, varMap = {}) {
    switch (sourceId) {
        case 'LIGHTNING':
            return _loadLightning(time, varMap);
        case 'SURFACE_OBS':
            return _loadSurfaceObs(time, varMap);
        case 'NWS_ALERTS':
        case 'SPC_DAY1_OUTLOOK':
        case 'SPC_DAY2_OUTLOOK':
        case 'SPC_DAY3_OUTLOOK':
            return _loadGeometries(sourceId, time, varMap);
        case 'LSR':
            return _loadLSRs(time, varMap);
        case 'ADSB':
            return _loadAircraftTracks(time, varMap);
        default:
            return _loadGriddedField(sourceId, dataKeys, time, varMap);
    }
}

/**
 * Resolve a view and return its ordered time keys, ready for MultiPlotLayer.
 *
 * This replaces the manual fhr-to-key conversion that PanelManager used to do.
 *
 * @param {string} viewId
 * @param {object} [opts]  - { cycle, fresh }
 * @returns {Promise<{orderedKeys: string[], gridInfo: object, resolvedView: object}>}
 */
export async function resolveViewKeys(viewId, opts = {}) {
    const resolved = await resolveView(viewId, opts);
    return {
        orderedKeys  : resolved.orderedKeys,
        gridInfo     : resolved.gridInfo,
        resolvedView : resolved,
    };
}

/**
 * Start listening for SSE new-data events and invalidate the cache when
 * new files arrive.
 *
 * Call this once at app startup.
 *
 * @param {function} onNewData  - callback({ source_id, key })
 * @returns {function}          - call to close the connection
 */
export function startDataEventListener(onNewData) {
    return subscribeToNewData((info) => {
        invalidateSource(info.source_id);
        onNewData(info);
    });
}

// ─── Private loaders ──────────────────────────────────────────────────────────

async function _loadGriddedField(sourceId, dataKeys, time, varMap) {
    const variables = dataKeys.join(',');
    let url;

    if (time.cycle != null && time.fhr != null) {
        // Forecast field
        url = new URL(`${API_BASE}/gridded/${sourceId}/forecast`, window.location.origin);
        url.searchParams.set('variables', variables);
        url.searchParams.set('cycle', time.cycle);
        url.searchParams.set('fhr',   time.fhr);
        if (time.level) url.searchParams.set('level', time.level);
    } else {
        // Analysis field
        url = new URL(`${API_BASE}/gridded/${sourceId}/field`, window.location.origin);
        url.searchParams.set('variables', variables);
        if (time.valid_time) url.searchParams.set('key', time.valid_time);
        if (time.level)      url.searchParams.set('level', time.level);
    }

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Gridded load failed for ${sourceId}: ${resp.status}`);
    const json = await resp.json();

    // Convert each field's flat array to Float32Array for autumnplot-gl
    const out = {};
    for (const [varName, fieldData] of Object.entries(json.fields)) {
        out[varName] = {
            ...fieldData,
            data: new Float32Array(fieldData.data),
        };
    }
    return out;
}

async function _loadLightning(time, varMap) {
    const url = new URL(`${API_BASE}/lightning/strikes`, window.location.origin);
    if (time?.valid_time) url.searchParams.set('key', time.valid_time);
    url.searchParams.set('max_age_minutes', varMap?.max_age_minutes ?? 60);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Lightning load failed: ${resp.status}`);
    return { strikes_geojson: await resp.json() };
}

async function _loadSurfaceObs(time, varMap) {
    const url = new URL(`${API_BASE}/observations/surface`, window.location.origin);
    if (time?.valid_time)    url.searchParams.set('key',            time.valid_time);
    if (varMap?.window_minutes) url.searchParams.set('window_minutes', varMap.window_minutes);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Obs load failed: ${resp.status}`);
    const json = await resp.json();
    return { obs_json: json.observations };
}

async function _loadGeometries(sourceId, time, varMap) {
    const url = new URL(`${API_BASE}/geometries/${sourceId}/features`,
                        window.location.origin);
    if (time?.valid_time) url.searchParams.set('key', time.valid_time);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Geometry load failed for ${sourceId}: ${resp.status}`);
    return { alerts_geojson: await resp.json() };
}

async function _loadLSRs(time, varMap) {
    const url = new URL(`${API_BASE}/points/LSR/lsrs`, window.location.origin);
    url.searchParams.set('center_key',   time.valid_time ?? '');
    url.searchParams.set('window_hours', varMap?.window_hours ?? 6);
    if (varMap?.event_types) url.searchParams.set('event_types', varMap.event_types);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`LSR load failed: ${resp.status}`);
    return { lsr_geojson: await resp.json() };
}

async function _loadAircraftTracks(time, varMap) {
    const url = new URL(`${API_BASE}/points/ADSB/features`, window.location.origin);
    if (varMap?.bbox) url.searchParams.set('bbox', varMap.bbox.join(','));

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`ADS-B load failed: ${resp.status}`);
    return { positions_geojson: await resp.json() };
}
