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
import { runRollingFramePipeline, yieldToBrowser } from '../rollingFramePipeline.js';

const ZARR_API_BASE = '/api/v1/zarr';

// ─── Simple result cache ───────────────────────────────────────────────────
// Keys: "sourceId|var1,var2|frameKey"
/** @type {Map<string, object>} */
const _cache = new Map();
const _CACHE_MAX = 256;   // evict oldest when limit reached

// Grid instances can be large (MRMS is 7000×3500) and are immutable for a
// given geometry. Cache by the complete geometry descriptor so fixed grids are
// shared while future moving grids naturally receive distinct instances.
const _gridCache = new Map();

function _gridCacheKey(gridInfo) {
    const projParams = Object.fromEntries(
        Object.entries(gridInfo.proj_params || {}).sort(([a], [b]) => a.localeCompare(b))
    );
    return JSON.stringify({
        grid_type: gridInfo.grid_type,
        ni: gridInfo.ni, nj: gridInfo.nj,
        lat_min: gridInfo.lat_min, lat_max: gridInfo.lat_max,
        lon_min: gridInfo.lon_min, lon_max: gridInfo.lon_max,
        dx: gridInfo.dx, dy: gridInfo.dy,
        ll_x: gridInfo.ll_x, ll_y: gridInfo.ll_y,
        ur_x: gridInfo.ur_x, ur_y: gridInfo.ur_y,
        sat_lon: gridInfo.sat_lon,
        proj_params: projParams,
    });
}

function _getOrMakeGrid(gridInfo) {
    const key = _gridCacheKey(gridInfo);
    const cached = _gridCache.get(key);
    if (cached) return { grid: cached, cacheHit: true, buildMs: 0 };

    const started = performance.now();
    const grid = makeApglGrid(gridInfo);
    const buildMs = performance.now() - started;
    _gridCache.set(key, grid);
    return { grid, cacheHit: false, buildMs };
}

function _resolveGrid(gridInfo, suppliedGrid) {
    const key = _gridCacheKey(gridInfo);
    if (suppliedGrid) {
        const cached = _gridCache.get(key);
        if (cached) return { grid: cached, cacheHit: true, supplied: cached === suppliedGrid, buildMs: 0 };
        _gridCache.set(key, suppliedGrid);
        return { grid: suppliedGrid, cacheHit: false, supplied: true, buildMs: 0 };
    }
    return { ..._getOrMakeGrid(gridInfo), supplied: false };
}

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

function _logVariableTimings(sourceId, key, entries) {
    for (const [name, field, timing] of entries) {
        if (field === null || timing === null) continue;
        console.info(`[NMAP Zarr variable timing] ${sourceId}/${key}/${name}`, {
            openMetadataMs: +timing.openMetadataMs.toFixed(1),
            fetchDecodeMs: +timing.fetchDecodeMs.toFixed(1),
            convertMs: +timing.convertMs.toFixed(1),
            maxEventLoopLagMs: +timing.maxEventLoopLagMs.toFixed(1),
            postDecodeYieldMs: +timing.postDecodeYieldMs.toFixed(1),
            totalMs: +timing.totalMs.toFixed(1),
            elements: timing.elements,
            decodedBytes: timing.decodedBytes,
            sourceType: timing.sourceType ?? 'Float16Array',
        });
    }
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
    const started = performance.now();
    const openStarted = performance.now();
    const arr = await open(root(store).resolve(varName), { kind: 'array' });
    const openFinished = performance.now();
    const shape = arr.shape;

    // Build selection: scalar index collapses the time axis; null = all elements.
    let selection;
    if (shape.length === 3) {
        selection = [tIdx, null, null];
    } else {
        selection = [null, null];
    }

    const getStarted = performance.now();
    let maxEventLoopLagMs = 0;
    const lagSampleMs = 25;
    let expectedTick = performance.now() + lagSampleMs;
    const lagTimer = setInterval(() => {
        const now = performance.now();
        maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - expectedTick);
        expectedTick = now + lagSampleMs;
    }, lagSampleMs);

    let result;
    try {
        result = await get(arr, selection);
        // Promise continuations run as microtasks. Yield once so a timer delayed
        // by synchronous codec work can record that delay before it is cleared.
        await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
        clearInterval(lagTimer);
    }
    const getFinished = performance.now();

    // zarrita returns an ndarray-like object; .data is the flat TypedArray.
    const flat = result.data;

    if (flat instanceof Float16Array) {
        const postDecodeYieldMs = await yieldToBrowser();
        return {
            data: flat,
            timing: {
                openMetadataMs: openFinished - openStarted,
                fetchDecodeMs: getFinished - getStarted,
                convertMs: 0,
                maxEventLoopLagMs,
                postDecodeYieldMs,
                totalMs: performance.now() - started,
                elements: flat.length,
                decodedBytes: flat.byteLength,
            },
        };
    }

    // Cast everything else (float32, uint8, uint16, …) to Float16Array so
    // apgl.RawScalarField gets a consistent input type.
    const out = new Float16Array(flat.length);
    const convertStarted = performance.now();
    out.set(flat);
    const convertFinished = performance.now();
    const postDecodeYieldMs = await yieldToBrowser();
    return {
        data: out,
        timing: {
            openMetadataMs: openFinished - openStarted,
            fetchDecodeMs: getFinished - getStarted,
            convertMs: convertFinished - convertStarted,
            maxEventLoopLagMs,
            postDecodeYieldMs,
            totalMs: performance.now() - started,
            elements: out.length,
            decodedBytes: out.byteLength,
            sourceType: flat.constructor?.name,
        },
    };
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
    const frameStarted = performance.now();
    const ck = _ck(sourceId, variables, key);
    const cached = _cacheGet(ck);
    if (cached) {
        console.info(`[NMAP Zarr timing] ${sourceId}/${key}: cache hit`, {
            totalMs: +(performance.now() - frameStarted).toFixed(1),
        });
        return cached;
    }

    const { zarrVarMap = {}, tIdx = 0, apglGrid: suppliedGrid = null } = opts;
    const store = _openStore(sourceId, key);
    const gridResult = _resolveGrid(gridInfo, suppliedGrid);
    const apglGrid = gridResult.grid;

    // Fetch all variables in parallel
    const entries = await Promise.all(
        variables.map(async (varName) => {
            const zarrName = zarrVarMap[varName] ?? varName;
            try {
                const { data, timing } = await _readArray(store, zarrName, tIdx);
                return [varName, new apgl.RawScalarField(apglGrid, data), timing];
            } catch (err) {
                console.warn(
                    `[zarrClient] Failed to read "${zarrName}" from ` +
                    `${sourceId}/${key}:`, err.message
                );
                return [varName, null, null];
            }
        })
    );

    // Drop variables that failed to load (null) so make_layers() sees the same
    // shape as it would from the protobuf path (missing keys simply absent).
    const fields = Object.fromEntries(entries.filter(([, v]) => v !== null).map(([k, v]) => [k, v]));

    const result = { fields, grid: apglGrid, gridInfo, key };
    _cachePut(ck, result);
    _logVariableTimings(sourceId, key, entries);
    console.info(`[NMAP Zarr timing] ${sourceId}/${key}: frame ready`, {
        gridCacheHit: gridResult.cacheHit,
        suppliedGridReused: gridResult.supplied,
        gridBuildMs: +gridResult.buildMs.toFixed(1),
        variables: Object.fromEntries(entries.filter(([, v]) => v !== null).map(([name, , timing]) => [
            name,
            {
                openMetadataMs: +timing.openMetadataMs.toFixed(1),
                fetchDecodeMs: +timing.fetchDecodeMs.toFixed(1),
                convertMs: +timing.convertMs.toFixed(1),
                maxEventLoopLagMs: +timing.maxEventLoopLagMs.toFixed(1),
                postDecodeYieldMs: +timing.postDecodeYieldMs.toFixed(1),
                totalMs: +timing.totalMs.toFixed(1),
                elements: timing.elements,
                decodedBytes: timing.decodedBytes,
                ...(timing.sourceType ? { sourceType: timing.sourceType } : {}),
            },
        ])),
        frameTotalMs: +(performance.now() - frameStarted).toFixed(1),
    });
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
    const frameStarted = performance.now();
    const fcKey = `${cycle}_f${String(fhr).padStart(3, '0')}`;
    const ck = _ck(sourceId, variables, fcKey);
    const cached = _cacheGet(ck);
    if (cached) {
        console.info(`[NMAP Zarr timing] ${sourceId}/${fcKey}: cache hit`, {
            totalMs: +(performance.now() - frameStarted).toFixed(1),
        });
        return cached;
    }

    const { zarrVarMap = {}, apglGrid: suppliedGrid = null } = opts;
    const store = _openForecastStore(sourceId, cycle, fhr);
    const gridResult = _resolveGrid(gridInfo, suppliedGrid);
    const apglGrid = gridResult.grid;

    const entries = await Promise.all(
        variables.map(async (varName) => {
            const zarrName = zarrVarMap[varName] ?? varName;
            try {
                // The virtual store is already 2-D — no tIdx needed.
                const { data, timing } = await _readArray(store, zarrName, 0);
                return [varName, new apgl.RawScalarField(apglGrid, data), timing];
            } catch (err) {
                console.warn(
                    `[zarrClient] fetchZarrForecastFields: failed to read ` +
                    `"${zarrName}" from ${sourceId}/${cycle}/fhr/${fhr}:`, err.message
                );
                return [varName, null, null];
            }
        })
    );

    const fields = Object.fromEntries(entries.filter(([, v]) => v !== null).map(([k, v]) => [k, v]));
    const result = { fields, grid: apglGrid, gridInfo, key: fcKey, fhr };
    _cachePut(ck, result);
    _logVariableTimings(sourceId, fcKey, entries);
    console.info(`[NMAP Zarr timing] ${sourceId}/${fcKey}: frame ready`, {
        gridCacheHit: gridResult.cacheHit,
        suppliedGridReused: gridResult.supplied,
        gridBuildMs: +gridResult.buildMs.toFixed(1),
        variables: Object.fromEntries(entries.filter(([, v]) => v !== null).map(([name, , timing]) => [
            name,
            {
                openMetadataMs: +timing.openMetadataMs.toFixed(1),
                fetchDecodeMs: +timing.fetchDecodeMs.toFixed(1),
                convertMs: +timing.convertMs.toFixed(1),
                maxEventLoopLagMs: +timing.maxEventLoopLagMs.toFixed(1),
                postDecodeYieldMs: +timing.postDecodeYieldMs.toFixed(1),
                totalMs: +timing.totalMs.toFixed(1),
                elements: timing.elements,
                decodedBytes: timing.decodedBytes,
                ...(timing.sourceType ? { sourceType: timing.sourceType } : {}),
            },
        ])),
        frameTotalMs: +(performance.now() - frameStarted).toFixed(1),
    });
    return result;
}

/**
 * Stream multiple forecast frames via the fhr-slice zarr passthrough.
 *
 * Analogous to dataClient.streamForecastFrames. Fetches frames through a
 * rolling, backpressured pool and prepares them in order. Already-cached frames are
 * delivered synchronously before any network requests.
 *
 * @param {string}   sourceId    - e.g. "HREF"
 * @param {string}   cycle       - model init time key, e.g. "2026050700"
 * @param {number[]} fhrs        - forecast hours to load, e.g. [0, 1, 2, ..., 48]
 * @param {string[]} variables   - generic variable names
 * @param {object}   gridInfo    - grid descriptor from catalog
 * @param {function} onFrame     - called with ({ fields, grid, gridInfo, key, fhr }) for each frame
 * @param {object}   [opts]      - { zarrVarMap?, concurrency?, maxBufferedItems?, maxBufferedBytes? }
 */
export async function streamZarrForecastFrames(
    sourceId, cycle, fhrs, variables, gridInfo, onFrame, opts = {}
) {
    const streamStarted = performance.now();
    let cachedFrames = 0;
    let fetchedFrames = 0;
    const {
        concurrency = 4,
        maxBufferedItems = 3,
        maxBufferedBytes = 128 * 1024 * 1024,
        ...fetchOpts
    } = opts;

    // Serve cached frames first (synchronously, in order).
    const uncachedFhrs = [];
    for (const fhr of fhrs) {
        const fcKey = `${cycle}_f${String(fhr).padStart(3, '0')}`;
        const ck = _ck(sourceId, variables, fcKey);
        const cached = _cacheGet(ck);
        if (cached) {
            cachedFrames++;
            onFrame({ ...cached, key: fcKey, fhr });
            await new Promise(r => setTimeout(r, 0));
        } else {
            uncachedFhrs.push(fhr);
        }
    }
    if (!uncachedFhrs.length) {
        console.info(`[NMAP Zarr timing] ${sourceId}: forecast stream complete`, {
            frames: fhrs.length, cachedFrames, fetchedFrames,
            streamTotalMs: +(performance.now() - streamStarted).toFixed(1),
        });
        return;
    }

    await runRollingFramePipeline(
        uncachedFhrs,
        fhr => fetchZarrForecastFields(sourceId, cycle, fhr, variables, gridInfo, fetchOpts),
        async (result, fhr) => {
            fetchedFrames++;
            await onFrame({ ...result, fhr });
        },
        {
            networkConcurrency: concurrency,
            maxBufferedItems,
            maxBufferedBytes,
            onError: (err, fhr) => console.warn(
                `[zarrClient] streamZarrForecastFrames: fhr=${fhr} for ` +
                `"${sourceId}/${cycle}" failed:`, err?.message
            ),
        },
    );
    console.info(`[NMAP Zarr timing] ${sourceId}: forecast stream complete`, {
        frames: fhrs.length, cachedFrames, fetchedFrames,
        streamTotalMs: +(performance.now() - streamStarted).toFixed(1),
    });
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
 * @param {object}   [opts]      - { zarrVarMap?, tIdx?, concurrency?, maxBufferedItems?, maxBufferedBytes? }
 */
export async function streamZarrAnalysisFrames(
    sourceId, variables, keys, gridInfo, onFrame, opts = {}
) {
    const streamStarted = performance.now();
    let cachedFrames = 0;
    let fetchedFrames = 0;
    const {
        concurrency = 4,
        maxBufferedItems = 3,
        maxBufferedBytes = 128 * 1024 * 1024,
        ...fetchOpts
    } = opts;

    // Serve cached frames first
    const uncachedKeys = [];
    for (const key of keys) {
        const ck = _ck(sourceId, variables, key);
        const cached = _cacheGet(ck);
        if (cached) {
            cachedFrames++;
            onFrame({ ...cached, key });
            await new Promise(r => setTimeout(r, 0));
        } else {
            uncachedKeys.push(key);
        }
    }
    if (!uncachedKeys.length) {
        console.info(`[NMAP Zarr timing] ${sourceId}: analysis stream complete`, {
            frames: keys.length, cachedFrames, fetchedFrames,
            streamTotalMs: +(performance.now() - streamStarted).toFixed(1),
        });
        return;
    }

    await runRollingFramePipeline(
        uncachedKeys,
        key => fetchZarrFields(sourceId, key, variables, gridInfo, fetchOpts),
        async (result, key) => {
            fetchedFrames++;
            await onFrame({ ...result, key });
        },
        {
            networkConcurrency: concurrency,
            maxBufferedItems,
            maxBufferedBytes,
            onError: (err, key) => console.warn(
                `[zarrClient] Frame "${key}" for "${sourceId}" failed:`, err?.message
            ),
        },
    );
    console.info(`[NMAP Zarr timing] ${sourceId}: analysis stream complete`, {
        frames: keys.length, cachedFrames, fetchedFrames,
        streamTotalMs: +(performance.now() - streamStarted).toFixed(1),
    });
}
