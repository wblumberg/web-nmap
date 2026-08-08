import {describe, expect, it} from 'vitest';

import {
    polygonInteriorsOverlap,
    validateForecastProducts,
} from '../domain/forecastValidation.js';

const rectangle = (west, south, east, north) => [
    [west, south], [east, south], [east, north], [west, north], [west, south],
];

const contour = ({
    id,
    product = 'categorical',
    productLabel = 'Categorical Outlook',
    level,
    label,
    coords,
    role = 'level',
}) => ({
    id,
    kind: 'contour',
    suiteId: 'convective-outlook',
    forecastProductId: product,
    forecastProductLabel: productLabel,
    levelId: level,
    levelLabel: label,
    forecastRole: role,
    coords,
});

describe('polygon interior overlap', () => {
    it('detects intersecting and contained polygons', () => {
        expect(polygonInteriorsOverlap(
            rectangle(0, 0, 2, 2), rectangle(1, 1, 3, 3),
        )).toBe(true);
        expect(polygonInteriorsOverlap(
            rectangle(0, 0, 4, 4), rectangle(1, 1, 2, 2),
        )).toBe(true);
    });

    it('allows polygons to share a boundary without overlapping', () => {
        expect(polygonInteriorsOverlap(
            rectangle(0, 0, 1, 1), rectangle(1, 0, 2, 1),
        )).toBe(false);
    });

    it('handles concave polygons without treating their cutout as covered area', () => {
        const lShape = [
            [0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3], [0, 0],
        ];
        expect(polygonInteriorsOverlap(lShape, rectangle(1.5, 1.5, 2.5, 2.5))).toBe(false);
        expect(polygonInteriorsOverlap(lShape, rectangle(0.5, 1.5, 1.5, 2.5))).toBe(true);
    });
});

describe('forecast product validation', () => {
    it('keeps categorical levels mutually exclusive', () => {
        const issues = validateForecastProducts([
            contour({id: 1, level: 'marginal', label: 'Marginal', coords: rectangle(0, 0, 2, 2)}),
            contour({id: 2, level: 'slight', label: 'Slight', coords: rectangle(1, 1, 3, 3)}),
        ]);

        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({
            code: 'cross-level-overlap',
            productIds: [1, 2],
            message: 'Categorical Outlook: Marginal overlaps Slight.',
        });
    });

    it('requires tornado probabilities to be nested by threshold', () => {
        const issues = validateForecastProducts([
            contour({
                id: 1,
                product: 'tornado-probability',
                productLabel: 'Tornado Probability',
                level: 'p2',
                label: '2%',
                coords: rectangle(0, 0, 3, 3),
            }),
            contour({
                id: 2,
                product: 'tornado-probability',
                productLabel: 'Tornado Probability',
                level: 'p5',
                label: '5%',
                coords: rectangle(2, 2, 4, 4),
            }),
        ]);

        expect(issues.some(issue => issue.code === 'nested-level-violation')).toBe(true);
        expect(issues[0]?.message).toContain('5% must be contained within 2%');
    });

    it('allows nested tornado probabilities when fully contained', () => {
        const issues = validateForecastProducts([
            contour({
                id: 1,
                product: 'tornado-probability',
                productLabel: 'Tornado Probability',
                level: 'p2',
                label: '2%',
                coords: rectangle(0, 0, 4, 4),
            }),
            contour({
                id: 2,
                product: 'tornado-probability',
                productLabel: 'Tornado Probability',
                level: 'p5',
                label: '5%',
                coords: rectangle(1, 1, 2, 2),
            }),
        ]);

        expect(issues).toEqual([]);
    });

    it('reports redundant overlap at the same level', () => {
        const issues = validateForecastProducts([
            contour({id: 1, level: 'marginal', label: 'Marginal', coords: rectangle(0, 0, 2, 2)}),
            contour({id: 2, level: 'marginal', label: 'Marginal', coords: rectangle(1, 1, 3, 3)}),
        ]);
        expect(issues[0]?.code).toBe('same-level-overlap');
    });

    it('does not compare separate hazards or significant-weather overlays', () => {
        const sharedArea = rectangle(0, 0, 2, 2);
        const issues = validateForecastProducts([
            contour({id: 1, level: 'marginal', label: 'Marginal', coords: sharedArea}),
            contour({
                id: 2,
                product: 'tornado-probability',
                productLabel: 'Tornado Probability',
                level: 'p2',
                label: '2%',
                coords: sharedArea,
            }),
            contour({
                id: 3,
                product: 'tornado-probability',
                productLabel: 'Tornado Probability',
                level: 'significant-tornado',
                label: 'Significant Tornado',
                coords: sharedArea,
                role: 'overlay',
            }),
        ]);
        expect(issues).toEqual([]);
    });
});
