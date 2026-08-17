import { describe, expect, it } from 'vitest';

import { hasFiniteValues } from '../domain/dataProducts/utils.js';

describe('hasFiniteValues', () => {
    it('rejects absent, empty, and entirely missing arrays', () => {
        expect(hasFiniteValues(null)).toBe(false);
        expect(hasFiniteValues(new Float32Array())).toBe(false);
        expect(hasFiniteValues(new Float32Array([NaN, NaN]))).toBe(false);
        expect(hasFiniteValues([NaN, Infinity, -Infinity])).toBe(false);
    });

    it('accepts a field as soon as it contains a finite value', () => {
        expect(hasFiniteValues(new Float32Array([NaN, 0, NaN]))).toBe(true);
        expect(hasFiniteValues([NaN, -12.5])).toBe(true);
    });
});
