/**
 * LayerBuilder.test.js  (fixed)
 *
 * Fix applied:
 *   LayerBuilder.js now imports { PlotLayer, MultiPlotLayer } from 'autumnplot-gl'
 *   directly (instead of using window.apgl).  The vi.mock() factory below
 *   intercepts that named import.  The test file itself also imports from
 *   'autumnplot-gl' to construct fixture layers, which resolves to the same mock.
 *
 * ─── Why this works ──────────────────────────────────────────────────────────
 *
 * Vitest's module registry is shared across the test file and the modules it
 * imports.  When LayerBuilder.js does:
 *
 *   import { MultiPlotLayer } from 'autumnplot-gl';
 *
 * …it gets the same mock registry entry that vi.mock('autumnplot-gl', …) created.
 * So `new MultiPlotLayer(id)` inside LayerBuilder calls our MockMultiPlotLayer.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Step 1: register the mock BEFORE importing LayerBuilder ──────────────────
// vi.mock() is hoisted by Vitest to the very top of the file automatically,
// so the order here in the source doesn't technically matter — but writing it
// first makes the intent clear.
vi.mock('autumnplot-gl', () => {
    // These classes live entirely inside the factory function.
    // No variables from the outer scope are used — that's the rule Vitest
    // enforces because the factory is hoisted before any outer `const`s exist.

    class MockPlotLayer {
        constructor(id, field) {
            this.id    = id;
            this.field = field;
            this.type  = 'custom';
        }
        onAdd()  {}
        render() {}
    }

    class MockMultiPlotLayer {
        constructor(id) {
            this.id                 = id;
            this.type               = 'custom';
            this._fields            = {};
            this._activeKey         = null;
            this._addFieldCalls     = [];
            this._setActiveKeyCalls = [];
        }

        addField(field, key) {
            this._fields[key] = field;
            this._addFieldCalls.push({ field, key });
            if (this._activeKey === null) this._activeKey = key;
        }

        setActiveKey(key) {
            this._activeKey = key;
            this._setActiveKeyCalls.push(key);
        }

        getKeys() {
            return Object.keys(this._fields);
        }
    }

    return { PlotLayer: MockPlotLayer, MultiPlotLayer: MockMultiPlotLayer };
});

// ── Step 2: import the module under test — it will receive the mock above ─────
import { buildStaticLayers, buildMultiLayers } from '../LayerBuilder.js';

// ── Step 3: import the mock classes so our test fixtures can use them too ─────
// This resolves to the SAME mock registered above, not the real library.
import { PlotLayer, MultiPlotLayer } from 'autumnplot-gl';

// ════════════════════════════════════════════════════════════════════════════
// buildStaticLayers — layer ID namespacing
// ════════════════════════════════════════════════════════════════════════════

describe('buildStaticLayers — layer ID namespacing', () => {

    it('prefixes layer IDs with the namespace', () => {
        const suite = {
            data_keys: ['t2m'],
            make_layers(data, grid) {
                return {
                    layers:   [new PlotLayer('fill', {}), new PlotLayer('contour', {})],
                    colorbar: [],
                    sampler:  null,
                };
            },
        };

        const layerSet = buildStaticLayers(suite, {}, null, 'radar');

        expect(layerSet.layers[0].id).toBe('radar/fill');
        expect(layerSet.layers[1].id).toBe('radar/contour');
    });

    it('does not modify IDs when namespace is empty string', () => {
        const suite = {
            data_keys: ['t2m'],
            make_layers() {
                return { layers: [new PlotLayer('fill', {})], colorbar: [], sampler: null };
            },
        };

        const layerSet = buildStaticLayers(suite, {}, null, '');
        expect(layerSet.layers[0].id).toBe('fill');
    });

    it('does not modify IDs when namespace is omitted', () => {
        const suite = {
            data_keys: ['t2m'],
            make_layers() {
                return { layers: [new PlotLayer('fill', {})], colorbar: [], sampler: null };
            },
        };

        const layerSet = buildStaticLayers(suite, {}, null);
        expect(layerSet.layers[0].id).toBe('fill');
    });

    it('returns null controller for static layers (no time stepping)', () => {
        const suite = {
            data_keys: [],
            make_layers() {
                return { layers: [new PlotLayer('fill', {})], colorbar: [], sampler: null };
            },
        };
        const layerSet = buildStaticLayers(suite, {}, null, 'slot1');
        expect(layerSet.controller).toBeNull();
    });

    it('passes through colorbars from make_layers', () => {
        const fakeSvg = { nodeName: 'svg' };
        const suite = {
            data_keys: [],
            make_layers() {
                return { layers: [], colorbar: [fakeSvg], sampler: null };
            },
        };
        const layerSet = buildStaticLayers(suite, {}, null, 'slot1');
        expect(layerSet.colorbars).toHaveLength(1);
        expect(layerSet.colorbars[0]).toBe(fakeSvg);
    });

    it('passes through the sampler from make_layers', () => {
        const mySampler = (lon, lat) => ({ t2m: 72.5 });
        const suite = {
            data_keys: [],
            make_layers() {
                return { layers: [], colorbar: [], sampler: mySampler };
            },
        };
        const layerSet = buildStaticLayers(suite, {}, null, 'slot1');
        expect(layerSet.sampler).toBe(mySampler);
    });

    it('returns empty colorbars array when make_layers omits colorbar', () => {
        const suite = {
            data_keys: [],
            make_layers() { return { layers: [], sampler: null }; },
        };
        const layerSet = buildStaticLayers(suite, {}, null, 'slot1');
        expect(Array.isArray(layerSet.colorbars)).toBe(true);
        expect(layerSet.colorbars).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// buildMultiLayers — MultiPlotLayer construction
// ════════════════════════════════════════════════════════════════════════════

describe('buildMultiLayers — MultiPlotLayer construction', () => {

    // A suite that produces two layers per time step, using the mock PlotLayer
    const twoLayerSuite = {
        data_keys: ['t2m'],
        make_layers(data, grid) {
            return {
                layers: [
                    new PlotLayer('fill',    { sentinel: data?.sentinel }),
                    new PlotLayer('contour', { sentinel: data?.sentinel }),
                ],
                colorbar: [],
                sampler:  null,
            };
        },
    };

    const dataByKey = {
        '000': { sentinel: 'f000' },
        '006': { sentinel: 'f006' },
        '012': { sentinel: 'f012' },
    };

    const orderedKeys = ['000', '006', '012'];

    it('creates one MultiPlotLayer per PlotLayer in the product suite', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.layers).toHaveLength(2);
    });

    it('namespaces MultiPlotLayer IDs with the slot namespace', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.layers[0].id).toBe('analysis/fill');
        expect(layerSet.layers[1].id).toBe('analysis/contour');
    });

    it('each MultiPlotLayer has a field for every forecast hour key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        const fillLayer = layerSet.layers[0];
        expect(fillLayer.getKeys().sort()).toEqual(['000', '006', '012'].sort());
    });

    it('sets the first key as the active key on all layers after build', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.layers[0]._activeKey).toBe('000');
        expect(layerSet.layers[1]._activeKey).toBe('000');
    });

    it('returns a controller with all ordered keys', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.controller).not.toBeNull();
        expect(layerSet.controller.keys).toEqual(orderedKeys);
    });

    it('controller.getKey() returns the initial key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.controller.getKey()).toBe('000');
    });

    it('controller.setKey() advances ALL MultiPlotLayers simultaneously', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');

        layerSet.controller.setKey('006');

        // The critical assertion: BOTH layers must be at '006' at the same time
        expect(layerSet.layers[0]._activeKey).toBe('006');
        expect(layerSet.layers[1]._activeKey).toBe('006');
        expect(layerSet.controller.getKey()).toBe('006');
    });

    it('controller.stepForward() advances one step', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        layerSet.controller.stepForward();
        expect(layerSet.controller.getKey()).toBe('006');
    });

    it('controller.stepForward() does nothing at the last key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        layerSet.controller.setKey('012');
        layerSet.controller.stepForward();
        expect(layerSet.controller.getKey()).toBe('012');
    });

    it('controller.stepBackward() moves one step back', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        layerSet.controller.setKey('006');
        layerSet.controller.stepBackward();
        expect(layerSet.controller.getKey()).toBe('000');
    });

    it('controller.stepBackward() does nothing at the first key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        layerSet.controller.stepBackward();
        expect(layerSet.controller.getKey()).toBe('000');
    });

    it('controller.hasNext() returns false at the last key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        layerSet.controller.setKey('012');
        expect(layerSet.controller.hasNext()).toBe(false);
    });

    it('controller.hasNext() returns true before the last key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.controller.hasNext()).toBe(true);
    });

    it('controller.hasPrev() returns false at the first key', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(layerSet.controller.hasPrev()).toBe(false);
    });

    it('controller.hasPrev() returns true after stepping forward', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        layerSet.controller.stepForward();
        expect(layerSet.controller.hasPrev()).toBe(true);
    });

    it('controller.setKey() with unknown key does not throw and leaves key unchanged', () => {
        const layerSet = buildMultiLayers(twoLayerSuite, dataByKey, null, orderedKeys, 'analysis');
        expect(() => layerSet.controller.setKey('999')).not.toThrow();
        expect(layerSet.controller.getKey()).toBe('000');
    });

    it('accepts a grid factory function and calls it exactly once', () => {
        let callCount = 0;
        const gridFactory = () => { callCount++; return { ni: 100, nj: 50 }; };

        buildMultiLayers(twoLayerSuite, dataByKey, gridFactory, orderedKeys, 'slot1');
        expect(callCount).toBe(1);
    });

    it('accepts a pre-built grid object (not a function) without throwing', () => {
        const prebuiltGrid = { ni: 100, nj: 50 };
        expect(() =>
            buildMultiLayers(twoLayerSuite, dataByKey, prebuiltGrid, orderedKeys, 'slot1')
        ).not.toThrow();
    });
});
