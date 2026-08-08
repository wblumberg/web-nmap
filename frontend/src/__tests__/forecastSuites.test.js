import {describe, expect, it} from 'vitest';

import {
    FORECAST_SUITE_DEFINITIONS,
    getForecastSuite,
    getForecastProduct,
    getForecastLevel,
} from '../config/forecastSuites.js';

describe('forecast suite definitions', () => {
    it('provides two versioned prototype suites with unique product and level IDs', () => {
        expect(Object.keys(FORECAST_SUITE_DEFINITIONS)).toEqual([
            'convective-outlook',
            'precipitation-winter',
        ]);

        Object.values(FORECAST_SUITE_DEFINITIONS).forEach(suite => {
            expect(suite.version).toBe(1);
            expect(suite.products.length).toBeGreaterThan(0);
            expect(new Set(suite.products.map(product => product.id)).size).toBe(suite.products.length);
            suite.products.forEach(product => {
                expect(product.rules?.preventSameLevelOverlap).toBe(true);
                if (product.id === 'tornado-probability' ||
                    product.id === 'wind-probability' ||
                    product.id === 'hail-probability' ||
                    product.valueType === 'amount') {
                    expect(product.rules?.requireNestedLevels).toBe(true);
                } else {
                    expect(product.rules?.spatialMode).toBe('exclusive');
                }
                const levels = [...(product.levels || []), ...(product.overlays || [])];
                expect(levels.length).toBeGreaterThan(0);
                expect(new Set(levels.map(level => level.id)).size).toBe(levels.length);
                levels.forEach(level => expect(level.color).toMatch(/^#[0-9a-f]{6}$/i));
            });
        });
    });

    it('resolves configured products, levels, and patterned overlays', () => {
        expect(getForecastSuite('convective-outlook')?.label).toBe('Convective Outlook');
        expect(getForecastProduct('convective-outlook', 'hail-probability')?.units).toBe('%');

        const significantHail = getForecastLevel(
            'convective-outlook',
            'hail-probability',
            'significant-hail',
        );
        expect(significantHail).toMatchObject({
            role: 'overlay',
            pattern: 'hatch',
            patternDensity: 2,
        });
    });

    it('returns null for unknown suite components', () => {
        expect(getForecastSuite('missing')).toBeNull();
        expect(getForecastProduct('convective-outlook', 'missing')).toBeNull();
        expect(getForecastLevel('convective-outlook', 'hail-probability', 'missing')).toBeNull();
    });
});
