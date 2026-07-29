/**
 * zarrClient.js — Zarr-over-HTTP field fetcher
 *
 * Replaces the protobuf path for sources that have `zarr_transport: true` in
 * the catalog.  Instead of the backend decompressing arrays and re-serialising
 * them as protobuf, the raw (Blosc/LZ4/zstd-compressed) zarr chunk bytes
 * travel over the wire and are decompressed by zarr.js + numcodecs WASM in
 * the browser.
 *
 * ── Why this saves bandwidth ───────────────────────────────────────────────
 *
 *   Old path:  zarr (compressed) → Python decompresses → float16/int16 →
 *              protobuf bytes → wire → JS decode → Float32Array
 *
 *   New path:  zarr (compressed) → raw bytes → wire → zarr.js decompress →
 *              TypedArray → Float32Array
 *
 *   The compressed bytes travel on the wire — the compression ratio you
 *   achieved at ingest time (uint8+Blosc for imagery, float16+zstd for
 *   analyses) is fully realised as reduced network traffic.
 *
 * ── URL layout served by zarr_proxy.py ────────────────────────────────────
 *
 *   /api/v1/zarr/{sourceId}/{key}/.zattrs
 *   /api/v1/zarr/{sourceId}/{key}/.zgroup
 *   /api/v1/zarr/{sourceId}/{key}/{variable}/.zarray
 *   /api/v1/zarr/{sourceId}/{key}/{variable}/{chunkCoords}
 *
 * ── Client-side cache ─────────────────────────────────────────────────────
 *
 *   Results are stored in a simple Map keyed by "sourceId|varNames|key".
 *   The same LRU-style eviction logic used by dataClient.js could be added
 *   here later; for now a simple Map is sufficient because the removeFrame
 *   memory management in appController.js handles the dominant pressure.
 *
 * ── Compression codec support ─────────────────────────────────────────────
 *
 *   zarrita supports Zarr v2 and v3, and handles blosc, zstd, gzip, zlib,
 *   and raw (uncompressed) arrays.  Float16 dtype is also supported natively.
 */

import { FetchStore, open, get, root } from 'zarrita';
import * as apgl from 'autumnplot-gl';
import { makeApglGrid } from '../../domain/gridFactory.js';

const ZARR_API_BASE = '/api/v1/zarr';

// ─── Simple result cache ───────────────────────────────────────────────────
// Keys: "sourceId|var1,var2|frameKey"
/** @type {Map<string, object>} */
const _cache = new Map();
const _CACHE_MAX = 256;   // evict oldest when limit reached

function _ck(sourceId, variables, key) {
    const vs = Array.isArray(variables) ? variables.join(',') : variables;
    return `${sourceId}|${vs}|${key}`;
}

function _cacheGet(ck) { return _cache.get(ck) ?? null; }

function _cachePut(ck, result) {
    if (_cache.size >= _CACHE_MAX) {
        // Evict LRU (insertion-order) entry
        _cache.delete(_cache.keys().next().value);
    }
    _cache.set(ck, result);
}

export function invalidateZarrSourceCache(sourceId) {
    const prefix = `${sourceId}|`;
    for (const k of _cache.keys()) {
        if (k.startsWith(prefix)) _cache.delete(k);
    }
}

// ─── Core fetch helpers ────────────────────────────────────────────────────

/**
 * Open the HTTPStore for a given source + frame key.
 * The store base URL is the zarr_proxy endpoint for this source/key.
 */
function _openStore(sourceId, key) {
    const baseUrl = `${window.location.origin}${ZARR_API_BASE}/${sourceId}/${key}`;
    return new FetchStore(baseUrl);
}

/**
 * Read a single 2-D variable from a zarr store and return it as a Float16Array.
 *
 * Handles Zarr v2 and v3, and all on-disk dtypes (uint8, uint16, float16,
 * float32).  zarrita manages codec/decompression automatically.
 *
 * @param {object} store   - zarrita FetchStore
 * @param {string} varName - zarr array name, e.g. "mean_MSLMA"
 * @param {number} [tIdx]  - time index for 3-D (t, nj, ni) stores; default 0
 * @returns {Promise<Float16Array>}
 */
async function _readArray(store, varName, tIdx = 0) {
    const arr = await open(root(store).resolve(varName), { kind: 'array' });
    const shape = arr.shape;

    // Build selection: scalar index collapses the time axis; null = all elements.
    let selection;
    if (shape.length === 3) {
        selection = [tIdx, null, null];
    } else {
        selection = [null, null];
    }

    const result = await get(arr, selection);

    // zarrita returns an ndarray-like object; .data is the flat TypedArray.
    const flat = result.data;

    if (flat instanceof Float16Array) return flat;

    // Cast everything else (float32, uint8, uint16, …) to Float16Array so
    // apgl.RawScalarField gets a consistent input type.
    const out = new Float16Array(flat.length);
    out.set(flat);
    return out;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch multiple gridded fields from a zarr store for one frame.
 *
 * The variable name mapping (generic app name → zarr array name) should be
 * provided via `zarrVarMap`; if a variable is absent from the map the
 * generic name is used directly as the zarr array name.
 *
 * @param {string}   sourceId    - e.g. "MESOANALYSIS_GRID"
 * @param {string}   key         - frame key, e.g. "20260430_1200"
 * @param {string[]} variables   - generic variable names, e.g. ["mean_MSLMA", "mlcape"]
 * @param {object}   gridInfo    - grid descriptor from CatalogClient.fetchGridInfoCached()
 * @param {object}   [opts]
 * @param {Object<string,string>} [opts.zarrVarMap] - map generic name → zarr array name
 * @param {number}               [opts.tIdx]        - time index for 3-D stores (default 0)
 * @returns {Promise<{fields: Object<string, RawScalarField>, grid: object, gridInfo: object, key: string}>}
 */
export async function fetchZarrFields(sourceId, key, variables, gridInfo, opts = {}) {
    const ck = _ck(sourceId, variables, key);
    const cached = _cacheGet(ck);
    if (cached) return cached;

    const { zarrVarMap = {}, tIdx = 0 } = opts;
    const store = _openStore(sourceId, key);
    const apglGrid = makeApglGrid(gridInfo);

    // Fetch all variables in parallel
    const entries = await Promise.all(
        variables.map(async (varName) => {
            const zarrName = zarrVarMap[varName] ?? varName;
            try {
                const data = await _readArray(store, zarrName, tIdx);
                return [varName, new apgl.RawScalarField(apglGrid, data)];
            } catch (err) {
                console.warn(
                    `[zarrClient] Failed to read "${zarrName}" from ` +
                    `${sourceId}/${key}:`, err.message
                );
                return [varName, null];
            }
        })
    );

    // Drop variables that failed to load (null) so make_layers() sees the same
    // shape as it would from the protobuf path (missing keys simply absent).
    const fields = Object.fromEntries(entries.filter(([, v]) => v !== null));

    const result = { fields, grid: apglGrid, gridInfo, key };
    _cachePut(ck, result);
    return result;
}

// ─── Forecast (fhr-slice) API ──────────────────────────────────────────────
//
// The backend exposes a virtual 2-D store per forecast hour at:
//   /api/v1/zarr/{sourceId}/{cycle}/fhr/{fhr}/...
//
// From zarr.js's perspective this looks identical to a regular 2-D analysis
// store.  The backend hides the time axis, maps the fhr → t_idx, and either
// serves the raw chunk verbatim (fast path, chunk_t==1) or decompresses/
// re-slices (slow path, chunk_t>1).

/**
 * Open the HTTPStore for a specific forecast hour.
 * @param {string} sourceId
 * @param {string} cycle    - e.g. "2026050700"
 * @param {number} fhr      - e.g. 24
 */
function _openForecastStore(sourceId, cycle, fhr) {
    const baseUrl = `${window.location.origin}${ZARR_API_BASE}/${sourceId}/${cycle}/fhr/${fhr}`;
    return new FetchStore(baseUrl);
}

/**
 * Fetch multiple gridded forecast fields for one cycle + fhr.
 *
 * The variable name mapping (generic app name → zarr array name) should be
 * provided via `zarrVarMap`; if a variable is absent the generic name is used.
 *
 * @param {string}   sourceId   - e.g. "HREF"
 * @param {string}   cycle      - model init time key, e.g. "2026050700"
 * @param {number}   fhr        - forecast hour, e.g. 12
 * @param {string[]} variables  - generic variable names
 * @param {object}   gridInfo   - grid descriptor from catalog
 * @param {object}   [opts]
 * @param {Object<string,string>} [opts.zarrVarMap] - generic name → zarr array name
 * @returns {Promise<{fields: Object<string, RawScalarField>, grid, gridInfo, key, fhr}>}
 */
export async function fetchZarrForecastFields(sourceId, cycle, fhr, variables, gridInfo, opts = {}) {
    const fcKey = `${cycle}_f${String(fhr).padStart(3, '0')}`;
    const ck = _ck(sourceId, variables, fcKey);
    const cached = _cacheGet(ck);
    if (cached) return cached;

    const { zarrVarMap = {} } = opts;
    const store = _openForecastStore(sourceId, cycle, fhr);
    const apglGrid = makeApglGrid(gridInfo);

    const entries = await Promise.all(
        variables.map(async (varName) => {
            const zarrName = zarrVarMap[varName] ?? varName;
            try {
                // The virtual store is already 2-D — no tIdx needed.
                const data = await _readArray(store, zarrName, 0);
                return [varName, new apgl.RawScalarField(apglGrid, data)];
            } catch (err) {
                console.warn(
                    `[zarrClient] fetchZarrForecastFields: failed to read ` +
                    `"${zarrName}" from ${sourceId}/${cycle}/fhr/${fhr}:`, err.message
                );
                return [varName, null];
            }
        })
    );

    const fields = Object.fromEntries(entries.filter(([, v]) => v !== null));
    const result = { fields, grid: apglGrid, gridInfo, key: fcKey, fhr };
    _cachePut(ck, result);
    return result;
}

/**
 * Stream multiple forecast frames via the fhr-slice zarr passthrough.
 *
 * Analogous to dataClient.streamForecastFrames.  Fetches frames in parallel
 * batches and calls onFrame as each resolves.  Already-cached frames are
 * delivered synchronously before any network requests.
 *
 * @param {string}   sourceId    - e.g. "HREF"
 * @param {string}   cycle       - model init time key, e.g. "2026050700"
 * @param {number[]} fhrs        - forecast hours to load, e.g. [0, 1, 2, ..., 48]
 * @param {string[]} variables   - generic variable names
 * @param {object}   gridInfo    - grid descriptor from catalog
 * @param {function} onFrame     - called with ({ fields, grid, gridInfo, key, fhr }) for each frame
 * @param {object}   [opts]      - { zarrVarMap?, concurrency? }
 */
export async function streamZarrForecastFrames(
    sourceId, cycle, fhrs, variables, gridInfo, onFrame, opts = {}
) {
    const { concurrency = 4, ...fetchOpts } = opts;

    // Serve cached frames first (synchronously, in order).
    const uncachedFhrs = [];
    for (const fhr of fhrs) {
        const fcKey = `${cycle}_f${String(fhr).padStart(3, '0')}`;
        const ck = _ck(sourceId, variables, fcKey);
        const cached = _cacheGet(ck);
        if (cached) {
            onFrame({ ...cached, key: fcKey, fhr });
            await new Promise(r => setTimeout(r, 0));
        } else {
            uncachedFhrs.push(fhr);
        }
    }
    if (!uncachedFhrs.length) return;

    // Fetch uncached frames in batches.
    for (let i = 0; i < uncachedFhrs.length; i += concurrency) {
        const batch = uncachedFhrs.slice(i, i + concurrency);
        const results = await Promise.allSettled(
            batch.map(fhr =>
                fetchZarrForecastFields(sourceId, cycle, fhr, variables, gridInfo, fetchOpts)
            )
        );
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            const fhr = batch[j];
            if (r.status === 'fulfilled') {
                onFrame({ ...r.value, fhr });
            } else {
                console.warn(
                    `[zarrClient] streamZarrForecastFrames: fhr=${fhr} for ` +
                    `"${sourceId}/${cycle}" failed:`, r.reason?.message
                );
            }
            await new Promise(r2 => setTimeout(r2, 0));
        }
    }
}

/**
 * Stream multiple analysis frames via the zarr passthrough.
 *
 * Analogous to dataClient.streamAnalysisFrames — calls onFrame for each
 * successfully loaded frame, in order.  Frames are fetched with limited
 * concurrency to avoid flooding the server with chunk requests.
 *
 * Already-cached frames are delivered synchronously before network requests.
 *
 * @param {string}   sourceId    - e.g. "MESOANALYSIS_GRID"
 * @param {string[]} variables   - generic variable names
 * @param {string[]} keys        - frame keys to load, oldest → newest
 * @param {object}   gridInfo    - grid descriptor
 * @param {function} onFrame     - called with ({ fields, grid, gridInfo, key }) for each frame
 * @param {object}   [opts]      - { zarrVarMap?, tIdx?, concurrency? }
 */
export async function streamZarrAnalysisFrames(
    sourceId, variables, keys, gridInfo, onFrame, opts = {}
) {
    const { concurrency = 4, ...fetchOpts } = opts;

    // Serve cached frames first
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

    // Fetch uncached frames in batches
    for (let i = 0; i < uncachedKeys.length; i += concurrency) {
        const batch = uncachedKeys.slice(i, i + concurrency);
        const results = await Promise.allSettled(
            batch.map(key => fetchZarrFields(sourceId, key, variables, gridInfo, fetchOpts))
        );
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status === 'fulfilled') {
                onFrame({ ...r.value, key: batch[j] });
            } else {
                console.warn(
                    `[zarrClient] Frame "${batch[j]}" for "${sourceId}" failed:`,
                    r.reason?.message
                );
            }
            await new Promise(r2 => setTimeout(r2, 0));
        }
    }
}
