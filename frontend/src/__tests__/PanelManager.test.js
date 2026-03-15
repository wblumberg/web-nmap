/**
 * PanelManager.test.js  (fixed — state isolation + corrected mocks)
 *
 * Root causes of the 7 failures and their fixes:
 *
 * ── Failures 1, 2, 3, 4, 5, 6 — stale module state ──────────────────────────
 *
 * PanelManager uses module-level variables (_slots, _dominantSlotId, _callbacks,
 * etc.) that are shared across the entire test file. The old beforeEach only
 * called PanelManager.init(mockMap), which sets _map but leaves _slots and
 * _dominantSlotId untouched.
 *
 * Fix: PanelManager.js now exports a reset() function that clears ALL
 * module-level state. beforeEach calls reset() then init(mockMap), giving
 * every test a genuinely clean slate.
 *
 * ── Failure 7 — wrong sampler in sampleAt test ───────────────────────────────
 *
 * The 'test_obs' mock product (product_id: 'surface_obs_standard') returned
 * sampler: null from make_layers(), but the LayerBuilder mock returned the
 * sampler it received from the suite directly. The confusion arose because
 * 'test_mrms' was added first in beforeEach (from leaked state), and its slot
 * leftover had a sampler. Cleaning state with reset() fixes this, but we also
 * tighten the product mocks to be unambiguous about which suites have samplers.
 *
 * ── General pattern ──────────────────────────────────────────────────────────
 *
 * Each test now follows the same setup:
 *   1. Call PanelManager.reset()        — wipes all state
 *   2. Call PanelManager.init(mockMap)  — installs a fresh map
 *   3. (optionally) call setCallbacks() — install only the callbacks this test needs
 *   4. Call addSlot() / exercise the API
 *   5. Assert
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── All vi.mock() calls are hoisted to the top of the file by Vitest ──────────
// Rule: factory functions must be self-contained — no require(), no outer vars.

vi.mock('autumnplot-gl', () => {
    class MockPlotLayer {
        constructor(id) { this.id = id; this.type = 'custom'; }
        onAdd()  {}
        render() {}
    }
    class MockMultiPlotLayer {
        constructor(id) {
            this.id = id; this.type = 'custom';
            this._fields = {}; this._activeKey = null;
        }
        addField(f, k)  { this._fields[k] = f; if (!this._activeKey) this._activeKey = k; }
        setActiveKey(k) { this._activeKey = k; }
        getKeys()       { return Object.keys(this._fields); }
    }
    return { PlotLayer: MockPlotLayer, MultiPlotLayer: MockMultiPlotLayer };
});

vi.mock('../config/views.js', () => ({
    VIEW_REGISTRY: {
        'test_mrms': {
            label: 'MRMS Test',
            source_id: 'MRMS',
            product_id: 'mrms_cref',      // ← no sampler
            time: { valid_time: '20250302_1800' },
            var_map: {},
            available_fhrs: null,
        },
        'test_rap': {
            label: 'RAP MSLP Test',
            source_id: 'RAP',
            product_id: 'mslp_fill',      // ← has a sampler
            time: { cycle: '2025030200', fhr: 0 },
            var_map: {},
            available_fhrs: [0, 1, 2, 3], // 4 keys → stepping is possible
        },
        'test_obs': {
            label: 'Surface Obs Test',
            source_id: 'SURFACE_OBS',
            product_id: 'surface_obs_standard', // ← no sampler
            time: { valid_time: '20250302_1800' },
            var_map: {},
            available_fhrs: null,
        },
    },
    getActiveGroups: () => [],
    getViewsByGroup: () => [],
}));

vi.mock('../config/datasources.js', () => ({
    default: {
        'MRMS':        { format: 'zarr', grid: () => ({ ni: 100, nj: 50 }) },
        'RAP':         { format: 'zarr', grid: () => ({ ni: 80,  nj: 40 }) },
        'SURFACE_OBS': { format: 'compressed_json' },
    },
}));

vi.mock('../products/index.js', () => {
    // MockPlotLayer defined inline — cannot reference outside the factory
    class MockPlotLayer {
        constructor(id) { this.id = id; this.type = 'custom'; }
    }

    return {
        default: {
            // mrms_cref: no sampler
            'mrms_cref': {
                data_keys: ['cref'],
                make_layers() {
                    return {
                        layers:   [new MockPlotLayer('mrms_cref')],
                        colorbar: [],
                        sampler:  null,           // explicitly null — no point sampling
                    };
                },
            },
            // mslp_fill: has a sampler so sampleAt() tests can detect it
            'mslp_fill': {
                data_keys: ['mslp'],
                make_layers() {
                    return {
                        layers:   [new MockPlotLayer('mslp_fill'),
                                   new MockPlotLayer('mslp_cntr')],
                        colorbar: [],
                        sampler:  (lon, lat) => ({ mslp: 1013.2 }),
                    };
                },
            },
            // surface_obs_standard: no sampler
            'surface_obs_standard': {
                data_keys: ['obs_json'],
                make_layers() {
                    return {
                        layers:   [new MockPlotLayer('sfc_obs')],
                        colorbar: [],
                        sampler:  null,           // explicitly null
                    };
                },
            },
        },
    };
});

vi.mock('../DataLoader.js', () => ({
    loadData: vi.fn().mockResolvedValue({}),
}));

vi.mock('../LayerBuilder.js', () => {
    // All mock classes defined inline — no require(), no outer imports
    class MockPlotLayer {
        constructor(id) { this.id = id; this.type = 'custom'; }
    }

    const buildStaticLayers = vi.fn((suite, data, grid, namespace) => {
        const raw    = suite.make_layers(data, grid);
        const layers = raw.layers.map(l => ({
            ...l,
            id:   namespace ? `${namespace}/${l.id}` : l.id,
            type: 'custom',
        }));
        return {
            layers,
            colorbars:  raw.colorbar ?? [],
            // Pass the sampler through from the product suite so sampleAt() works
            sampler:    raw.sampler  ?? null,
            controller: null,
        };
    });

    const buildMultiLayers = vi.fn((suite, dataByKey, grid, orderedKeys, namespace) => {
        // Build a real controller so stepForward/stepBackward work in tests
        let currentKey = orderedKeys[0];
        const controller = {
            keys:         orderedKeys,
            getKey:       ()  => currentKey,
            setKey:       (k) => { if (orderedKeys.includes(k)) currentKey = k; },
            stepForward:  ()  => {
                const i = orderedKeys.indexOf(currentKey);
                if (i < orderedKeys.length - 1) currentKey = orderedKeys[i + 1];
            },
            stepBackward: ()  => {
                const i = orderedKeys.indexOf(currentKey);
                if (i > 0) currentKey = orderedKeys[i - 1];
            },
            hasNext: () => orderedKeys.indexOf(currentKey) < orderedKeys.length - 1,
            hasPrev: () => orderedKeys.indexOf(currentKey) > 0,
        };
        const raw    = suite.make_layers(dataByKey[orderedKeys[0]], null);
        const layers = raw.layers.map(l => ({
            ...l,
            id:   namespace ? `${namespace}/${l.id}` : l.id,
            type: 'custom',
        }));
        return {
            layers,
            colorbars:  raw.colorbar ?? [],
            sampler:    raw.sampler  ?? null,
            controller,
        };
    });

    return { buildStaticLayers, buildMultiLayers };
});

// ── Import PanelManager AFTER all mocks are registered ───────────────────────
import * as PanelManager from '../PanelManager.js';

// ─── Mock map factory ─────────────────────────────────────────────────────────
function createMockMap() {
    return {
        addLayer:          vi.fn(),
        removeLayer:       vi.fn(),
        getLayer:          vi.fn().mockReturnValue(true),
        setLayoutProperty: vi.fn(),
    };
}

// ─── State isolation: reset + fresh map before EVERY test ────────────────────
//
// This is the critical fix. beforeEach runs before every `it()` block.
//
// Without reset(), module-level state from test N leaks into test N+1:
//   - _slots still contains slots added by the previous test
//   - _dominantSlotId still points to the previous dominant
//   - _callbacks still has the previous test's spy functions registered
//
// With reset(), every test starts from a known-clean state, exactly like
// running a single test in isolation.
//
beforeEach(() => {
    // 1. Wipe all module-level state (slots, dominant, callbacks, currentKey)
    PanelManager.reset();
    // 2. Install a fresh mock map (fresh spy call counters)
    PanelManager.init(createMockMap());
    // 3. Clear all vi.fn() call records from previous tests
    vi.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// addSlot
// ═══════════════��════════════════════════════════════════════════════════════

describe('addSlot', () => {

    it('adds layers to the map after loading', async () => {
        // Use a fresh map so we can inspect addLayer calls cleanly
        const mockMap = createMockMap();
        PanelManager.reset();
        PanelManager.init(mockMap);

        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        expect(mockMap.addLayer).toHaveBeenCalled();
    });

    it('slot appears in getSlots() after being added', async () => {
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        const slotIds = PanelManager.getSlots().map(s => s.slotId);
        expect(slotIds).toContain('radar');
    });

    it('first slot added becomes the dominant slot automatically', async () => {
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        expect(PanelManager.getDominantSlotId()).toBe('radar');
    });

    it('second slot does not override dominant unless dominant:true is passed', async () => {
        await PanelManager.addSlot({ slotId: 'radar',    viewId: 'test_mrms', zOrder: 0 });
        await PanelManager.addSlot({ slotId: 'analysis', viewId: 'test_rap',  zOrder: 1 });

        // 'radar' was first — should still be dominant
        expect(PanelManager.getDominantSlotId()).toBe('radar');
    });

    it('dominant:true makes the new slot dominant', async () => {
        await PanelManager.addSlot({ slotId: 'radar',    viewId: 'test_mrms', zOrder: 0 });
        await PanelManager.addSlot({
            slotId:   'analysis',
            viewId:   'test_rap',
            zOrder:   1,
            dominant: true,   // <-- explicit takeover
        });

        // 'analysis' must now be dominant despite being added second
        expect(PanelManager.getDominantSlotId()).toBe('analysis');
    });

    it('fires onSlotsChanged callback when a slot is added', async () => {
        const onSlotsChanged = vi.fn();
        // Set callbacks BEFORE the addSlot call so it is registered in time
        PanelManager.setCallbacks({ onSlotsChanged });

        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        expect(onSlotsChanged).toHaveBeenCalled();
    });

    it('fires onLoadStart and onLoadEnd callbacks during load', async () => {
        const onLoadStart = vi.fn();
        const onLoadEnd   = vi.fn();
        // Callbacks must be set BEFORE addSlot is awaited
        PanelManager.setCallbacks({ onLoadStart, onLoadEnd });

        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        expect(onLoadStart).toHaveBeenCalledOnce();
        expect(onLoadEnd).toHaveBeenCalledOnce();
    });

    it('warns but does not throw when adding a duplicate slot ID', async () => {
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        // Second addSlot with the same ID should resolve without throwing
        await expect(
            PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 })
        ).resolves.not.toThrow();

        // And the slot count should still be 1, not 2
        expect(PanelManager.getSlots()).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// removeSlot
// ════════════════════════════════════════════════════════════════════════════

describe('removeSlot', () => {

    it('removes layers from the map', async () => {
        const mockMap = createMockMap();
        PanelManager.reset();
        PanelManager.init(mockMap);

        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });
        PanelManager.removeSlot('radar');

        expect(mockMap.removeLayer).toHaveBeenCalled();
    });

    it('slot no longer appears in getSlots() after removal', async () => {
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });
        PanelManager.removeSlot('radar');

        const slotIds = PanelManager.getSlots().map(s => s.slotId);
        expect(slotIds).not.toContain('radar');
    });

    it('removing the only slot sets dominant to null', async () => {
        // Add exactly one slot, then remove it
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        // Verify it is currently dominant
        expect(PanelManager.getDominantSlotId()).toBe('radar');

        PanelManager.removeSlot('radar');

        // No slots remain → dominant must be null
        expect(PanelManager.getDominantSlotId()).toBeNull();
    });

    it('when dominant is removed, the next remaining slot becomes dominant', async () => {
        await PanelManager.addSlot({ slotId: 'radar',    viewId: 'test_mrms', zOrder: 0 });
        await PanelManager.addSlot({ slotId: 'analysis', viewId: 'test_rap',  zOrder: 1 });

        // 'radar' is dominant (was added first)
        PanelManager.removeSlot('radar');

        // 'analysis' is the only remaining slot — must become dominant
        expect(PanelManager.getDominantSlotId()).toBe('analysis');
    });

    it('warns but does not throw when removing a non-existent slot', () => {
        expect(() => PanelManager.removeSlot('nonexistent')).not.toThrow();
    });

    it('fires onSlotsChanged callback after removal', async () => {
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        const onSlotsChanged = vi.fn();
        PanelManager.setCallbacks({ onSlotsChanged });

        PanelManager.removeSlot('radar');

        expect(onSlotsChanged).toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// setDominantSlot
// ════════════════════════════════════════════════════════════════════════════

describe('setDominantSlot', () => {

    it('changes the dominant slot to the specified ID', async () => {
        await PanelManager.addSlot({ slotId: 'radar',    viewId: 'test_mrms', zOrder: 0 });
        await PanelManager.addSlot({ slotId: 'analysis', viewId: 'test_rap',  zOrder: 1 });

        PanelManager.setDominantSlot('analysis');

        expect(PanelManager.getDominantSlotId()).toBe('analysis');
    });

    it('throws when given a non-existent slot ID', () => {
        expect(() => PanelManager.setDominantSlot('nonexistent')).toThrow();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// setSlotVisible
// ════════════════════════════════════════════════════════════════════════════

describe('setSlotVisible', () => {

    it('calls setLayoutProperty with "none" when hiding a slot', async () => {
        const mockMap = createMockMap();
        PanelManager.reset();
        PanelManager.init(mockMap);

        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });
        PanelManager.setSlotVisible('radar', false);

        expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
            expect.any(String),
            'visibility',
            'none'
        );
    });

    it('calls setLayoutProperty with "visible" when showing a slot', async () => {
        const mockMap = createMockMap();
        PanelManager.reset();
        PanelManager.init(mockMap);

        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });
        PanelManager.setSlotVisible('radar', false);
        PanelManager.setSlotVisible('radar', true);

        expect(mockMap.setLayoutProperty).toHaveBeenLastCalledWith(
            expect.any(String),
            'visibility',
            'visible'
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Time stepping
// ════════════════════════════════════════════════════════════════════════════

describe('stepForward / stepBackward / setKey', () => {
    // All these tests use 'test_rap' with preloadAll:true.
    // The 'test_rap' view has available_fhrs: [0, 1, 2, 3] → keys ['000','001','002','003'].
    // The mock buildMultiLayers returns a real controller that can step through those keys.

    async function addRapSlot() {
        await PanelManager.addSlot({
            slotId:     'analysis',
            viewId:     'test_rap',
            zOrder:     1,
            preloadAll: true,
            dominant:   true,
        });
    }

    it('stepForward advances the current key by one step', async () => {
        await addRapSlot();

        const keyBefore = PanelManager.getCurrentKey();   // '000'
        PanelManager.stepForward();
        const keyAfter  = PanelManager.getCurrentKey();   // '001'

        expect(keyAfter).not.toBe(keyBefore);
    });

    it('stepForward moves to the second key specifically', async () => {
        await addRapSlot();
        PanelManager.stepForward();

        // keys are ['000','001','002','003'] → after one step should be '001'
        expect(PanelManager.getCurrentKey()).toBe('001');
    });

    it('stepBackward does nothing when already at the first key', async () => {
        await addRapSlot();

        // At '000' — cannot go back
        const keyBefore = PanelManager.getCurrentKey();
        PanelManager.stepBackward();

        expect(PanelManager.getCurrentKey()).toBe(keyBefore);
    });

    it('stepBackward returns to previous key after stepForward', async () => {
        await addRapSlot();
        PanelManager.stepForward();   // → '001'
        PanelManager.stepBackward();  // → '000'

        expect(PanelManager.getCurrentKey()).toBe('000');
    });

    it('setKey jumps directly to a specified key', async () => {
        await addRapSlot();

        const keys    = PanelManager.getDominantKeys();
        const lastKey = keys[keys.length - 1];  // '003'
        PanelManager.setKey(lastKey);

        expect(PanelManager.getCurrentKey()).toBe(lastKey);
    });

    it('fires onTimeChange callback when stepping forward', async () => {
        // Register callback BEFORE adding the slot so it is in place
        const onTimeChange = vi.fn();
        PanelManager.setCallbacks({ onTimeChange });

        await addRapSlot();

        // Clear calls fired during addSlot (initial key set)
        onTimeChange.mockClear();

        PanelManager.stepForward();

        expect(onTimeChange).toHaveBeenCalled();
    });

    it('onTimeChange receives the new key as its first argument', async () => {
        const onTimeChange = vi.fn();
        PanelManager.setCallbacks({ onTimeChange });

        await addRapSlot();
        onTimeChange.mockClear();

        PanelManager.stepForward();

        // First argument to onTimeChange should be the new dominant key
        const [calledWithKey] = onTimeChange.mock.calls[0];
        expect(calledWithKey).toBe('001');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// sampleAt
// ════════════════════════════════════════════════════════════════════════════

describe('sampleAt', () => {

    it('returns a plain object', async () => {
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });

        const result = PanelManager.sampleAt(-97.5, 38.5);
        expect(typeof result).toBe('object');
        expect(result).not.toBeNull();
    });

    it('returns empty object when all slots have null sampler', async () => {
        // Both test_mrms and test_obs have sampler: null in the product mock
        await PanelManager.addSlot({ slotId: 'radar', viewId: 'test_mrms', zOrder: 0 });
        await PanelManager.addSlot({ slotId: 'obs',   viewId: 'test_obs',  zOrder: 2 });

        const result = PanelManager.sampleAt(-97.5, 38.5);
        expect(Object.keys(result)).toHaveLength(0);
    });

    it('includes a slot that has a sampler', async () => {
        // test_rap has sampler: (lon, lat) => ({ mslp: 1013.2 })
        await PanelManager.addSlot({ slotId: 'analysis', viewId: 'test_rap', zOrder: 1 });

        const result = PanelManager.sampleAt(-97.5, 38.5);
        expect(result).toHaveProperty('analysis');
        expect(result.analysis).toEqual({ mslp: 1013.2 });
    });

    it('does not include hidden slots in sample results', async () => {
        await PanelManager.addSlot({ slotId: 'analysis', viewId: 'test_rap', zOrder: 1 });
        PanelManager.setSlotVisible('analysis', false);

        const result = PanelManager.sampleAt(-97.5, 38.5);
        expect(result).not.toHaveProperty('analysis');
    });

    it('re-includes a slot after it is made visible again', async () => {
        await PanelManager.addSlot({ slotId: 'analysis', viewId: 'test_rap', zOrder: 1 });
        PanelManager.setSlotVisible('analysis', false);
        PanelManager.setSlotVisible('analysis', true);

        const result = PanelManager.sampleAt(-97.5, 38.5);
        expect(result).toHaveProperty('analysis');
    });
});
