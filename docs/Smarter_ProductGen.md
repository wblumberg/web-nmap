The best fit here is a layered approach:

1. IndexedDB, preferably through Dexie, for product-generation data and small metadata.
2. Existing browser HTTP caching—and optionally a service worker/Cache API—for raw server responses.
3. BroadcastChannel for immediate cross-tab notifications.
4. Keep a smaller per-tab memory cache for decoded, render-ready objects.

I would not put every decoded weather grid directly into IndexedDB initially.

## What the repository does today

The app currently has several independent, memory-only caches:

- The global app store is a shallow singleton and disappears on reload or in another tab: [store.js](/home/gblumberg/code/web-nmap/frontend/src/app/store.js:8).
- Gridded fields have a nominal 512 MiB in-memory LRU: [dataClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/dataClient.js:80).
- Point observations have a separate 60-frame memory cache: [dataClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/dataClient.js:590).
- Zarr results have another 256-entry memory cache, limited by count rather than bytes: [zarrClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/zarrClient.js:48).
- Grid descriptors have a permanent per-tab `Map`: [catalogClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/catalogClient.js:262).
- Products, undo, and redo exist only inside the ProductGen singleton: [productGenView.js](/home/gblumberg/code/web-nmap/frontend/src/views/panels/productGenView.js:79).
- ProductGen can export GeoJSON but cannot restore or share it: [productGenView.js](/home/gblumberg/code/web-nmap/frontend/src/views/panels/productGenView.js:1233).

Consequently, opening a second tab duplicates decoded grids, product state, catalog requests, and much of the associated memory.

The backend already provides useful browser-cache semantics:

- Normal gridded responses get an ETag and one-hour `Cache-Control`: [gridded.py](/home/gblumberg/code/web-nmap/backend/api/routers/gridded.py:101).
- Zarr metadata and chunks receive five-minute/one-hour cache lifetimes: [zarr_proxy.py](/home/gblumberg/code/web-nmap/backend/api/routers/zarr_proxy.py:247).

That existing HTTP caching should be leveraged before building a custom database for all binary data.

## Recommended storage architecture

| Data | Primary storage | Cross-tab behavior | Suggested lifetime |
|---|---|---|---|
| Contours, fronts, text, procedure definitions | IndexedDB/Dexie | Dexie `liveQuery` or BroadcastChannel | Durable |
| Active procedure/map configuration | IndexedDB | Notify other tabs after commit | Durable |
| Catalog sources, cycles, times, grid descriptors | IndexedDB or Cache API | Shared automatically by origin | Minutes to hours |
| Raw protobuf responses | HTTP cache, optionally Cache API | Shared browser-wide | TTL/version based |
| Raw Zarr chunks | Existing HTTP cache, optionally Cache API | Shared browser-wide | Existing server TTL |
| Point/geometry GeoJSON | Cache API or IndexedDB | Shared browser-wide | Short TTL based on source |
| Decoded `RawScalarField`/APGL objects | Memory | Usually per tab | LRU only |
| UI state such as open panels | `sessionStorage` | Deliberately tab-local | Tab lifetime |
| Small preferences | `localStorage` | Storage event across tabs | Durable |

### 1. Use Dexie/IndexedDB for ProductGen

IndexedDB is the right underlying technology for products. It supports substantial structured data and objects compatible with structured cloning, including typed arrays and blobs. It is asynchronous and same-origin, so all same-origin tabs see the same database. [MDN IndexedDB overview](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API).

Dexie is worthwhile here because native IndexedDB’s request/transaction API would introduce considerable boilerplate. Dexie’s `liveQuery()` also propagates relevant mutations across tabs and workers, which closely matches your desired ProductGen behavior. [Dexie liveQuery documentation](https://dexie.org/docs/liveQuery%28%29).

A reasonable schema would be:

```js
db.version(1).stores({
  procedures: 'id, name, updatedAt',
  products: 'id, procedureId, kind, updatedAt, [procedureId+kind]',
  preferences: 'key',
  metadata: 'key, expiresAt',
  cacheIndex: 'key, sourceId, validTime, expiresAt, lastAccessed'
});
```

Store one product per record rather than one giant `_products` array. For example:

```js
{
  id: crypto.randomUUID(),
  procedureId: 'current-analysis',
  kind: 'front',
  geometry: {
    type: 'LineString',
    coordinates: [...]
  },
  style: {
    frontType: 'cold',
    color: '#3388ff',
    width: 2,
    pipSide: 'right'
  },
  name: 'Cold Front',
  visible: true,
  revision: 7,
  updatedAt: Date.now(),
  updatedBy: tabId
}
```

UUIDs are preferable to the current tab-local `_nextId`, since two tabs can otherwise create the same numeric ID.

I would keep undo/redo tab-local initially. Persist the authoritative product records, but let each tab retain its own transient edit history. Shared undo across tabs becomes a collaborative editing problem and is better implemented later as an operation log.

### 2. Add BroadcastChannel for coordination

Use BroadcastChannel for fast same-origin communication among tabs. It is broadly available and specifically designed for communication among tabs, windows, frames, and workers. [MDN Broadcast Channel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API).

Broadcast messages should be notifications, not the source of truth:

```js
channel.postMessage({
  type: 'product-updated',
  procedureId,
  productId,
  revision
});
```

The receiving tab then reads the committed record from IndexedDB. This avoids:

- Losing state when a tab was not open for a message.
- Sending large product collections repeatedly.
- Receiving a notification before the database write commits.
- Maintaining two competing stores of truth.

Dexie `liveQuery()` may be enough for product records by itself. I would still use a small BroadcastChannel for events such as:

- “Tab A is actively editing product X.”
- Cache invalidation.
- Dataset refresh announcements.
- Leader/fetch ownership.
- Product selection or presence indicators.

For concurrent edits, start with feature-level last-write-wins plus `revision` checks. If two tabs edit the same feature, warn before overwriting. A CRDT is unnecessary unless true simultaneous collaborative vertex editing becomes a core requirement.

### 3. Cache raw data, not APGL instances

The weather cache should generally store the raw response representation:

- Protobuf bytes.
- Compressed Zarr chunks.
- GeoJSON.
- Catalog JSON.

Then reconstruct `RawScalarField`, grids, and layers in memory.

APGL class instances contain behavior and rendering-specific state that will not round-trip through IndexedDB. Structured cloning does not preserve prototypes, methods, or functions. [MDN structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).

Raw bytes also occupy less disk space than decoded fields. For example, persisting a dequantized float field can be approximately two to four times larger than the compressed or quantized transport representation.

For ordinary GET responses, the browser HTTP cache may already eliminate the server transfer. A second tab can reuse cacheable gridded and Zarr requests because the backend sends caching headers. Before adding a service worker, measure browser cache hits in the Network panel.

A service worker plus Cache API becomes useful if you need:

- Explicit stale-while-revalidate behavior.
- Offline loops.
- Custom expiration by source.
- Guaranteed cache-first requests.
- A user-facing “download this cycle for offline use” feature.

It is less useful for the streaming batch endpoints because cache keys include the entire requested list of frames. Different combinations of keys produce different URLs. Persisting individual frames extracted from a stream would require a custom frame cache, probably IndexedDB blobs keyed by individual frame identity.

### 4. Retain a bounded memory cache

Decoded grids should remain in memory while actively looping because decoding from IndexedDB or Cache Storage on every animation pass would add latency.

A good lookup pipeline is:

```text
Per-tab decoded memory cache
        ↓ miss
Persistent raw-response cache / HTTP cache
        ↓ miss
Server request
        ↓
Persist raw response
        ↓
Decode and place in memory LRU
```

This provides fast animation while avoiding server traffic after reloads or in another tab.

## Issues to fix before making the cache persistent

There are several current cache-key/accounting problems that could become correctness bugs when persisted.

1. The gridded byte accounting only counts `Float32Array`:

   [dataClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/dataClient.js:140)

   But the int16 dequantization path constructs a `Float16Array`. Those results appear to get a calculated size of zero and are not inserted at all. The nominal 512 MiB cache therefore does not cover many quantized fields.

2. The Zarr cache is capped at 256 entries, not bytes:

   [zarrClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/zarrClient.js:51)

   Depending on grid size and variable count, that could consume several GiB. Its getter also does not promote entries, so it is FIFO rather than true LRU.

3. Zarr keys do not appear to include all options such as time index, variable mapping, or query parameters. Persisting those keys would risk returning a semantically different field.

4. The point-data key does not include `bbox`, `windowMinutes`, or `limit`:

   [dataClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/dataClient.js:650)

   Two requests for the same source/time but different bounding boxes can collide.

5. Geometry responses currently have no client memory cache:

   [dataClient.js](/home/gblumberg/code/web-nmap/frontend/src/services/api/dataClient.js:809)

   These are good early candidates for a small shared persistent cache.

Build one canonical request-key function covering endpoint, source, variables in normalized order, time/cycle/FHR, bbox, level, format, query parameters, decoder/schema version, and product-affecting options.

## SharedWorker: useful later, not the first step

A SharedWorker could centralize:

- In-flight request deduplication.
- Decoding.
- A single shared memory cache.
- Distribution of results to every tab.

Shared workers are explicitly designed to be accessed by multiple same-origin browsing contexts. [MDN SharedWorker](https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker).

However, I would treat this as phase three. It introduces lifecycle, bundling, debugging, and message-protocol complexity. Passing large typed arrays to multiple tabs can also copy data unless carefully transferred; transferring ownership makes multi-consumer caching harder. A SharedWorker also does not replace durable storage.

Start with IndexedDB plus BroadcastChannel. Add a SharedWorker only if measurements show that simultaneous tabs are still issuing duplicate uncached requests or decoding is a major CPU cost.

## Quotas and durability

IndexedDB, Cache Storage, and OPFS share browser-managed origin storage constraints. Writes can fail with `QuotaExceededError`, and best-effort data can be evicted under storage pressure. You can inspect usage with `navigator.storage.estimate()` and request persistent storage with `navigator.storage.persist()`. [MDN storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

I would classify data explicitly:

- Products/procedures: valuable, durable, exportable, request persistence.
- Weather payloads: disposable cache, evictable.
- Decoded objects: memory-only.
- Undo history: disposable unless the product requirements say otherwise.

Even with persistent storage permission, offer automatic GeoJSON backup because browser storage can be cleared by the user.

## Suggested implementation sequence

1. Extract ProductGen’s `_products` into a repository/service abstraction.
2. Add Dexie with `procedures` and `products` stores.
3. Replace numeric IDs with UUIDs and add `revision`, `updatedAt`, and `updatedBy`.
4. Make ProductGen render from IndexedDB and react to cross-tab changes.
5. Add product import, autosave status, and explicit procedure selection.
6. Correct and centralize the existing cache keys and byte accounting.
7. Measure HTTP cache effectiveness for protobuf and Zarr requests.
8. Add short-lived persistent caching for catalog, point, and geometry responses.
9. Add a service worker only for explicit cache policy/offline behavior.
10. Evaluate a SharedWorker only after profiling multi-tab request and decode duplication.

In short: IndexedDB is indeed the right answer for your contours, fronts, procedures, and other authored data. For large meteorological datasets, use it selectively; lean first on the browser’s shared HTTP cache for raw immutable responses, while retaining decoded render objects in a bounded per-tab memory cache.
