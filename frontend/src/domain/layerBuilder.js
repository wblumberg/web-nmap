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

// ─── ID namespacing ───────────────────────────────────────────────────────────
function nsId(id, namespace) {
    return namespace ? `${namespace}/${id}` : id;
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

    // Mutable ordered list of loaded keys
    const loadedKeys = [firstKey];
    let currentKey = firstKey;

    // Track per-key samplers so the active sampler can be swapped when the
    // displayed frame changes (important for geometry / alert products).
    const samplerByKey = new Map();
    if (templateResult.sampler) samplerByKey.set(firstKey, templateResult.sampler);

    /**
     * Add a new frame to all MultiPlotLayers.
     * Can be called after the layers are already on the map.
     */
    function addFrame(key, data) {
        let result;
        try {
            result = productSuite.make_layers(data, grid);
        } catch (err) {
            console.error(`[LayerBuilder] progressive addFrame make_layers THREW for key "${key}":`, err);
            return;
        }
        result.layers.forEach((plotLayer, i) => {
            try {
                multiLayers[i].addField(_namespaceLayer(plotLayer, namespace), key);
            } catch (err) {
                console.error(`[LayerBuilder] progressive addField THREW for layer[${i}] key "${key}":`, err);
            }
        });
        if (result.sampler) samplerByKey.set(key, result.sampler);
        loadedKeys.push(key);
    }

    /**
     * Remove a frame from all MultiPlotLayers, freeing the CPU-side field data.
     * If the key is currently displayed, the next frame is activated automatically.
     */
    function removeFrame(key) {
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

        multiLayers.forEach(ml => ml.removeField(key));
        samplerByKey.delete(key);
        loadedKeys.splice(idx, 1);
    }

    const controller = {
        // Expose loadedKeys as a live reference so callers always see the latest set
        get keys() { return loadedKeys; },

        getKey()      { return currentKey; },

        setKey(key) {
            if (!loadedKeys.includes(key)) return;
            currentKey = key;
            multiLayers.forEach(ml => ml.setActiveKey(key));
        },

        /**
         * Return the sampler for the currently-displayed key, or null if
         * this product has no sampler.  appController calls this after
         * setKey() so _activeSampler always matches the visible frame.
         */
        getSampler() {
            return samplerByKey.get(currentKey) ?? null;
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

export { buildStaticLayers, buildMultiLayers, buildProgressiveMultiLayers };
