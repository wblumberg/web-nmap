import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakePlotLayer, FakeMultiPlotLayer } = vi.hoisted(() => {
    class PlotLayer {
        constructor(id, field) {
            this.id = id;
            this.field = field;
        }
    }
    class MultiPlotLayer {
        constructor(id) {
            this.id = id;
            this.fields = new Map();
            this.activeKey = null;
        }
        async addField(layer, key) {
            this.fields.set(key, layer.field);
            if (this.activeKey === null) this.activeKey = key;
        }
        async removeField(key) {
            this.fields.get(key)?.dispose?.();
            this.fields.delete(key);
        }
        setActiveKey(key) { this.activeKey = key; }
        getKeys() { return [...this.fields.keys()]; }
    }
    return { FakePlotLayer: PlotLayer, FakeMultiPlotLayer: MultiPlotLayer };
});

vi.mock('autumnplot-gl', () => ({
    PlotLayer: FakePlotLayer,
    MultiPlotLayer: FakeMultiPlotLayer,
}));

vi.mock('autumnplot-gl-extensions', () => ({
    ScatterometerTimeSeriesLayer: class {},
    TemporalScatterometerLayer: class {},
}));

import { buildProgressiveMultiLayers } from '../domain/layerBuilder.js';

describe('rolling frame lifecycle', () => {
    let disposed;
    let suite;

    beforeEach(() => {
        disposed = [];
        suite = {
            make_layers(data) {
                return {
                    layers: ['radar', 'pressure', 'lightning'].map(id =>
                        new FakePlotLayer(id, { data, dispose: () => disposed.push([id, data]) })
                    ),
                    colorbar: [],
                    sampler: null,
                };
            },
        };
    });

    it('retains exactly the configured keys in every layer after 100 updates', async () => {
        const targetFrames = 12;
        const progressive = buildProgressiveMultiLayers(suite, 'frame-0', 0, {});
        const expected = ['frame-0'];

        for (let index = 1; index <= 100; index++) {
            const key = `frame-${index}`;
            await progressive.addFrame(key, index);
            expected.push(key);
            if (expected.length > targetFrames) {
                await progressive.removeFrame(expected.shift());
            }
        }

        expect(progressive.controller.keys).toEqual(expected);
        for (const layer of progressive.layers) {
            expect(layer.getKeys()).toEqual(expected);
            expect(layer.getKeys()).toHaveLength(targetFrames);
        }
        expect(disposed).toHaveLength((101 - targetFrames) * 3);
    });
});
