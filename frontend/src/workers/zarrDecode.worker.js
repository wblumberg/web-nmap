import { FetchStore, open, get, root } from 'zarrita';
import { Float16Array } from '@petamoriken/float16';

const metadataCache = new Map();
const METADATA_CACHE_MAX = 128;
const CHUNK_CACHE_DB = 'web-nmap-zarr-chunks-v1';
const CHUNK_CACHE_STORE = 'chunks';
const CHUNK_CACHE_META_STORE = 'chunkMeta';
const CHUNK_CACHE_STATE_STORE = 'state';
let chunkCacheDbPromise = null;

function openChunkCache() {
    if (typeof indexedDB === 'undefined') return Promise.resolve(null);
    if (chunkCacheDbPromise) return chunkCacheDbPromise;
    chunkCacheDbPromise = new Promise(resolve => {
        const req = indexedDB.open(CHUNK_CACHE_DB, 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            const chunks = db.objectStoreNames.contains(CHUNK_CACHE_STORE)
                ? req.transaction.objectStore(CHUNK_CACHE_STORE)
                : db.createObjectStore(CHUNK_CACHE_STORE, {keyPath: 'url'});
            // Version 1 stored LRU metadata beside the potentially huge body.
            // Clear it once so future eviction can inspect metadata without
            // materializing every compressed chunk in JS memory.
            if (req.oldVersion < 2) chunks.clear();
            if (!db.objectStoreNames.contains(CHUNK_CACHE_META_STORE)) {
                const meta = db.createObjectStore(CHUNK_CACHE_META_STORE, {keyPath: 'url'});
                meta.createIndex('lastAccess', 'lastAccess');
            }
            if (!db.objectStoreNames.contains(CHUNK_CACHE_STATE_STORE)) {
                db.createObjectStore(CHUNK_CACHE_STATE_STORE, {keyPath: 'key'});
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
    return chunkCacheDbPromise;
}

async function readCachedChunk(url, ttlMs) {
    const db = await openChunkCache();
    if (!db) return null;
    return new Promise(resolve => {
        const tx = db.transaction(
            [CHUNK_CACHE_STORE, CHUNK_CACHE_META_STORE, CHUNK_CACHE_STATE_STORE],
            'readwrite',
        );
        const chunks = tx.objectStore(CHUNK_CACHE_STORE);
        const metaStore = tx.objectStore(CHUNK_CACHE_META_STORE);
        const metaReq = metaStore.get(url);
        metaReq.onsuccess = () => {
            const meta = metaReq.result;
            if (!meta || Date.now() - meta.createdAt > ttlMs) {
                if (meta) {
                    metaStore.delete(url);
                    const state = tx.objectStore(CHUNK_CACHE_STATE_STORE);
                    const usageReq = state.get('usage');
                    usageReq.onsuccess = () => state.put({
                        key: 'usage',
                        bytes: Math.max(0, (usageReq.result?.bytes || 0) - (meta.size || 0)),
                    });
                }
                chunks.delete(url);
                resolve(null);
                return;
            }
            meta.lastAccess = Date.now();
            metaStore.put(meta);
            const chunkReq = chunks.get(url);
            chunkReq.onsuccess = () => resolve(chunkReq.result ? {...chunkReq.result, ...meta} : null);
            chunkReq.onerror = () => resolve(null);
        };
        metaReq.onerror = () => resolve(null);
    });
}

async function trimChunkCache(db, maxBytes) {
    await new Promise(resolve => {
        const tx = db.transaction(
            [CHUNK_CACHE_STORE, CHUNK_CACHE_META_STORE, CHUNK_CACHE_STATE_STORE],
            'readwrite',
        );
        const chunks = tx.objectStore(CHUNK_CACHE_STORE);
        const meta = tx.objectStore(CHUNK_CACHE_META_STORE);
        const state = tx.objectStore(CHUNK_CACHE_STATE_STORE);
        const usageReq = state.get('usage');
        usageReq.onsuccess = () => {
            let total = usageReq.result?.bytes || 0;
            if (total <= maxBytes) return;
            const cursorReq = meta.index('lastAccess').openCursor();
            cursorReq.onsuccess = () => {
                const cursor = cursorReq.result;
                if (!cursor || total <= maxBytes) {
                    state.put({key: 'usage', bytes: Math.max(0, total)});
                    return;
                }
                total -= cursor.value.size || 0;
                chunks.delete(cursor.value.url);
                cursor.delete();
                cursor.continue();
            };
        };
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
    });
}

async function writeCachedChunk(url, bytes, headers, policy) {
    const db = await openChunkCache();
    if (!db || bytes.byteLength > policy.maxBytes) return;
    await new Promise(resolve => {
        const tx = db.transaction(
            [CHUNK_CACHE_STORE, CHUNK_CACHE_META_STORE, CHUNK_CACHE_STATE_STORE],
            'readwrite',
        );
        const chunks = tx.objectStore(CHUNK_CACHE_STORE);
        const meta = tx.objectStore(CHUNK_CACHE_META_STORE);
        const state = tx.objectStore(CHUNK_CACHE_STATE_STORE);
        chunks.put({
            url, bytes,
            contentType: headers.get('content-type'),
        });
        const oldReq = meta.get(url);
        oldReq.onsuccess = () => {
            const oldSize = oldReq.result?.size || 0;
            meta.put({
                url, size: bytes.byteLength, createdAt: Date.now(), lastAccess: Date.now(),
            });
            const usageReq = state.get('usage');
            usageReq.onsuccess = () => state.put({
                key: 'usage',
                bytes: Math.max(0, (usageReq.result?.bytes || 0) - oldSize + bytes.byteLength),
            });
        };
        tx.oncomplete = resolve;
        tx.onerror = resolve;
        tx.onabort = resolve;
    });
    await trimChunkCache(db, policy.maxBytes);
}

function isMetadataUrl(url) {
    return /\/(?:\.zarray|\.zattrs|\.zgroup|zarr\.json)$/.test(new URL(url).pathname);
}

function metadataCacheKey(url) {
    // Do not collapse analysis-frame metadata. During a rolling deployment,
    // legacy float16/uint16 and packed uint8 GOES stores coexist and their
    // dtype, fill value, scale, and offset legitimately differ by frame.
    return url.replace(/\/fhr\/\d+\//, '/fhr/{fhr}/');
}

async function fetchWithMetadataCache(request) {
    if (request.method !== 'GET' || !isMetadataUrl(request.url)) return fetch(request);
    const key = metadataCacheKey(request.url);
    let cached = metadataCache.get(key);
    if (!cached) {
        const response = await fetch(request);
        cached = {
            status: response.status,
            headers: [...response.headers],
            bytes: response.ok ? await response.arrayBuffer() : null,
        };
        metadataCache.set(key, cached);
        while (metadataCache.size > METADATA_CACHE_MAX) {
            metadataCache.delete(metadataCache.keys().next().value);
        }
    }
    return new Response(cached.bytes?.slice(0) ?? null, {
        status: cached.status,
        headers: cached.headers,
    });
}

async function readVariable(store, name, tIdx, preserveNativeDtype) {
    const started = performance.now();
    const openStarted = performance.now();
    const array = await open(root(store).resolve(name), {kind: 'array'});
    const openMetadataMs = performance.now() - openStarted;
    const selection = array.shape.length === 3 ? [tIdx, null, null] : [null, null];
    const fetchStarted = performance.now();
    const result = await get(array, selection);
    const fetchDecodeMs = performance.now() - fetchStarted;
    const source = result.data;
    const scaleFactor = Number(array.attrs?.scale_factor);
    const addOffset = Number(array.attrs?.add_offset);
    // GPU dequantization is only valid when the packed integer dtype survives
    // transport. Ordinary forecast fields converted to float16 must retain
    // their established rendering path even if incidental CF attrs exist.
    const packing = preserveNativeDtype && Number.isFinite(scaleFactor) ? {
        scaleFactor,
        addOffset: Number.isFinite(addOffset) ? addOffset : 0,
        fillValue: array.fillValue ?? null,
    } : null;
    const convertStarted = performance.now();
    const copyStarted = performance.now();
    // Never transfer Zarrita/codec-owned buffers directly. postMessage would
    // detach that buffer and can force the codec to rebuild or corrupt its
    // reusable memory on the next frame. slice() preserves the native dtype
    // while creating an independently transferable backing store.
    const output = preserveNativeDtype
        ? source.slice()
        : source instanceof Float16Array ? source : new Float16Array(source);
    const transferCopyMs = preserveNativeDtype ? performance.now() - copyStarted : 0;
    return {
        name,
        buffer: output.buffer,
        byteOffset: output.byteOffset,
        length: output.length,
        arrayType: output.constructor?.name,
        packing,
        timing: {
            openMetadataMs,
            fetchDecodeMs,
            convertMs: performance.now() - convertStarted,
            maxEventLoopLagMs: 0,
            postDecodeYieldMs: 0,
            totalMs: performance.now() - started,
            elements: output.length,
            decodedBytes: output.byteLength,
            sourceType: source.constructor?.name,
            preservedNativeDtype: preserveNativeDtype === true,
            transferCopyMs,
        },
    };
}

self.onmessage = async event => {
    const {id, request, requestPostedEpochMs} = event.data;
    const requestReceivedEpochMs = Date.now();
    const started = performance.now();
    try {
        const requests = [];
        const instrumentedFetch = async fetchRequest => {
            const requestStarted = performance.now();
            const cachePolicy = request.compressedChunkCache;
            const isChunk = fetchRequest.method === 'GET' && !isMetadataUrl(fetchRequest.url);
            const cachedChunk = cachePolicy?.enabled && isChunk
                ? await readCachedChunk(fetchRequest.url, cachePolicy.ttlMs)
                : null;
            const response = cachedChunk
                ? new Response(cachedChunk.bytes.slice(0), {status: 200, headers: {
                    'content-type': cachedChunk.contentType || 'application/octet-stream',
                    'content-length': String(cachedChunk.size),
                }})
                : await fetchWithMetadataCache(fetchRequest);
            const metric = {
                path: new URL(fetchRequest.url).pathname,
                durationMs: performance.now() - requestStarted,
                headersMs: performance.now() - requestStarted,
                bodyMs: null,
                totalMs: null,
                status: response.status,
                responseBytes: Number(response.headers.get('content-length')) || null,
                contentEncoding: response.headers.get('content-encoding') || 'identity',
                backendRequestId: response.headers.get('x-webnmap-request-id'),
                indexedDbHit: Boolean(cachedChunk),
            };
            requests.push(metric);
            return new Proxy(response, {
                get(target, property) {
                    if (property === 'arrayBuffer') {
                        return async () => {
                            const bodyStarted = performance.now();
                            try {
                                const bytes = await target.arrayBuffer();
                                if (cachePolicy?.enabled && isChunk && !cachedChunk && target.ok) {
                                    // The decoder can proceed immediately; persistence and
                                    // budget trimming happen off its critical path.
                                    void writeCachedChunk(fetchRequest.url, bytes.slice(0), target.headers, cachePolicy);
                                }
                                return bytes;
                            } finally {
                                metric.bodyMs = performance.now() - bodyStarted;
                                metric.totalMs = performance.now() - requestStarted;
                                metric.bodyThroughputMbps = metric.responseBytes && metric.bodyMs > 0
                                    ? (metric.responseBytes * 8) / (metric.bodyMs * 1000)
                                    : null;
                            }
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        };
        const store = new FetchStore(request.baseUrl, {fetch: instrumentedFetch});
        const fields = await Promise.all(request.variables.map(variable =>
            readVariable(store, variable.zarrName, request.tIdx || 0, request.preserveNativeDtype === true)
                .then(result => ({...result, name: variable.name})),
        ));
        self.postMessage(
            {id, result: {
                fields,
                workerMs: performance.now() - started,
                requestPostedEpochMs,
                requestReceivedEpochMs,
                returnReadyEpochMs: Date.now(),
                requests,
            }},
            fields.map(field => field.buffer),
        );
    } catch (error) {
        self.postMessage({id, error: error?.message || String(error)});
    }
};
