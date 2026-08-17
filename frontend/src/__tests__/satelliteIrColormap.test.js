import {describe, expect, it} from 'vitest';
import COLORMAPS from '../config/colormaps.js';

describe('satellite IR colormap', () => {
    it('uses ascending Celsius levels required by rendering and colorbars', () => {
        const levels = COLORMAPS.satellite_ir_winter.levels;
        expect(levels[0]).toBeLessThan(levels.at(-1));
        expect(levels.every((level, index) => index === 0 || level > levels[index - 1])).toBe(true);
    });
});
