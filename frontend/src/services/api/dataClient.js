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
 * Each function returns fields as RawScalarField objects (autumnplot-gl), already
 * dequantized from int16 transport using the CF-convention scale_factor / add_offset.
 * The .data property of each RawScalarField is a Float32Array ready for RawVectorField.
 *
 * ─── Data flow ─────────────────────────────────────────────────────────────
 *
 *   dataClient.fetchAnalysisFields('MESOANALYSIS_GRID', ['t2m'], '20260227_0000')
 *     → { fields: { t2m: RawScalarField }, grid: apglGrid, gridInfo, key }
 *
 *   The `fields` object is then passed to a product suite's make_layers(data, grid)
 *   which creates the autumnplot-gl visualization layers.
 *
 * ─── Transport format ──────────────────────────────────────────────────────
 *
 *   Gridded endpoints use Protocol Buffers for binary transfer of int16 arrays.
 *   Each int16 value is dequantized on the client: physical = raw * scale_factor + add_offset
 *   This is ~2× smaller than float32 and ~4× smaller than JSON for large 2D grids.
 */

import { decodeGridResponse } from '../decoding/protobufGrid.js';
import { decodePointResponse } from '../decoding/protobufPoints.js';
import { makeApglGrid } from '../../domain/gridFactory.js';
import * as apgl from 'autumnplot-gl';

const API_BASE = '/api/v1';

// ═════════════════════════════════════════════════════════════════════════════
// Client-side field cache
// ═════════════════════════════════════════════════════════════════════════════
//
// In-memory LRU cache for decoded { fields, gridInfo, key } results.
// Avoids redundant HTTP round-trips when the same frame is requested again
// (e.g. re-opening the LayerManager with the same dataset, or toggling between
// frame configurations that share overlapping time ranges).
//
// Eviction policy:
//   - Map insertion order is used as LRU order.  delete+re-insert on each hit
//     promotes an entry to Most-Recently-Used position.
//   - Total Float32Array byte footprint is tracked.  When it exceeds
//     CACHE_MAX_BYTES, LRU entries (front of Map) are evicted until there is
//     enough room for the new entry.
//
// Cache keys:
//   analysis  → "sourceId|var1,var2|apiKey"
//   forecast  → "sourceId|var1,var2|cycle_fFFF"

const CACHE_MAX_BYTES = 512 * 1024 * 1024;  // 512 MiB
let _cacheBytes = 0;

/** @type {Map<string, { result: object, bytes: number }>} */
const _fieldCache = new Map();

// ── Grid object cache ─────────────────────────────────────────────────────────
//
// makeApglGrid() is called once per unique grid geometry and the result is
// reused for every frame that shares the same grid descriptor.  This avoids
// constructing a new PlateCarreeGrid / LambertGrid / etc. on every streamed
// frame (105× for a typical NSSL-GEFS run).
//
// Cache key: pipe-delimited string of the stable gridInfo scalars.

/** @type {Map<string, object>} */
const _gridCache = new Map();

function _getOrMakeGrid(gridInfo) {
    const ck = `${gridInfo.grid_type}|${gridInfo.ni}|${gridInfo.nj}|${gridInfo.lat_min}|${gridInfo.lon_min}|${gridInfo.lat_max}|${gridInfo.lon_max}`;
    if (_gridCache.has(ck)) return _gridCache.get(ck);
    const grid = makeApglGrid(gridInfo);
    _gridCache.set(ck, grid);
    return grid;
}

function _ck(sourceId, variables, key) {
    const varStr = Array.isArray(variables) ? variables.join(',') : variables;
    return `${sourceId}|${varStr}|${key}`;
}

function _cacheGet(ck) {
    const entry = _fieldCache.get(ck);
    if (!entry) return null;
    // Promote to MRU by delete + re-insert
    _fieldCache.delete(ck);
    _fieldCache.set(ck, entry);
    return entry.result;
}

function _cachePut(ck, result) {
    // Estimate bytes from the underlying int16 data arrays (×2 = bytes per element).
    // Multiply by 2 to account for the Float32Array inside each RawScalarField.
    let bytes = 0;
    for (const field of Object.values(result.fields || {})) {
        if (field && field.data instanceof Float32Array) bytes += field.data.byteLength;
    }
    if (bytes === 0) return;

    // If this key is already cached, remove it first so we don't double-count
    const existing = _fieldCache.get(ck);
    if (existing) {
        _fieldCache.delete(ck);
        _cacheBytes -= existing.bytes;
    }

    // Evict LRU entries (front of Map) until there is room
    while (_cacheBytes + bytes > CACHE_MAX_BYTES && _fieldCache.size > 0) {
        const [oldKey, oldEntry] = _fieldCache.entries().next().value;
        _fieldCache.delete(oldKey);
        _cacheBytes -= oldEntry.bytes;
    }

    _fieldCache.set(ck, { result, bytes });
    _cacheBytes += bytes;
}

export function invalidateSourceCache(sourceId) {
    const prefix = `${sourceId}|`;
    for (const [k, entry] of _fieldCache) {
        if (k.startsWith(prefix)) {
            _fieldCache.delete(k);
            _cacheBytes -= entry.bytes;
        }
    }
}

/**
 * Return current cache usage statistics (useful for devtools diagnostics).
 * @returns {{ entries: number, bytes: number, maxBytes: number, utilizationPct: number }}
 */
export function getCacheStats() {
    return {
        entries:        _fieldCache.size,
        bytes:          _cacheBytes,
        maxBytes:       CACHE_MAX_BYTES,
        utilizationPct: Math.round(_cacheBytes / CACHE_MAX_BYTES * 100),
    };
}

// ═════════════════════════════════════════════════════════════════════════════
// Dequantization helpers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Dequantize a decoded field descriptor into a RawScalarField<Float32Array>.
 *
 * For int16 data: applies `physical = raw * scale_factor + add_offset` per-element
 * directly into a Float32Array, then wraps it in a RawScalarField.  Fill sentinel
 * (-32768) is mapped to NaN.
 *
 * This ensures APgL binds the GPU texture as `sampler2D` / `highp float` rather
 * than `isampler2D` / `int`, which would cause a shader type-mismatch error.
 * It also preserves `field.data` as Float32Array for RawVectorField construction.
 *
 * @param {object}  fieldDesc  - { rawData, scale_factor, add_offset, data_type }
 * @param {object}  apglGrid   - APgL Grid instance from makeApglGrid()
 * @returns {RawScalarField}   - dequantized field ready for plotting or .data access
 */
function _dequantize(fieldDesc, apglGrid) {
    const { rawData, scale_factor, add_offset, data_type } = fieldDesc;

    if (data_type === 'int16') {
        // Materialize directly into Float16Array so APgL binds the GPU texture as
        // sampler2D / highp float, not isampler2D / int.
        // (renderCPU() on ComputedScalarField<Int16Array> would call
        //  `new Int16Array([...floatValues])`, truncating the floats and causing
        //  a "cannot convert from mediump int to highp float" shader error.)
        const n   = rawData.length;
        const f16 = new Float16Array(n);
        for (let i = 0; i < n; i++) {
            const v = rawData[i];
            f16[i] = v === -32768 ? NaN : v * scale_factor + add_offset;
        }
        return new apgl.RawScalarField(apglGrid, f16);
    }

    // float32 / float16 (already decoded to Float32Array in protobufGrid.js)
    return new apgl.RawScalarField(apglGrid, rawData);
}

/**
 * Build the standard { fields, grid, gridInfo, key } result from a decoded
 * GridResponse and its associated APgL grid.
 */
function _buildResult(decoded, key) {
    const { fields: rawFields, gridInfo } = decoded;
    if (!gridInfo) return { fields: {}, grid: null, gridInfo: null, key };

    const apglGrid = _getOrMakeGrid(gridInfo);
    const fields   = {};
    for (const [varName, fieldDesc] of Object.entries(rawFields)) {
        fields[varName] = _dequantize(fieldDesc, apglGrid);
    }
    return { fields, grid: apglGrid, gridInfo, key: decoded.key || key };
}

/**
 * Build the standard result from the JSON fallback response.
 * The server returns float32 arrays in JSON; wrap them in RawScalarField.
 */
function _buildResultFromJSON(json) {
    let gridInfo = null;
    const rawArrays = {};
    for (const [varName, fieldData] of Object.entries(json.fields || {})) {
        rawArrays[varName] = new Float32Array(fieldData.data);
        if (!gridInfo && fieldData.grid) gridInfo = fieldData.grid;
    }
    if (!gridInfo) return { fields: {}, grid: null, gridInfo: null, key: json.key };

    const apglGrid = _getOrMakeGrid(gridInfo);
    const fields   = {};
    for (const [varName, arr] of Object.entries(rawArrays)) {
        fields[varName] = new apgl.RawScalarField(apglGrid, arr);
    }
    return { fields, grid: apglGrid, gridInfo, key: json.key };
}

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
 *   fields:   Object<string, RawScalarField>,  // dequantized APgL fields
 *   grid:     object,                           // APgL Grid instance
 *   gridInfo: object|null,                      // raw grid descriptor
 *   key:      string
 * }>}
 */
export async function fetchAnalysisFields(sourceId, variables, key, opts = {}) {
    const ck = _ck(sourceId, variables, key);
    const cached = _cacheGet(ck);
    if (cached) return cached;

    const url = new URL(`${API_BASE}/gridded/${sourceId}/field`, window.location.origin);
    url.searchParams.set('variables', variables.join(','));
    if (key)        url.searchParams.set('key', key);
    if (opts.level) url.searchParams.set('level', opts.level);
    if (opts.bbox)  url.searchParams.set('bbox', opts.bbox);

    const resp = await fetch(url.toString(), {
        headers: { 'Accept': 'application/x-protobuf' },
    });
    if (!resp.ok) {
        throw new Error(
            `fetchAnalysisFields(${sourceId}, key=${key}) failed: HTTP ${resp.status}`
        );
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/x-protobuf')) {
        const buffer = await resp.arrayBuffer();
        const decoded = decodeGridResponse(buffer);
        const result  = _buildResult(decoded, key);
        _cachePut(ck, result);
        return result;
    }

    // JSON fallback: wrap raw arrays in RawScalarField
    const json = await resp.json();
    const result = _buildResultFromJSON(json);
    _cachePut(ck, result);
    return result;
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
 *   fields:   Object<string, RawScalarField>,
 *   grid:     object,
 *   gridInfo: object|null,
 *   key:      string
 * }>}
 */
export async function fetchForecastFields(sourceId, variables, cycle, fhr, opts = {}) {
    const fcKey = `${cycle}_f${String(fhr).padStart(3, '0')}`;
    const ck = _ck(sourceId, variables, fcKey);
    const cached = _cacheGet(ck);
    if (cached) return cached;

    const url = new URL(`${API_BASE}/gridded/${sourceId}/forecast`, window.location.origin);
    url.searchParams.set('variables', variables.join(','));
    url.searchParams.set('cycle', cycle);
    url.searchParams.set('fhr', String(fhr));
    if (opts.level) url.searchParams.set('level', opts.level);

    const resp = await fetch(url.toString(), {
        headers: { 'Accept': 'application/x-protobuf' },
    });
    if (!resp.ok) {
        throw new Error(
            `fetchForecastFields(${sourceId}, cycle=${cycle}, fhr=${fhr}) failed: HTTP ${resp.status}`
        );
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('application/x-protobuf')) {
        const buffer  = await resp.arrayBuffer();
        const decoded = decodeGridResponse(buffer);
        const result  = _buildResult(decoded, fcKey);
        _cachePut(ck, result);
        return result;
    }

    // JSON fallback
    const json   = await resp.json();
    const result = _buildResultFromJSON(json);
    _cachePut(ck, result);
    return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// Streaming Forecast Batch
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Stream multiple forecast frames over a single HTTP connection.
 *
 * The server sends length-prefixed protobuf GridResponse messages.
 * Each frame is decoded and passed to `onFrame` as soon as it arrives.
 *
 * @param {string}   sourceId   - e.g. 'HREF'
 * @param {string[]} variables  - e.g. ['mean_TMP_hght_2']
 * @param {string}   cycle      - model init time, e.g. '2026032712'
 * @param {number[]} fhrs       - forecast hours, e.g. [0, 1, 2, ..., 48]
 * @param {function} onFrame    - called with ({ fields, grid, gridInfo, key, fhr }) for each frame
 * @param {object}   [opts]     - { level?: string }
 * @returns {Promise<void>}     - resolves when all frames have been streamed
 */
export async function streamForecastFrames(sourceId, variables, cycle, fhrs, onFrame, opts = {}) {
    // Serve any already-cached frames immediately without hitting the network.
    const uncachedFhrs = [];
    for (const fhr of fhrs) {
        const serverKey = `${cycle}_f${String(fhr).padStart(3, '0')}`;
        const ck = _ck(sourceId, variables, serverKey);
        const cached = _cacheGet(ck);
        if (cached) {
            onFrame({ ...cached, key: serverKey, fhr });
            await new Promise(r => setTimeout(r, 0));
        } else {
            uncachedFhrs.push(fhr);
        }
    }
    if (!uncachedFhrs.length) return;

    const url = new URL(`${API_BASE}/gridded/${sourceId}/forecast_stream`, window.location.origin);
    url.searchParams.set('variables', variables.join(','));
    url.searchParams.set('cycle', cycle);
    url.searchParams.set('fhrs', uncachedFhrs.join(','));
    if (opts.level) url.searchParams.set('level', opts.level);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(
            `streamForecastFrames(${sourceId}, cycle=${cycle}) failed: HTTP ${resp.status}`
        );
    }

    const reader = resp.body.getReader();
    let buffer = new Uint8Array(0);

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;

        while (buffer.length >= 4) {
            const msgLen = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
            if (buffer.length < 4 + msgLen) break;

            const msgBytes = buffer.slice(4, 4 + msgLen);
            buffer = buffer.slice(4 + msgLen);

            const decoded   = decodeGridResponse(msgBytes.buffer);
            const serverKey = decoded.key || `${cycle}_f${String(decoded.fhr >= 0 ? decoded.fhr : 0).padStart(3, '0')}`;
            const result    = _buildResult(decoded, serverKey);
            _cachePut(_ck(sourceId, variables, serverKey), result);
            onFrame({ ...result, fhr: decoded.fhr });

            await new Promise(r => setTimeout(r, 0));
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Streaming Analysis Batch
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Stream multiple analysis frames over a single HTTP connection.
 *
 * Analogous to streamForecastFrames but works with analysis/observation
 * sources (MRMS, GOES, mesoanalysis) where each frame is a separate file
 * on disk keyed by valid time.
 *
 * Already-cached frames are served from the in-memory cache immediately
 * (zero network latency).  Only uncached keys are sent to the server.
 *
 * @param {string}   sourceId   - e.g. 'MRMS_CONUS_CREF' or 'GOES-E_CONUS_C08'
 * @param {string[]} variables  - e.g. ['cref'] or ['CMI']
 * @param {string[]} keys       - valid-time keys, e.g. ['20260316_1800', '20260316_1900']
 * @param {function} onFrame    - called with ({ fields, grid, gridInfo, key }) for each frame
 * @param {object}   [opts]     - { level?: string }
 * @returns {Promise<void>}     - resolves when all frames have been delivered
 */
export async function streamAnalysisFrames(sourceId, variables, keys, onFrame, opts = {}) {
    // Serve cached frames immediately; collect uncached keys for the HTTP request.
    const uncachedKeys = [];
    for (const key of keys) {
        const ck = _ck(sourceId, variables, key);
        const cached = _cacheGet(ck);
        if (cached) {
            onFrame({ ...cached, key });
            await new Promise(r => setTimeout(r, 0));
        } else {
            uncachedKeys.push(key);
        }
    }
    if (!uncachedKeys.length) return;

    const varStr = Array.isArray(variables) ? variables.join(',') : variables;
    const url = new URL(`${API_BASE}/gridded/${sourceId}/analysis_stream`, window.location.origin);
    url.searchParams.set('variables', varStr);
    url.searchParams.set('keys', uncachedKeys.join(','));
    if (opts.level) url.searchParams.set('level', opts.level);

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(
            `streamAnalysisFrames(${sourceId}) failed: HTTP ${resp.status}`
        );
    }

    const reader = resp.body.getReader();
    let buffer = new Uint8Array(0);

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;

        while (buffer.length >= 4) {
            const msgLen = new DataView(buffer.buffer, buffer.byteOffset, 4).getUint32(0);
            if (buffer.length < 4 + msgLen) break;

            const msgBytes = buffer.slice(4, 4 + msgLen);
            buffer = buffer.slice(4 + msgLen);

            const decoded = decodeGridResponse(msgBytes.buffer);
            const result  = _buildResult(decoded, decoded.key);
            _cachePut(_ck(sourceId, variables, decoded.key), result);
            onFrame(result);

            await new Promise(r => setTimeout(r, 0));
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Point / Observation / Geometry Data
// ═════════════════════════════════════════════════════════════════════════════

// ── Point data cache ─────────────────────────────────────────────────────────
//
// GeoJSON FeatureCollections for point sources are cached here so that looping
// through frames (e.g. lightning) doesn't re-fetch the same time window on
// every pass.
//
// Cache key: "sourceId|centerKey"  — window parameters are source-defined on
// the backend so the same centerKey always produces the same result.
// Eviction: simple LRU via Map insertion order; capped at POINT_CACHE_MAX entries.

const POINT_CACHE_MAX = 60;   // frames; large enough for a typical loop
/** @type {Map<string, object>} */
const _pointCache = new Map();

function _pointCacheGet(ck) {
    const val = _pointCache.get(ck);
    if (!val) return null;
    // Promote to MRU
    _pointCache.delete(ck);
    _pointCache.set(ck, val);
    return val;
}

function _pointCachePut(ck, fc) {
    if (_pointCache.size >= POINT_CACHE_MAX) {
        // Evict LRU (first entry in Map)
        _pointCache.delete(_pointCache.keys().next().value);
    }
    _pointCache.set(ck, fc);
}

/**
 * Invalidate all cached point frames for a given sourceId.
 * @param {string} sourceId
 */
export function invalidatePointCache(sourceId) {
    const prefix = `${sourceId}|`;
    for (const k of _pointCache.keys()) {
        if (k.startsWith(prefix)) _pointCache.delete(k);
    }
}

/**
 * Fetch point observation data for a source from the db-points endpoint.
 *
 * Used for sources with endpoint_type === 'point_obs' (e.g. LIGHTNING, AIRNOW).
 * The `centerKey` is the time key from the catalog; the backend translates
 * it to the centre of the query time window using the source's configured
 * binflag/before_minutes/after_minutes settings.
 *
 * Results are cached by (sourceId, centerKey) — repeated requests for the same
 * frame (e.g. during loop playback) are served from memory with no network round-trip.
 *
 * @param {string} sourceId     - e.g. 'LIGHTNING' or 'AIRNOW'
 * @param {string} centerKey    - valid time key, e.g. '20260409_1800'
 * @param {object} [opts]
 * @param {string} [opts.bbox]           - 'lon_min,lat_min,lon_max,lat_max'
 * @param {number} [opts.windowMinutes]  - overrides source-default window (use sparingly)
 * @param {number} [opts.limit]          - max point rows
 * @returns {Promise<object>}   GeoJSON FeatureCollection
 */
export async function fetchPointData(sourceId, centerKey, opts = {}) {
    const ck = `${sourceId}|${centerKey}`;
    const cached = _pointCacheGet(ck);
    if (cached) return cached;

    const url = new URL(`${API_BASE}/db-points/${sourceId}`, window.location.origin);
    if (centerKey)           url.searchParams.set('center', centerKey);
    if (opts.bbox)           url.searchParams.set('bbox', opts.bbox);
    if (opts.windowMinutes)  url.searchParams.set('window_minutes', String(opts.windowMinutes));
    if (opts.limit)          url.searchParams.set('limit', String(opts.limit));
    url.searchParams.set('format', 'geojson');

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(`fetchPointData(${sourceId}, key=${centerKey}) failed: HTTP ${resp.status}`);
    }
    const fc = await resp.json();
    _pointCachePut(ck, fc);
    return fc;
}

/**
 * Fetch DB-backed point observations via protobuf and return them as an
 * obs_json array ready for buildObsLayer().
 *
 * Unlike fetchPointData() (which returns raw GeoJSON), this function:
 *   1. Requests data as application/x-protobuf for compact binary transfer.
 *   2. Decodes the PointResponse message and reassembles each point's
 *      lat/lon + variable map into the { coord, data } shape that
 *      buildObsLayer() and RawObsField expect.
 *   3. Builds the UnstructuredGrid per-frame from the response lat/lon values
 *      rather than from a separate grid_info query — essential for moving
 *      sources (ships, aircraft) whose point positions change each frame.
 *
 * The `fields` array controls which property keys the backend includes in
 * each PointObs.variables map.  Pass only the keys your product's SPConfig
 * references to minimise payload size.
 *
 * @param {string}   sourceId   - e.g. 'SHIP'
 * @param {string[]} fields     - property keys to request, e.g. ['tmpc','dwpc','sknt','drct']
 * @param {string}   centerKey  - valid time key, e.g. '20260409_1700'
 * @param {object}   [opts]
 * @param {string}   [opts.bbox]          - 'lon_min,lat_min,lon_max,lat_max'
 * @param {number}   [opts.windowMinutes] - symmetric time window override
 * @param {number}   [opts.limit]         - max row count
 * @returns {Promise<{
 *   obs_json: Array<{ coord: {lat:number,lon:number}, valid_time: string, data: object }>,
 *   meta:     object,
 * }>}
 */
export async function fetchDbPoints(sourceId, fields, centerKey, opts = {}) {
    const fieldsKey = fields.length ? fields.join(',') : '__all__';
    const ck = `${sourceId}|${centerKey}|${fieldsKey}`;
    const cached = _pointCacheGet(ck);
    if (cached) return cached;

    const url = new URL(`${API_BASE}/db-points/${sourceId}`, window.location.origin);
    if (centerKey)           url.searchParams.set('center', centerKey);
    if (fields.length)       url.searchParams.set('fields', fields.join(','));
    if (opts.bbox)           url.searchParams.set('bbox', opts.bbox);
    if (opts.windowMinutes)  url.searchParams.set('window_minutes', String(opts.windowMinutes));
    if (opts.limit)          url.searchParams.set('limit', String(opts.limit));

    const resp = await fetch(url.toString(), {
        headers: { 'Accept': 'application/x-protobuf' },
    });
    if (!resp.ok) {
        throw new Error(`fetchDbPoints(${sourceId}, key=${centerKey}) failed: HTTP ${resp.status}`);
    }

    const buffer = await resp.arrayBuffer();
    const decoded = decodePointResponse(buffer);

    const result = { obs_json: decoded.points, meta: decoded.meta };
    _pointCachePut(ck, result);
    return result;
}

/**
 * Fetch geometry features (NWS alerts, SPC outlooks, etc.) for a source.
 *
 * When `opts.phen` is provided the request goes to the `by_type` endpoint:
 *   GET /api/v1/geometries/{sourceId}/by_type?type_name={phen}&key={key}
 * Otherwise the `features` endpoint is used (returns all phenomena):
 *   GET /api/v1/geometries/{sourceId}/features?key={key}
 *
 * @param {string} sourceId           - e.g. 'WARNINGS'
 * @param {string} [key]              - valid time key, e.g. '20260420_2200'
 * @param {object} [opts]
 * @param {string} [opts.bbox]        - 'lon_min,lat_min,lon_max,lat_max'
 * @param {string} [opts.phen]        - phenomenon slug, e.g. 'flash_flood' or 'tornado'
 * @param {number} [opts.simplifyDeg] - polygon simplification tolerance in degrees
 * @returns {Promise<object>}         GeoJSON FeatureCollection
 */
export async function fetchGeometryFeatures(sourceId, key, opts = {}) {
    const endpoint = opts.phen ? 'by_type' : 'features';
    const url = new URL(
        `${API_BASE}/geometries/${sourceId}/${endpoint}`,
        window.location.origin
    );
    if (key)               url.searchParams.set('key', key);
    if (opts.phen)         url.searchParams.set('type_name', opts.phen);
    if (opts.bbox)         url.searchParams.set('bbox', opts.bbox);
    if (opts.simplifyDeg)  url.searchParams.set('simplify_deg', String(opts.simplifyDeg));

    const resp = await fetch(url.toString());
    if (!resp.ok) {
        throw new Error(`fetchGeometryFeatures(${sourceId}, key=${key}) failed: HTTP ${resp.status}`);
    }
    return resp.json();
}

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
 * @deprecated Prefer fetchGeometryFeatures() which uses the correct `at` query param.
 * @param {string} sourceId - e.g. 'WARNINGS'
 * @param {string} key - valid time key
 * @returns {Promise<{ alerts_geojson: object }>}
 */
export async function fetchGeometries(sourceId, key) {
    return fetchGeometryFeatures(sourceId, key).then(fc => ({ alerts_geojson: fc }));
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
