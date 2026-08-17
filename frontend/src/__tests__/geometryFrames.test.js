import { describe, expect, it } from 'vitest';

import {
    ensureGeometryDiagnostics,
    shareAdjacentGeometryData,
} from '../domain/geometryFrames.js';

function feature(id, coordinates = [[[-100, 35], [-99, 35], [-100, 35]]]) {
    return {
        type: 'Feature',
        properties: {canonical_key: id, phen: 'SV'},
        geometry: {type: 'Polygon', coordinates},
    };
}

describe('adjacent geometry frame sharing', () => {
    it('reuses identical features while preserving separate frame collections', () => {
        const first = {_all: {type: 'FeatureCollection', features: [feature('a')]}};
        const second = {_all: {type: 'FeatureCollection', features: [feature('a'), feature('b')]}};
        shareAdjacentGeometryData(null, first);
        shareAdjacentGeometryData(first, second);

        expect(second._all).not.toBe(first._all);
        expect(second._all.features[0]).toBe(first._all.features[0]);
        expect(second._all.features[1]).not.toBe(first._all.features[0]);
        expect(ensureGeometryDiagnostics(second)).toMatchObject({
            featureCount: 2,
            coordinateCount: 6,
            sharedFeatures: 1,
        });
        expect(ensureGeometryDiagnostics(second).sharedBytes).toBeGreaterThan(0);
    });

    it('does not reuse a revised geometry with the same alert identity', () => {
        const first = {_all: {type: 'FeatureCollection', features: [feature('a')]}};
        const revised = feature('a', [[[-100, 35], [-98, 35], [-100, 35]]]);
        const second = {_all: {type: 'FeatureCollection', features: [revised]}};
        shareAdjacentGeometryData(first, second);

        expect(second._all.features[0]).toBe(revised);
        expect(ensureGeometryDiagnostics(second).sharedFeatures).toBe(0);
    });
});
