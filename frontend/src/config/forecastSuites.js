// Declarative definitions for ProductGen forecast suites. These describe the
// meteorological meaning and default presentation of drawing tools; they do
// not contain rendering code or student-created geometry.

const PROBABILITY_COLORS = [
    '#147d26', '#543200', '#c6c600', '#e58a20', '#d52b2b',
    '#d12bd1', '#8c2be2', '#4545d8', '#22a5c7',
];

// 2% - 5% - 10% - 15% - 30% - 45% - 60%
const TORNADO_PROBABILITY_COLORS = [
    '#1A731D', '#7F3F27', '#FD8A2B', '#FF0000', '#FF00FF',
    '#912CED', '#0F4E8B',
];

// 5% - 15% - 30% - 45% - 60% - 75% - 90%
const WIND_PROBABILITY_COLORS = [
    '#1A731D', '#7F3F27', '#FF0000', '#FF00FF',
    '#912CED', '#0F4E8B', '#1BFFFF'
];

// 5% - 15% - 30% - 45% - 60%
 const HAIL_PROBABILITY_COLORS = [
    '#1A731D', '#7F3F27', '#FF0000', '#FF00FF',
    '#912CED', '#0F4E8B', '#1BFFFF'
];

function _probabilityLevels(values, colors) {
    return values.map((value, index) => ({
        id: `p${value}`,
        label: `${value}%`,
        value,
        color: colors[Math.min(index, colors.length - 1)],
    }));
}

function _amountLevels(values, colors) {
    return values.map((value, index) => ({
        id: `amount-${String(value).replace('.', '_')}`,
        label: `${value} in`,
        value,
        color: colors[index],
    }));
}

function _significantOverlay(id, label) {
    return {
        id, label, value: 'significant', color: '#000000',
        pattern: 'hatch', patternDensity: 2, patternWidth: 1.5,
        role: 'overlay',
    };
}

function _exclusiveAreaRules() {
    return {spatialMode: 'exclusive', preventSameLevelOverlap: true};
}

function _nestedThresholdRules() {
    return {requireNestedLevels: true, preventSameLevelOverlap: true};
}

function _nestedOrdinalRules() {
    return {spatialMode: 'nestedOrdinal', requireNestedLevels: true, preventSameLevelOverlap: true};
}

export const FORECAST_SUITE_DEFINITIONS = {
    'convective-outlook': {
        id: 'convective-outlook',
        version: 1,
        label: 'Convective Outlook',
        products: [
            {
                id: 'categorical', label: 'Categorical Outlook',
                valueType: 'category', units: null,
                rules: _nestedOrdinalRules(),
                levels: [
                    {id: 'general-thunder', label: 'General Thunder', value: 'TSTM', rank: 0, color: '#66a366'},
                    {id: 'marginal', label: 'Marginal', value: 'MRGL', rank: 1, color: '#147d26'},
                    {id: 'slight', label: 'Slight', value: 'SLGT', rank: 2, color: '#c6c600'},
                    {id: 'enhanced', label: 'Enhanced', value: 'ENH', rank: 3, color: '#e58a20'},
                    {id: 'moderate', label: 'Moderate', value: 'MDT', rank: 4, color: '#d52b2b'},
                    {id: 'high', label: 'High', value: 'HIGH', rank: 5, color: '#d12bd1'},
                ],
            },
            {
                id: 'tornado-probability', label: 'Tornado Probability',
                valueType: 'probability', units: '%',
                rules: _nestedThresholdRules(),
                levels: _probabilityLevels([2, 5, 10, 15, 30, 45, 60], TORNADO_PROBABILITY_COLORS),
                overlays: [_significantOverlay('significant-tornado', 'Significant Tornado')],
            },
            {
                id: 'wind-probability', label: 'Wind Probability',
                valueType: 'probability', units: '%',
                rules: _nestedThresholdRules(),
                levels: _probabilityLevels([5, 15, 30, 45, 60], WIND_PROBABILITY_COLORS),
                overlays: [_significantOverlay('significant-wind', 'Significant Wind')],
            },
            {
                id: 'hail-probability', label: 'Hail Probability',
                valueType: 'probability', units: '%',
                rules: _nestedThresholdRules(),
                levels: _probabilityLevels([5, 15, 30, 45, 60], HAIL_PROBABILITY_COLORS),
                overlays: [_significantOverlay('significant-hail', 'Significant Hail')],
            },
        ],
    },

    'precipitation-winter': {
        id: 'precipitation-winter',
        version: 1,
        label: 'Precipitation & Winter',
        products: [
            {
                id: 'weather-type', label: 'Weather Type',
                valueType: 'category', units: null,
                rules: _exclusiveAreaRules(),
                levels: [
                    {id: 'fog', label: 'Fog', value: 'FOG', color: '#a8a8a8'},
                    {id: 'rain', label: 'Rain', value: 'RAIN', color: '#36a852'},
                    {id: 'snow', label: 'Snow', value: 'SNOW', color: '#63b8ff'},
                    {id: 'mixed', label: 'Mixed Precipitation', value: 'MIX', color: '#c76de0'},
                    {id: 'freezing-rain', label: 'Freezing Rain', value: 'FZRA', color: '#f05bb5'},
                ],
            },
            {
                id: 'precipitation-probability', label: 'Probability of Precipitation',
                valueType: 'probability', units: '%',
                rules: _nestedThresholdRules(),
                levels: _probabilityLevels([10, 20, 30, 40, 50, 60, 70, 80, 90], PROBABILITY_COLORS),
            },
            {
                id: 'rain-amount', label: 'Rain Amount',
                valueType: 'amount', units: 'in',
                rules: _nestedThresholdRules(),
                levels: _amountLevels([0.1, 0.25, 0.5, 1, 2, 3, 5],
                    ['#b8e6b8', '#71cc71', '#29a329', '#f0e442', '#f39c34', '#dc3c3c', '#a933b0']),
            },
            {
                id: 'snow-amount', label: 'Snow Amount',
                valueType: 'amount', units: 'in',
                rules: _nestedThresholdRules(),
                levels: _amountLevels([1, 2, 4, 6, 8, 12, 18, 24],
                    ['#d9f2ff', '#a9ddf5', '#6dbfe8', '#328bc5', '#3156aa', '#7039a8', '#a12c86', '#d12757']),
            },
            {
                id: 'ice-amount', label: 'Ice Accumulation',
                valueType: 'amount', units: 'in',
                rules: _nestedThresholdRules(),
                levels: _amountLevels([0.01, 0.1, 0.25, 0.5, 0.75, 1],
                    ['#f1d9ff', '#d5a8ef', '#b876df', '#9750c7', '#7730a8', '#551b82']),
            },
        ],
    },
};

export function getForecastSuite(suiteId) {
    return FORECAST_SUITE_DEFINITIONS[suiteId] || null;
}

export function getForecastProduct(suiteId, productId) {
    return getForecastSuite(suiteId)?.products.find(product => product.id === productId) || null;
}

export function getForecastLevel(suiteId, productId, levelId) {
    const product = getForecastProduct(suiteId, productId);
    return [...(product?.levels || []), ...(product?.overlays || [])]
        .find(level => level.id === levelId) || null;
}
