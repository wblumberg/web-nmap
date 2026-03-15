/**
 * PanelManager.js  (updated: added reset() for testability)
 *
 * The only change from the previous version is the addition of the exported
 * `reset()` function at the bottom of the module state section.
 * Everything else is identical.
 */

import { VIEW_REGISTRY }                          from './config/views.js';

// Remove Data Sources - this information is now in the API and the client no longer needs to know about it.
import DATA_SOURCES                               from './config/datasources.js';

// The Client controls the product suites, but the data sources are now handled by the API.
import PRODUCT_SUITES                             from './products/index.js';
import { loadData }                               from './DataLoader.js';

// The layer builder builds the PlotLayers and MultiPlotLayers for a given product suite and data set.
import { buildStaticLayers, buildMultiLayers }    from './LayerBuilder.js';

// Remove TimeMatchingEngine - it's handled by the API now.
import { buildMatchMap, keyToEpochMs, epochMsToLabel } from './TimeMatchingEngine.js';

const Z_ANCHORS = {
    0: 'coastline',
    1: 'coastline',
    2: 'place-city-sm',
};
const DEFAULT_Z_ANCHOR = 'coastline';

// ─── Module-level state ───────────────────────────────────────────────────────

let _map            = null;
const _slots        = new Map();
let _dominantSlotId = null;
let _matchMap       = null;
let _currentKey     = null;

const _callbacks = {
    onLoadStart:        null,
    onLoadEnd:          null,
    onLoadError:        null,
    onSlotsChanged:     null,
    onTimeChange:       null,
    onColorbarsChanged: null,
};

// ─── Initialization ───────────────────────────────────────────────────────────

function init(map) {
    _map = map;
}

/**
 * reset() — clear ALL module-level state back to initial values.
 *
 * This is primarily for use in tests (call it in beforeEach) so that
 * state from one test cannot bleed into the next.
 *
 * In production code you would call this if the user navigates away from
 * the map view entirely and you need to tear everything down.
 */
function reset() {
    _map            = null;
    _dominantSlotId = null;
    _matchMap       = null;
    _currentKey     = null;
    _slots.clear();

    // Reset all callbacks to null so tests that set specific callbacks
    // don't accidentally fire them in subsequent tests
    _callbacks.onLoadStart        = null;
    _callbacks.onLoadEnd          = null;
    _callbacks.onLoadError        = null;
    _callbacks.onSlotsChanged     = null;
    _callbacks.onTimeChange       = null;
    _callbacks.onColorbarsChanged = null;
}

function setCallbacks(callbacks) {
    Object.assign(_callbacks, callbacks);
}

// ─── Slot management ──────────────────────────────────────────────────────────
// A "slot" is a logical container for a set of layers that are all
// associated with a single view (e.g., a single product at a single time).
//
// Example:
//   addSlot({
//       slotId: 'slot1',
//       viewId: 'gfs_2m_temp',
//       zOrder: 1,
//       preloadAll: true,
//       dominant: true,
//   });
//
// This will create a new slot with ID "slot1" that displays the GFS 2-meter
// temperature product and all autumnplot-gl layers associated with it. 
// The layers will be added to the map at z-order 1.
// All available forecast hours will be preloaded, and this slot will be
// marked as the dominant slot (controlling the current time key).
//
// Slots can be added, removed, updated, and made dominant. The dominant
// slot is the one that controls the current time key, and the API will 
// attempt to match the dominant slot's key to the other slots' keys using.
//

// add a slot with the given slotId, viewId, zOrder, and options
async function addSlot({ slotId, viewId, zOrder = 1, preloadAll = false, dominant = false }) {
    if (!_map) throw new Error('PanelManager: call init(map) first.');
    if (_slots.has(slotId)) {
        console.warn(`PanelManager: slot "${slotId}" already exists. Remove it first.`);
        return;
    }

    // Notify callbacks that loading is starting
    _callbacks.onLoadStart?.();

    try {
        // Load the view and product suite names
        const view  = VIEW_REGISTRY[viewId];
        const suite = PRODUCT_SUITES[view.product_id];

        // Load the data for the view and build the layer set
        const layerSet   = await _buildLayerSet(slotId, view, suite, preloadAll);
        const descriptor = _buildDescriptor(viewId, layerSet);

        // Add the layers to the map at the specified z-order
        const anchor = Z_ANCHORS[zOrder] ?? DEFAULT_Z_ANCHOR;
        layerSet.layers.forEach(lyr => _map.addLayer(lyr, anchor));

        // Store the slot information in the _slots map
        _slots.set(slotId, {
            slotId,
            viewId,
            layerSet,
            descriptor,
            zOrder,
            visible: true,
        });

        // Make dominant if explicitly requested OR if this is the first slot
        if (dominant || _dominantSlotId === null) {
            _setDominant(slotId, layerSet.controller?.keys?.[0] ?? null);
        }

        // Rebuild the match map for time keys across slots
        _rebuildMatchMap();

        // If we have a current key, apply it to all slots (dominant and secondary)
        if (_currentKey !== null) {
            _applyMatchedKeys(_currentKey);
        }

        // Notify callbacks about the new state
        _callbacks.onColorbarsChanged?.(slotId, layerSet.colorbars);
        _callbacks.onSlotsChanged?.(_getSlotsPublic());
        _callbacks.onLoadEnd?.();

    } catch (err) {
        console.error(`PanelManager: addSlot failed for slot "${slotId}"`, err);
        _callbacks.onLoadError?.(err);
    }
}

// remove a slot with the given slotId
function removeSlot(slotId) {
    const slot = _slots.get(slotId);
    if (!slot) {
        console.warn(`PanelManager: slot "${slotId}" not found.`);
        return;
    }

    slot.layerSet.layers.forEach(lyr => {
        if (_map.getLayer(lyr.id)) _map.removeLayer(lyr.id);
    });

    _slots.delete(slotId);

    if (_dominantSlotId === slotId) {
        const remaining = [..._slots.keys()];
        if (remaining.length > 0) {
            _setDominant(remaining[0], _slots.get(remaining[0]).layerSet.controller?.keys?.[0] ?? null);
        } else {
            _dominantSlotId = null;
            _currentKey     = null;
            _matchMap       = null;
        }
    }

    _rebuildMatchMap();
    _callbacks.onSlotsChanged?.(_getSlotsPublic());
}

// set what the dominant slot is (the one that controls the current time key)
function setDominantSlot(slotId) {
    if (!_slots.has(slotId)) {
        throw new Error(`PanelManager: slot "${slotId}" not found.`);
    }
    const slot = _slots.get(slotId);
    _setDominant(slotId, slot.layerSet.controller?.getKey() ?? null);
    _rebuildMatchMap();

    if (_currentKey !== null) {
        _applyMatchedKeys(_currentKey);
    }

    _callbacks.onSlotsChanged?.(_getSlotsPublic());
}

// set the visibility of a slot and its layers (show/hide the slot)
function setSlotVisible(slotId, visible) {
    const slot = _slots.get(slotId);
    if (!slot) return;

    slot.visible = visible;
    slot.layerSet.layers.forEach(lyr => {
        if (_map.getLayer(lyr.id)) {
            _map.setLayoutProperty(lyr.id, 'visibility', visible ? 'visible' : 'none');
        }
    });
}

// update a slot with a new viewId and optionally preloadAll
async function updateSlot(slotId, newViewId, options = {}) {
    const existing = _slots.get(slotId);
    if (!existing) throw new Error(`PanelManager: slot "${slotId}" not found.`);

    const wasDominant = (_dominantSlotId === slotId);
    const zOrder      = existing.zOrder;

    existing.layerSet.layers.forEach(lyr => {
        if (_map.getLayer(lyr.id)) _map.removeLayer(lyr.id);
    });
    _slots.delete(slotId);

    await addSlot({
        slotId,
        viewId:     newViewId,
        zOrder,
        dominant:   wasDominant,
        preloadAll: options.preloadAll ?? false,
    });
}

// ─── Time stepping ────────────────────────────────────────────────────────────
// The following functions allow stepping forward/backward through the time keys
// of the dominant slot, and setting the current key (time) directly. The
// PanelManager will attempt to match the dominant slot's key to the other slots'
// keys using the match map built from the descriptors of all slots.

// step forward to the next key (time) in the dominant slot
function stepForward() {
    if (!_dominantSlotId || !_currentKey) return;

    const domSlot = _slots.get(_dominantSlotId);
    const keys    = domSlot.descriptor.keys;
    const idx     = keys.indexOf(_currentKey);

    if (idx < keys.length - 1) {
        _applyMatchedKeys(keys[idx + 1]);
    }
}

// step backward to the previous key (time) in the dominant slot
function stepBackward() {
    if (!_dominantSlotId || !_currentKey) return;

    const domSlot = _slots.get(_dominantSlotId);
    const keys    = domSlot.descriptor.keys;
    const idx     = keys.indexOf(_currentKey);

    if (idx > 0) {
        _applyMatchedKeys(keys[idx - 1]);
    }
}

// set the current key (time) for the dominant slot and attempt to match it to other slots
function setKey(key) {
    if (!_dominantSlotId) return;
    const domSlot = _slots.get(_dominantSlotId);
    if (!domSlot.descriptor.keys.includes(key)) {
        console.warn(`PanelManager: key "${key}" not available on dominant slot.`);
        return;
    }
    _applyMatchedKeys(key);
}

// ─── Query API ────────────────────────────────────────────────────────────────
// The following functions allow querying the API about the current state of the slots,
// the dominant slot, current key, and matched keys across slots.  
function getSlots()          { return _getSlotsPublic(); }
function getDominantSlotId() { return _dominantSlotId; }
function getCurrentKey()     { return _currentKey; }

// Return the keys (times) available for the dominant slot
function getDominantKeys() {
    if (!_dominantSlotId) return [];
    return _slots.get(_dominantSlotId)?.descriptor?.keys ?? [];
}

// Return the current valid time label for the dominant slot's current key
function getCurrentValidTimeLabel() {
    if (!_currentKey || !_dominantSlotId) return null;
    const slot = _slots.get(_dominantSlotId);
    try {
        const ms = keyToEpochMs(_currentKey, slot.descriptor);
        return epochMsToLabel(ms);
    } catch {
        return _currentKey;
    }
}

// Handle the sampler for the dominant slot and any secondary slots that have a sampler defined.
function sampleAt(lon, lat) {
    const results = {};
    _slots.forEach((slot, slotId) => {
        if (slot.visible && slot.layerSet.sampler) {
            results[slotId] = slot.layerSet.sampler(lon, lat);
        }
    });
    return results;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _buildLayerSet(slotId, view, suite, preloadAll) {
    const src = view.source_id ? DATA_SOURCES[view.source_id] : null;

    if (preloadAll && view.available_fhrs?.length > 1) {
        const grid   = src?.grid ?? null;
        const fhrs   = view.available_fhrs;
        const keys   = fhrs.map(fhr => String(fhr).padStart(3, '0'));

        const dataEntries = await Promise.all(
            fhrs.map(async (fhr, i) => {
                const data = await loadData(view.source_id, suite.data_keys,
                                            { ...view.time, fhr }, view.var_map ?? {});
                return [keys[i], data];
            })
        );
        const dataByKey = Object.fromEntries(dataEntries);

        // Build the MultiPlotLayers for all keys (times) and return the result
        return buildMultiLayers(suite, dataByKey, grid, keys, slotId);
    } else {
        const grid = src?.grid?.() ?? null;
        const data = await _loadViewData(view, suite.data_keys);
        // Build the PlotLayers for the single time and return the result
        return buildStaticLayers(suite, data, grid, slotId);
    }
}

async function _loadViewData(view, dataKeys) {
    if (!view.source_id) return {};
    return loadData(view.source_id, dataKeys, view.time, view.var_map ?? {});
}

function _buildDescriptor(viewId, layerSet) {
    const view = VIEW_REGISTRY[viewId];
    const keys = layerSet.controller?.keys ?? (view.time?.valid_time ? [view.time.valid_time] : ['000']);

    if (view.time?.fhr !== undefined) {
        return { type: 'fhr', cycle: view.time.cycle, keys };
    }
    return { type: 'valid_time', keys };
}

// Set the dominant slot and the initial key (time) for that slot
function _setDominant(slotId, initialKey) {
    _dominantSlotId = slotId;
    _currentKey     = initialKey ?? _slots.get(slotId)?.descriptor?.keys?.[0] ?? null;
}

function _rebuildMatchMap() {
    if (!_dominantSlotId || _slots.size < 2) {
        _matchMap = null;
        return;
    }

    const domSlot = _slots.get(_dominantSlotId);
    if (!domSlot) return;

    const secondarySources = {};
    _slots.forEach((slot, slotId) => {
        if (slotId !== _dominantSlotId) {
            secondarySources[slotId] = slot.descriptor;
        }
    });

    _matchMap = buildMatchMap(domSlot.descriptor, secondarySources);
}

function _applyMatchedKeys(dominantKey) {
    _currentKey = dominantKey;

    _slots.forEach((slot, slotId) => {
        const controller = slot.layerSet.controller;
        if (!controller) return;

        if (slotId === _dominantSlotId) {
            controller.setKey(dominantKey);
        } else if (_matchMap?.[dominantKey]?.[slotId]) {
            controller.setKey(_matchMap[dominantKey][slotId]);
        }
    });

    const keysSummary = {};
    _slots.forEach((slot, slotId) => {
        keysSummary[slotId] = slotId === _dominantSlotId
            ? dominantKey
            : (_matchMap?.[dominantKey]?.[slotId] ?? null);
    });

    _callbacks.onTimeChange?.(dominantKey, getCurrentValidTimeLabel(), keysSummary);
}

function _getSlotsPublic() {
    return [..._slots.entries()].map(([slotId, slot]) => ({
        slotId,
        viewId:     slot.viewId,
        label:      VIEW_REGISTRY[slot.viewId]?.label ?? slotId,
        zOrder:     slot.zOrder,
        visible:    slot.visible,
        dominant:   slotId === _dominantSlotId,
        hasTime:    !!slot.layerSet.controller,
        keys:       slot.descriptor.keys,
        currentKey: slotId === _dominantSlotId
            ? _currentKey
            : (_matchMap?.[_currentKey]?.[slotId] ?? null),
    }));
}

export {
    init,
    reset,
    setCallbacks,
    addSlot,
    removeSlot,
    updateSlot,
    setDominantSlot,
    setSlotVisible,
    stepForward,
    stepBackward,
    setKey,
    getSlots,
    getDominantSlotId,
    getDominantKeys,
    getCurrentKey,
    getCurrentValidTimeLabel,
    sampleAt,
};
