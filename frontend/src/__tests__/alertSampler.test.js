import {describe, expect, it} from 'vitest';

import {geometryContainsPoint} from '../domain/dataProducts/alerts.js';

describe('alert geometry sampling', () => {
    it('samples polygons while excluding holes', () => {
        const geometry = {
            type: 'Polygon',
            coordinates: [
                [[-100, 30], [-90, 30], [-90, 40], [-100, 40], [-100, 30]],
                [[-97, 33], [-93, 33], [-93, 37], [-97, 37], [-97, 33]],
            ],
        };
        expect(geometryContainsPoint(geometry, -99, 35)).toBe(true);
        expect(geometryContainsPoint(geometry, -95, 35)).toBe(false);
        expect(geometryContainsPoint(geometry, -80, 35)).toBe(false);
    });

    it('samples any polygon in a multipolygon', () => {
        const geometry = {
            type: 'MultiPolygon',
            coordinates: [
                [[[-100, 30], [-98, 30], [-98, 32], [-100, 32], [-100, 30]]],
                [[[-90, 40], [-88, 40], [-88, 42], [-90, 42], [-90, 40]]],
            ],
        };
        expect(geometryContainsPoint(geometry, -89, 41)).toBe(true);
        expect(geometryContainsPoint(geometry, -95, 35)).toBe(false);
    });
});
