/**
 * LayerBuilder.js  (updated for multi-slot support)
 *
 * All functions now accept an optional `namespace` string (the slotId).
 * When provided, every PlotLayer / MultiPlotLayer ID is prefixed:
 *   'mrms_cref' in slot 'radar'  →  'radar/mrms_cref'
 *
 * This prevents ID collisions when multiple slots contribute layers to
 * the same MapLibre map instance.
 * 
 * 
 */

// ── Explicit import replaces the implicit `window.apgl` global ───────────────
import { PlotLayer, MultiPlotLayer } from 'autumnplot-gl';
import {
    ScatterometerTimeSeriesLayer,
    TemporalScatterometerLayer,
} from 'autumnplot-gl-extensions';
import { pointWindow } from './pointFrames.js';
import { GEOMETRY_DIAGNOSTICS } from './geometryFrames.js';
import { estimateValueBytes, recordDiagnostic } from '../services/mapDiagnostics.js';

// ─── ID namespacing ───────────────────────────────────────────────────────────
function nsId(id, namespace) {
    return namespace ? `${namespace}/${id}` : id;
}

/**
 * Report variables requested by a product but absent from a decoded frame.
 *
 * This is deliberately diagnostic-only: some products can still render a
 * useful primary layer when an optional overlay is unavailable.  The product's
 * make_layers implementation remains responsible for deciding whether a
 * missing key is fatal or whether it should omit only that overlay.
 */
function diagnoseMissingDataKeys(productSuite, data, { namespace = '', key = '' } = {}) {
    const requested = Array.isArray(productSuite?.data_keys)
        ? productSuite.data_keys.filter(item => item && item !== '_all')
        : [];
    // Point/profile products carry requested variables inside each obs_json
    // record rather than as top-level frame fields. Treat a variable as
    // available when at least one observation supplies it; an empty frame has
    // no evidence that the source schema is incomplete.
    const observations = Array.isArray(data?.obs_json) ? data.obs_json : null;
    const nestedKeys = observations?.length
        ? new Set(observations.flatMap(obs => Object.keys(obs?.data ?? {})))
        : null;
    const missing = requested.filter(item => {
        if (Object.prototype.hasOwnProperty.call(data ?? {}, item) && data[item] != null) return false;
        if (observations) return nestedKeys === null ? false : !nestedKeys.has(item);
        return true;
    });
    if (!missing.length) return missing;

    const available = nestedKeys ? [...nestedKeys] : Object.keys(data ?? {});
    const message = `Missing requested data key(s): ${missing.join(', ')}`;
    console.warn(`[LayerBuilder] ${message}`, {
        product: productSuite?.label,
        source: namespace,
        key,
        requested,
        available,
    });
    recordDiagnostic('data-keys-missing', {
        source: namespace,
        key,
        product: productSuite?.label ?? '',
        missingDataKeys: missing,
        requestedDataKeys: requested,
        availableDataKeys: available,
        message,
    });
    return missing;
}

// ─── Static build ─────────────────────────────────────────────────────────────
// This function builds the PlotLayers needed to display a single time
// 
// Using the arguments:
//   productSuite:  the product suite object (e.g., MRMS, GFS, etc.)
//   data:          the data object for the single time
//   grid:          the grid object for the product suite
//   namespace:     an optional string to namespace the layer IDs
//
// Returns an object with:
//   layers:     an array of PlotLayer objects
//   colorbars:  an array of Colorbar objects (or empty array)
//   sampler:    a Sampler object (or null)
//   controller: null (no controller for static layers)
function buildStaticLayers(productSuite, data, grid, namespace = '') {
    diagnoseMissingDataKeys(productSuite, data, { namespace });
    console.warn('[LayerBuilder] buildStaticLayers: calling make_layers()', { data, grid });
    const result = productSuite.make_layers(data, grid);
    console.warn('[LayerBuilder] make_layers returned:', {
        layerCount: result.layers?.length ?? 0,
        colorbarCount: result.colorbar?.length ?? 0,
        hasSampler: !!result.sampler,
        layerIds: result.layers?.map(l => l.id),
    });

    // Re-namespace the layer IDs
    const layers = result.layers.map(plotLayer => {
        // PlotLayer doesn't expose a setter for `id`, so we wrap it in a Proxy
        // that overrides just the id property. This avoids re-constructing
        // the entire PlotLayer (which would lose the already-initialized GL state).
        return _namespaceLayer(plotLayer, namespace);
    });

    return {
        layers,
        colorbars:  result.colorbar ?? [],
        sampler:    result.sampler  ?? null,
        controller: null,
    };
}

// ─── Multi-time build ─────────────────────────────────────────────────────────
//  This function builds the MultiPlotLayers needed to step through time 
//  and update the map to show the next set of products for each time.
//  
//  Using the arguments:
//    productSuite:  the product suite object (e.g., MRMS, GFS, etc.)
//    dataByKey:     an object mapping each key (time) to its data object
//    gridOrGridFactory: either a grid object or a function that returns a grid
//    orderedKeys:   an array of keys (times) in the order they should be displayed
//    namespace:     an optional string to namespace the layer IDs
//
//  Returns an object with:
//    layers:     an array of MultiPlotLayer objects
//    colorbars:  an array of Colorbar objects (or empty array)
//    sampler:    a Sampler object (or null)
//    controller: an object with methods to step through the keys (times)
function buildMultiLayers(productSuite, dataByKey, gridOrGridFactory, orderedKeys, namespace = '') {
    // Get the grid or build the grid using gridOrGridFactory()
    const grid = (typeof gridOrGridFactory === 'function')
        ? gridOrGridFactory()
        : gridOrGridFactory;

    // Build the template result using the first key's data
    const firstKey       = orderedKeys[0];

    diagnoseMissingDataKeys(productSuite, dataByKey[firstKey], { namespace, key: firstKey });

    // Build the template result using the first key's data
    console.warn('[LayerBuilder] buildMultiLayers: calling make_layers for template key:', firstKey, 'data:', dataByKey[firstKey]);
    const templateResult = productSuite.make_layers(dataByKey[firstKey], grid);
    console.warn('[LayerBuilder] buildMultiLayers: template make_layers() returned:', {
        layerCount: templateResult.layers?.length ?? 0,
        layerIds: templateResult.layers?.map(l => l.id),
        colorbarCount: templateResult.colorbar?.length ?? 0,
        hasSampler: !!templateResult.sampler,
    });
    if (!templateResult.layers?.length) {
        console.error('[LayerBuilder] WARNING: make_layers() returned 0 layers!');
    }

    // Create one MultiPlotLayer per PlotLayer in the template, namespaced
    const multiLayers = templateResult.layers.map(plotLayer =>
        new MultiPlotLayer(nsId(plotLayer.id, namespace))
    );

    // Populate each MultiPlotLayer with one PlotLayer per key (key being the time)
    orderedKeys.forEach((key, keyIdx) => {
        console.warn(`[LayerBuilder] Populating key "${key}" (${keyIdx+1}/${orderedKeys.length})`);
        let result;
        try {
            if (key !== firstKey) {
                diagnoseMissingDataKeys(productSuite, dataByKey[key], { namespace, key });
            }
            result = productSuite.make_layers(dataByKey[key], grid);
        } catch (err) {
            console.error(`[LayerBuilder] make_layers THREW for key "${key}":`, err);
            return;
        }
        if (!result.layers?.length) {
            console.warn(`[LayerBuilder] make_layers returned 0 layers for key "${key}"`);
        }
        result.layers.forEach((plotLayer, layerIndex) => {
            try {
                multiLayers[layerIndex].addField(
                    _namespaceLayer(plotLayer, namespace),
                    key
                );
            } catch (err) {
                console.error(`[LayerBuilder] addField THREW for layer[${layerIndex}] key "${key}":`, err);
            }
        });
    });

    // Set the active key to be firstKey for each of the layers
    multiLayers.forEach(ml => ml.setActiveKey(firstKey));

    // Save the currentKey used to move through the MultiPlotLayer
    let currentKey = firstKey;

    // set up a controller object to manage moving through each key -> that is time.
    const controller = {
        keys: orderedKeys,

        // Return the current key (time) being displayed
        getKey()      { return currentKey; },

        // Set the active key for each of the MultiPlotLayers
        setKey(key) {
            if (!orderedKeys.includes(key)) {
                console.warn(`LayerBuilder: key "${key}" not in available keys`);
                return;
            }
            currentKey = key;
            multiLayers.forEach(ml => ml.setActiveKey(key));
        },

        // Move to the next key (time) if available
        stepForward() {
            const idx = orderedKeys.indexOf(currentKey);
            if (idx < orderedKeys.length - 1) this.setKey(orderedKeys[idx + 1]);
        },

        // Move to the previous key (time) if available
        stepBackward() {
            const idx = orderedKeys.indexOf(currentKey);
            if (idx > 0) this.setKey(orderedKeys[idx - 1]);
        },

        // Return true if there is a next key or previous key (time) available
        hasNext() { return orderedKeys.indexOf(currentKey) < orderedKeys.length - 1; },
        hasPrev() { return orderedKeys.indexOf(currentKey) > 0; },

        // Hide all layers (render nothing) by clearing the active key.
        // MultiPlotLayer.render() short-circuits when field_key is null.
        hide() {
            multiLayers.forEach(ml => ml.setActiveKey(null));
        },
    };

    // After building all of the mulitlayers, return them, along with the colorbars, sampler, and controller
    return {
        layers:     multiLayers,
        colorbars:  templateResult.colorbar ?? [],
        sampler:    templateResult.sampler  ?? null,
        controller,
    };
}

// ─── Layer ID namespacing via Proxy ───────────────────────────────────────────
//
// MapLibre reads layer.id when addLayer() is called and when removeLayer() is
// called. We use a Proxy to intercept the `id` property read without
// re-constructing the PlotLayer (which would lose initialized GPU state).
//
function _namespaceLayer(layer, namespace) {
    if (!namespace) return layer;
    return new Proxy(layer, {
        get(target, prop) {
            if (prop === 'id') return nsId(target.id, namespace);
            const val = target[prop];
            return typeof val === 'function' ? val.bind(target) : val;
        }
    });
}

// ─── Progressive multi-time build ────────────────────────────────────────────
//
//  Creates MultiPlotLayers from a first frame and returns an `addFrame()`
//  function so additional frames can be added incrementally AFTER the layers
//  are already on the map.  This lets the first frame appear immediately
//  while remaining frames stream in.
//
//  Usage:
//    const prog = buildProgressiveMultiLayers(suite, firstKey, firstData, grid, ns);
//    map.addLayer(prog.layers[0], anchor);   // visible instantly
//    // … later, as more data arrives …
//    prog.addFrame('20260328_0600', newData); // appears without rebuilding
//
function buildProgressiveMultiLayers(productSuite, firstKey, firstData, grid, namespace = '') {
    const progressiveStarted = performance.now();
    if (productSuite.renderer === 'scatterometer') {
        const layer = new ScatterometerTimeSeriesLayer(
            nsId(productSuite.layer_id ?? 'scatterometer-winds', namespace),
            productSuite.scatterometer_options ?? {},
        );
        const loadedKeys = [];
        let currentKey = firstKey;
        const addFrame = (key, data) => {
            layer.addFrame(key, data?.obs_json ?? []);
            if (!loadedKeys.includes(key)) loadedKeys.push(key);
        };
        const removeFrame = key => {
            layer.removeFrame(key);
            const index = loadedKeys.indexOf(key);
            if (index >= 0) loadedKeys.splice(index, 1);
        };
        addFrame(firstKey, firstData);
        layer.setActiveKey(firstKey);

        const controller = {
            get keys() { return loadedKeys; },
            getKey() { return currentKey; },
            setKey(key) {
                if (!loadedKeys.includes(key)) return;
                currentKey = key;
                layer.setActiveKey(key);
            },
            getSampler() { return null; },
            hide() { layer.setActiveKey(null); },
        };
        return {
            layers: [layer],
            colorbars: productSuite.make_colorbars?.() ?? [],
            sampler: null,
            controller,
            addFrame,
            removeFrame,
        };
    }

    // Identify incomplete server/decoder responses before product code tries
    // to dereference a missing field.
    diagnoseMissingDataKeys(productSuite, firstData, { namespace, key: firstKey });

    // Build the template from the first frame's data
    const templateResult = productSuite.make_layers(firstData, grid);
    if (!templateResult.layers?.length) {
        console.error('[LayerBuilder] WARNING: make_layers() returned 0 layers for progressive build!');
    }

    // Create one MultiPlotLayer per PlotLayer in the template
    const multiLayers = templateResult.layers.map(plotLayer =>
        new MultiPlotLayer(nsId(plotLayer.id, namespace))
    );

    // Add the first frame
    templateResult.layers.forEach((plotLayer, i) => {
        multiLayers[i].addField(_namespaceLayer(plotLayer, namespace), firstKey);
    });
    multiLayers.forEach(ml => ml.setActiveKey(firstKey));
    recordDiagnostic('frame-added', {
        source: namespace, key: firstKey, bytes: estimateValueBytes(firstData),
        durationMs: performance.now() - progressiveStarted,
        message: `${templateResult.layers.length} layer(s) (initial)`,
    });

    // Mutable ordered list of loaded keys
    const loadedKeys = [firstKey];
    const retainedBytesByKey = new Map([[firstKey, estimateValueBytes(firstData)]]);
    const geometryDiagnosticsByKey = new Map();
    if (firstData?.[GEOMETRY_DIAGNOSTICS]) {
        geometryDiagnosticsByKey.set(firstKey, firstData[GEOMETRY_DIAGNOSTICS]);
    }
    let currentKey = firstKey;
    let ringPolicy = null;
    let virtualKeys = loadedKeys;
    const residentRecency = new Map([[firstKey, performance.now()]]);
    const pendingLoads = new Map();
    let measuredReloadMs = 100;

    function residentGpuBytes() {
        return multiLayers.reduce((sum, layer) => sum + (layer.getFrameDiagnostics?.().gpuBytes || 0), 0);
    }

    async function enforceGpuBudget(protectedKeys = []) {
        if (!ringPolicy) return;
        const protectedSet = new Set([currentKey, ...protectedKeys]);
        while (residentGpuBytes() > ringPolicy.gpuBytes && loadedKeys.length > protectedSet.size) {
            const victim = [...residentRecency.entries()]
                .filter(([key]) => loadedKeys.includes(key) && !protectedSet.has(key))
                .sort((a, b) => a[1] - b[1])[0]?.[0];
            if (!victim) break;
            await removeResidentFrame(victim);
            residentRecency.delete(victim);
        }
    }

    async function ensureResident(key) {
        if (loadedKeys.includes(key)) {
            residentRecency.set(key, performance.now());
            return true;
        }
        if (!ringPolicy?.loadFrame) return false;
        if (!pendingLoads.has(key)) {
            pendingLoads.set(key, (async () => {
                const reloadStarted = performance.now();
                const data = await ringPolicy.loadFrame(key);
                if (!data) return false;
                await addFrame(key, data);
                const elapsed = performance.now() - reloadStarted;
                measuredReloadMs = measuredReloadMs * 0.75 + elapsed * 0.25;
                return true;
            })().finally(() => pendingLoads.delete(key)));
        }
        return pendingLoads.get(key);
    }

    function scheduleUploadAhead(key) {
        if (!ringPolicy) return;
        const center = virtualKeys.indexOf(key);
        if (center < 0) return;
        const aheadCount = Math.min(
            virtualKeys.length - 1,
            Math.max(ringPolicy.uploadAhead, Math.ceil(measuredReloadMs / ringPolicy.dwellMs) + 2),
        );
        const ahead = [];
        for (let offset = 1; offset <= aheadCount; offset++) {
            const index = (center + offset * ringPolicy.direction + virtualKeys.length) % virtualKeys.length;
            ahead.push(virtualKeys[index]);
        }
        void (async () => {
            // The worker pool provides its own concurrency bound. Queueing the
            // whole look-ahead window lets both workers stay busy.
            await Promise.all(ahead.map(nextKey => ensureResident(nextKey)));
            await enforceGpuBudget([key, ...ahead]);
        })();
    }

    // Track per-key samplers so the active sampler can be swapped when the
    // displayed frame changes (important for geometry / alert products).
    const samplerByKey = new Map();
    if (templateResult.sampler) samplerByKey.set(firstKey, templateResult.sampler);

    /**
     * Add a new frame to all MultiPlotLayers.
     * Can be called after the layers are already on the map.
     */
    async function addFrame(key, data) {
        const started = performance.now();
        const makeLayersStarted = performance.now();
        let result;
        try {
            diagnoseMissingDataKeys(productSuite, data, { namespace, key });
            result = productSuite.make_layers(data, grid);
        } catch (err) {
            console.error(`[LayerBuilder] progressive addFrame make_layers THREW for key "${key}":`, err);
            return;
        }
        const makeLayersMs = performance.now() - makeLayersStarted;
        const layerSetupStarted = performance.now();
        const setupResults = await Promise.all(result.layers.map(async (plotLayer, i) => {
            const setupStarted = performance.now();
            try {
                await multiLayers[i].addField(_namespaceLayer(plotLayer, namespace), key);
                return { id: plotLayer.id, ms: performance.now() - setupStarted };
            } catch (err) {
                console.error(`[LayerBuilder] progressive addField THREW for layer[${i}] key "${key}":`, err);
                return { id: plotLayer.id, ms: performance.now() - setupStarted, failed: true };
            }
        }));
        setupResults.forEach((item, i) => {
            console.info(`[NMAP layer timing] ${key}/${item.id}`, {
                layerIndex: i,
                setupMs: +item.ms.toFixed(1),
                failed: item.failed === true,
            });
        });
        if (result.sampler) samplerByKey.set(key, result.sampler);
        if (!loadedKeys.includes(key)) loadedKeys.push(key);
        if (!virtualKeys.includes(key)) virtualKeys.push(key);
        residentRecency.set(key, performance.now());
        retainedBytesByKey.set(key, estimateValueBytes(data));
        if (data?.[GEOMETRY_DIAGNOSTICS]) {
            geometryDiagnosticsByKey.set(key, data[GEOMETRY_DIAGNOSTICS]);
        }
        recordDiagnostic('frame-added', {
            source: namespace, key, bytes: retainedBytesByKey.get(key),
            durationMs: performance.now() - started,
            message: `${setupResults.length} layer(s)`,
        });
        console.info('[NMAP layer timing] Progressive frame prepared', {
            key,
            makeLayersMs: +makeLayersMs.toFixed(1),
            layerSetupMs: +(performance.now() - layerSetupStarted).toFixed(1),
            totalMs: +(performance.now() - started).toFixed(1),
            layers: setupResults.map(item => ({
                ...item,
                ms: +item.ms.toFixed(1),
            })),
        });
        await enforceGpuBudget();
    }

    /**
     * Remove a frame from all MultiPlotLayers, freeing the CPU-side field data.
     * If the key is currently displayed, the next frame is activated automatically.
     */
    async function removeResidentFrame(key) {
        const idx = loadedKeys.indexOf(key);
        if (idx === -1) return;

        // If we're about to remove the active frame, advance to the next one first
        if (currentKey === key) {
            const nextKey = loadedKeys[idx + 1] ?? loadedKeys[idx - 1] ?? null;
            if (nextKey) {
                currentKey = nextKey;
                multiLayers.forEach(ml => ml.setActiveKey(nextKey));
            }
        }

        await Promise.all(multiLayers.map(ml => ml.removeField(key)));
        samplerByKey.delete(key);
        const reclaimedBytes = retainedBytesByKey.get(key) || 0;
        retainedBytesByKey.delete(key);
        geometryDiagnosticsByKey.delete(key);
        loadedKeys.splice(idx, 1);
        recordDiagnostic('frame-purged', {
            source: namespace, key, reclaimedBytes,
            message: `${multiLayers.length} layer(s) released`,
        });
    }

    /** Permanently remove a timeline key, as opposed to a GPU-ring eviction. */
    async function removeFrame(key) {
        await removeResidentFrame(key);
        const virtualIndex = virtualKeys.indexOf(key);
        if (virtualIndex >= 0) virtualKeys.splice(virtualIndex, 1);
        residentRecency.delete(key);
    }

    const controller = {
        // Expose loadedKeys as a live reference so callers always see the latest set
        get keys() { return virtualKeys; },

        getKey()      { return currentKey; },

        setKey(key) {
            currentKey = key;
            if (loadedKeys.includes(key)) {
                residentRecency.set(key, performance.now());
                multiLayers.forEach(ml => ml.setActiveKey(key));
                scheduleUploadAhead(key);
                return;
            }
            // Keep the last complete frame visible while restoration occurs.
            // Clearing the active key here caused a black flash at high speed.
            void ensureResident(key).then(ready => {
                if (!ready || currentKey !== key) return;
                multiLayers.forEach(ml => ml.setActiveKey(key));
                scheduleUploadAhead(key);
            });
        },

        configureFrameRing({keys, loadFrame, gpuBytes, uploadAhead = 4}) {
            virtualKeys = [...keys];
            ringPolicy = {loadFrame, gpuBytes, uploadAhead, dwellMs: 100, direction: 1};
            void enforceGpuBudget();
        },

        prepareKey(key) {
            return ensureResident(key);
        },

        setPlaybackPolicy({dwellMs, direction = 1}) {
            if (ringPolicy && Number.isFinite(dwellMs)) {
                ringPolicy.dwellMs = Math.max(10, dwellMs);
                ringPolicy.direction = direction < 0 ? -1 : 1;
            }
        },

        /**
         * Return the sampler for the currently-displayed key, or null if
         * this product has no sampler.  appController calls this after
         * setKey() so _activeSampler always matches the visible frame.
         */
        getSampler() {
            return samplerByKey.get(currentKey) ?? null;
        },

        getGeometryDiagnostics() {
            if (!geometryDiagnosticsByKey.size) return null;
            const totals = {
                frameCount: geometryDiagnosticsByKey.size,
                featureCount: 0,
                coordinateCount: 0,
                logicalBytes: 0,
                sharedBytes: 0,
                retainedBytes: 0,
            };
            for (const item of geometryDiagnosticsByKey.values()) {
                totals.featureCount += item.featureCount || 0;
                totals.coordinateCount += item.coordinateCount || 0;
                totals.logicalBytes += item.logicalBytes || 0;
                totals.sharedBytes += item.sharedBytes || 0;
                totals.retainedBytes += item.retainedBytes || 0;
            }
            return totals;
        },

        stepForward() {
            const idx = loadedKeys.indexOf(currentKey);
            if (idx < loadedKeys.length - 1) this.setKey(loadedKeys[idx + 1]);
        },
        stepBackward() {
            const idx = loadedKeys.indexOf(currentKey);
            if (idx > 0) this.setKey(loadedKeys[idx - 1]);
        },
        hasNext() { return loadedKeys.indexOf(currentKey) < loadedKeys.length - 1; },
        hasPrev() { return loadedKeys.indexOf(currentKey) > 0; },

        // Hide all layers (render nothing) by clearing the active key.
        // MultiPlotLayer.render() short-circuits when field_key is null.
        hide() {
            multiLayers.forEach(ml => ml.setActiveKey(null));
        },
    };

    return {
        layers:     multiLayers,
        colorbars:  templateResult.colorbar ?? [],
        sampler:    templateResult.sampler  ?? null,
        controller,
        addFrame,
        removeFrame,
    };
}

function buildTemporalScatterometerLayers(
    productSuite,
    observations,
    frameSpecs,
    pointPolicy,
    namespace = '',
) {
    const frameWindows = frameSpecs.map(({frameKey, centerMs}) => {
        const window = pointWindow(centerMs, pointPolicy);
        return [frameKey, {
            startMinute: Math.floor(window.startMs / 60000),
            endMinute: Math.floor(window.endMs / 60000),
        }];
    });
    const layer = new TemporalScatterometerLayer(
        nsId(productSuite.layer_id ?? 'scatterometer-winds', namespace),
        observations,
        frameWindows,
        productSuite.scatterometer_options ?? {},
    );
    let currentKey = frameSpecs[0]?.frameKey ?? null;
    layer.setActiveKey(currentKey);
    const keys = frameSpecs.map(frame => frame.frameKey);
    return {
        layers: [layer],
        colorbars: productSuite.make_colorbars?.() ?? [],
        sampler: null,
        controller: {
            keys,
            getKey() { return currentKey; },
            setKey(key) {
                if (!keys.includes(key)) return;
                currentKey = key;
                layer.setActiveKey(key);
            },
            getSampler() { return null; },
            hide() { layer.setActiveKey(null); },
        },
        addFrame() {},
        removeFrame() {},
    };
}

export {
    buildStaticLayers,
    buildMultiLayers,
    buildProgressiveMultiLayers,
    buildTemporalScatterometerLayers,
};
