import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/colormaps.js', () => ({ default: {} }));

import instability from '../domain/dataProducts/instability.js';

describe('patterned instability products', () => {
    let contourFillCalls;

    beforeEach(() => {
        contourFillCalls = [];

        class RawScalarField {
            constructor(grid, data) {
                this.grid = grid;
                this.data = data;
            }
            sampleField() { return -75; }
        }

        class ColorMap {
            constructor(levels, colors, options) {
                this.levels = levels;
                this.colors = colors;
                this.options = options;
            }
        }

        class ContourFill {
            constructor(field, options) {
                this.field = field;
                this.opts = options;
                contourFillCalls.push({ field, options });
            }
        }

        class PlotLayer {
            constructor(id, field) {
                this.id = id;
                this.field = field;
            }
        }

        globalThis.apgl = { RawScalarField, ColorMap, ContourFill, PlotLayer };
    });

    it('hatches only MLCIN values below -50 J/kg', () => {
        const product = instability.mlcin_lt50_hatched;
        const grid = { ni: 2, nj: 2 };
        const result = product.make_layers({ mlcin: { data: new Float32Array([-25, -50, -51, -100]) } }, grid);

        expect(product.data_keys).toEqual(['mlcin']);
        expect(result.layers).toHaveLength(1);
        expect(result.layers[0].id).toBe('mlcin_lt50_hatched');
        expect(contourFillCalls).toHaveLength(1);
        expect(contourFillCalls[0].options.patterns).toEqual([{
            range: [-Infinity, -50],
            type: 'hatch',
            color: '#6f42c1',
            opacity: 0.9,
            spacing: 9,
            width: 1.5,
            angle: 45,
        }]);
        expect(contourFillCalls[0].options.cmap.colors).toEqual(['#00000000']);
        expect(result.sampler(0, 0)).toEqual({ mlcin: -75 });
    });
});
