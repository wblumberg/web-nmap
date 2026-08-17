import {describe, expect, it} from 'vitest';
import {RawScalarField} from 'autumnplot-gl';

describe('packed-field GPU expressions', () => {
    it('preserves repeated sampler references through nested computations', () => {
        const grid = {ni: 1, nj: 1};
        const field = new RawScalarField(grid, new Uint8Array([42]))
            .dequantize(0.5, 150, 255)
            .subtract(273.15);

        expect(field.getSamplerIds()).toEqual(['_0aa']);
        const expression = field.getExpression();
        expect(expression.match(/_0aa/g)).toHaveLength(2);
        expect(expression).not.toMatch(/_0aaa|\b_0a\b/);
    });
});
