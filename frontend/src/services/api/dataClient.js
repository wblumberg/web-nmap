/**
 * dataClient.js — Data fetching service for web-nmap
 *
 * Fetches actual field values for visualization from the API endpoints.
 * For catalog metadata (source listing, available times, cycles), see catalogClient.js.
 *
 * ─── Mental model (for Python developers) ──────────────────────────────────
 *
 * Think of these functions like:
 *
 *     resp = requests.get('/api/v1/gridded/GFS/field', params={...})
 *     data = resp.json()
 *     fields = { var_name: np.array(field['data'], dtype=np.float32)
 *                for var_name, field in data['fields'].items() }
 *
 * Each function returns field data as Float32Arrays (JavaScript's equivalent
 * of numpy float32 arrays), ready to pass directly to autumnplot-gl.
 *
 * ─── Data flow ─────────────────────────────────────────────────────────────
 *
 *   dataClient.fetchAnalysisFields('MESOANALYSIS_GRID', ['t2m'], '20260227_0000')
 *     → { fields: { t2m: Float32Array(...) }, gridInfo: {...}, key: '20260227_0000' }
 *
 *   The `fields` object is then passed to a product suite's make_layers(data, grid)
 *   which creates the autumnplot-gl visualization layers.
 */

const API_BASE = '/api/v1';

// ═════════════════════════════════════════════════════════════════════════════
// Gridded Fields (analysis + forecast)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetch gridded analysis/observation field(s) for a given time key.
 *
 * Use for non-forecast sources: MRMS, mesoanalysis, surface analysis, etc.
 *
 * @param {string}   sourceId   - e.g. 'MESOANALYSIS_GRID'
 * @param {string[]} variables  - e.g. ['t2m', 'd2m']
 * @param {string}   key        - valid time key, e.g. '20260227_0000'
 * @param {object}   [opts]     - { level?: string, bbox?: string }
 * @returns {Promise<{
 *   fields:   Object<string, Float32Array>,  // { varName: Float32Array }
 *   gridInfo: object|null,                   // grid descriptor (first field)
 *   key:      string                         // echoed key from server
 * }>}
 */
export async function fetchAnalysisFields(sourceId, variables, key, opts = {}) {
    const url = new URL(`${API_BASE}/gridded/${sourceId}/field`, window.location.origin);
    url.searchParams.set('variables', variables.join(','));
    if (key)        url.searchParams.set('key', key);
    if (opts.level) url.searchParams.set('level', opts.level);
    if (opts.bbox)  url.searchParams.set('bbox', opts.bbox);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(
            `fetchAnalysisFields(${sourceId}, key=${key}) failed: HTTP ${resp.status}`
        );
    }
    const json = await resp.json();

    console.warn(`[DataClient] fetchAnalysisFields(${sourceId}, key=${key}) response:`, {
        source_id: json.source_id,
        key: json.key,
        field_count: json.field_count,
        fieldNames: Object.keys(json.fields || {}),
    });

    // Convert each field's flat JSON array to a Float32Array for autumnplot-gl.
    // This is like doing np.array(data, dtype=np.float32) in Python.
    const fields = {};
    let gridInfo = null;
    for (const [varName, fieldData] of Object.entries(json.fields)) {
        const rawData = fieldData.data;
        fields[varName] = new Float32Array(rawData);
        if (!gridInfo && fieldData.grid) gridInfo = fieldData.grid;

        console.warn(`[DataClient]   field "${varName}": rawData.length=${rawData?.length ?? 'null'}` +
            ` F32.length=${fields[varName].length}` +
            ` grid=${fieldData.grid ? JSON.stringify({grid_type: fieldData.grid.grid_type, ni: fieldData.grid.ni, nj: fieldData.grid.nj}) : 'null'}` +
            ` fill_value=${fieldData.fill_value}` +
            ` units=${fieldData.units}` +
            ` first5=[${rawData?.slice(0,5)}]` +
            ` last5=[${rawData?.slice(-5)}]`);
    }

    return { fields, gridInfo, key: json.key };
}

/**
 * Fetch gridded forecast field(s) for a specific model cycle + forecast hour.
 *
 * Use for NWP forecast sources: GFS, NAM, HRRR, RAP, HREF, etc.
 *
 * @param {string}   sourceId   - e.g. 'GFS'
 * @param {string[]} variables  - e.g. ['hght_500mb', 'ugrd_500mb', 'vgrd_500mb']
 * @param {string}   cycle      - model init time, e.g. '2025030200'
 * @param {number}   fhr        - forecast hour, e.g. 24
 * @param {object}   [opts]     - { level?: string }
 * @returns {Promise<{
 *   fields:   Object<string, Float32Array>,
 *   gridInfo: object|null,
 *   key:      string
 * }>}
 */
export async function fetchForecastFields(sourceId, variables, cycle, fhr, opts = {}) {
    const url = new URL(`${API_BASE}/gridded/${sourceId}/forecast`, window.location.origin);
    url.searchParams.set('variables', variables.join(','));
    url.searchParams.set('cycle', cycle);
    url.searchParams.set('fhr', String(fhr));
    if (opts.level) url.searchParams.set('level', opts.level);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(
            `fetchForecastFields(${sourceId}, cycle=${cycle}, fhr=${fhr}) failed: HTTP ${resp.status}`
        );
    }
    const json = await resp.json();

    const fields = {};
    let gridInfo = null;
    for (const [varName, fieldData] of Object.entries(json.fields)) {
        fields[varName] = new Float32Array(fieldData.data);
        if (!gridInfo && fieldData.grid) gridInfo = fieldData.grid;
    }

    return { fields, gridInfo, key: json.key };
}

// ═════════════════════════════════════════════════════════════════════════════
// Point / Observation / Geometry Data
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetch surface observations.
 *
 * @param {string} key - valid time key
 * @param {object} [opts] - { windowMinutes?: number }
 * @returns {Promise<{ obs_json: object }>}
 */
export async function fetchSurfaceObs(key, opts = {}) {
    const url = new URL(`${API_BASE}/observations/surface`, window.location.origin);
    if (key) url.searchParams.set('key', key);
    if (opts.windowMinutes) url.searchParams.set('window_minutes', opts.windowMinutes);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`fetchSurfaceObs(key=${key}) → HTTP ${resp.status}`);
    const json = await resp.json();
    return { obs_json: json.observations };
}

/**
 * Fetch lightning strike data.
 *
 * @param {string} key - valid time key
 * @param {object} [opts] - { maxAgeMinutes?: number }
 * @returns {Promise<{ strikes_geojson: object }>}
 */
export async function fetchLightning(key, opts = {}) {
    const url = new URL(`${API_BASE}/lightning/strikes`, window.location.origin);
    if (key) url.searchParams.set('key', key);
    url.searchParams.set('max_age_minutes', opts.maxAgeMinutes ?? 60);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`fetchLightning(key=${key}) → HTTP ${resp.status}`);
    return { strikes_geojson: await resp.json() };
}

/**
 * Fetch geometry/polygon features (NWS alerts, SPC outlooks, etc.).
 *
 * @param {string} sourceId - e.g. 'NWS_ALERTS', 'SPC_DAY1_OUTLOOK'
 * @param {string} key - valid time key
 * @returns {Promise<{ alerts_geojson: object }>}
 */
export async function fetchGeometries(sourceId, key) {
    const url = new URL(
        `${API_BASE}/geometries/${sourceId}/features`,
        window.location.origin
    );
    if (key) url.searchParams.set('key', key);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`fetchGeometries(${sourceId}, key=${key}) → HTTP ${resp.status}`);
    return { alerts_geojson: await resp.json() };
}

/**
 * Fetch Local Storm Reports.
 *
 * @param {string} key - center valid time key
 * @param {object} [opts] - { windowHours?: number, eventTypes?: string }
 * @returns {Promise<{ lsr_geojson: object }>}
 */
export async function fetchLSRs(key, opts = {}) {
    const url = new URL(`${API_BASE}/points/LSR/lsrs`, window.location.origin);
    url.searchParams.set('center_key', key ?? '');
    url.searchParams.set('window_hours', opts.windowHours ?? 6);
    if (opts.eventTypes) url.searchParams.set('event_types', opts.eventTypes);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`fetchLSRs(key=${key}) → HTTP ${resp.status}`);
    return { lsr_geojson: await resp.json() };
}
