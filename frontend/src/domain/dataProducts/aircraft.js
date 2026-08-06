import * as apgl from 'autumnplot-gl';

const ALTITUDE_LEVELS = [0, 5000, 10000, 18000, 25000, 32000, 38000, 45000];
const ALTITUDE_COLORS = [
    '#6ee7b7', '#22d3ee', '#60a5fa', '#818cf8',
    '#a78bfa', '#e879f9', '#fb7185',
];
const SPEED_LEVELS = [0, 100, 200, 300, 400, 500, 600];
const SPEED_COLORS = [
    '#dbeafe', '#7dd3fc', '#34d399', '#facc15', '#fb923c', '#ef4444',
];
const ALTITUDE_CMAP = new apgl.ColorMap(
    ALTITUDE_LEVELS,
    ALTITUDE_COLORS,
    {
        underflow_color: ALTITUDE_COLORS[0],
        overflow_color: ALTITUDE_COLORS[ALTITUDE_COLORS.length - 1],
    },
);
const SPEED_CMAP = new apgl.ColorMap(
    SPEED_LEVELS,
    SPEED_COLORS,
    {
        underflow_color: SPEED_COLORS[0],
        overflow_color: SPEED_COLORS[SPEED_COLORS.length - 1],
    },
);

function _featureCollection(data) {
    return data?._all || { type: 'FeatureCollection', features: [] };
}

function _numericArray(values, length) {
    return Array.from({ length }, (_, index) => {
        const raw = values?.[index];
        if (raw === null || raw === undefined || raw === '') return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    });
}

function _measuredLineRuns(coordinates, values) {
    const runs = [];
    let coordinatesRun = [];
    let valuesRun = [];
    const flush = () => {
        if (coordinatesRun.length >= 2) {
            runs.push({ coordinates: coordinatesRun, values: valuesRun });
        }
        coordinatesRun = [];
        valuesRun = [];
    };
    coordinates.forEach((coordinate, index) => {
        if (values[index] === null) {
            flush();
            return;
        }
        coordinatesRun.push(coordinate);
        valuesRun.push(values[index]);
    });
    flush();
    return runs;
}

function _mercatorPoint(lon, lat) {
    const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat));
    const radians = clampedLat * Math.PI / 180;
    return [
        (lon + 180) / 360,
        (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2,
    ];
}

function _distanceToSegmentSquared(point, start, end) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    if (dx === 0 && dy === 0) {
        return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2;
    }
    const t = Math.max(0, Math.min(1,
        ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) /
        (dx * dx + dy * dy)
    ));
    const nearestX = start[0] + t * dx;
    const nearestY = start[1] + t * dy;
    return (point[0] - nearestX) ** 2 + (point[1] - nearestY) ** 2;
}

function _makeSampler(features) {
    const tracks = features
        .filter(feature => feature.geometry?.type === 'LineString')
        .map(feature => ({
            properties: feature.properties || {},
            coordinates: feature.geometry.coordinates.map(
                ([lon, lat]) => _mercatorPoint(lon, lat)
            ),
        }));

    return (lon, lat, context = {}) => {
        const point = _mercatorPoint(lon, lat);
        const zoom = Number.isFinite(context.zoom) ? context.zoom : 4;
        // MapLibre uses 512-pixel tiles. An eight-pixel hit radius makes thin
        // tracks practical to hover without selecting distant flights.
        const tolerance = 8 / (512 * (2 ** zoom));
        const toleranceSquared = tolerance ** 2;
        const hits = tracks.filter(track => {
            for (let i = 1; i < track.coordinates.length; i++) {
                if (_distanceToSegmentSquared(
                    point, track.coordinates[i - 1], track.coordinates[i]
                ) <= toleranceSquared) return true;
            }
            return false;
        });
        if (!hits.length) return null;
        const flights = new Map();
        for (const hit of hits) {
            const p = hit.properties || {};
            const callsign = p.acid || p.flight_ref || 'Unknown flight';
            const departure = p.departure_airport || '?';
            const arrival = p.arrival_airport || '?';
            flights.set(
                p.flight_ref || `${callsign}:${departure}:${arrival}`,
                `${callsign} (${departure} → ${arrival})`,
            );
        }
        return {
            Flights: [...flights.values()].join(' | '),
        };
    };
}

function _buildTracks(layerId, data, {
    valueKey,
    cmap,
    colorbarLabel,
    ticks,
    showUnmeasuredBase = false,
}) {
    const fc = _featureCollection(data);
    const lineFeatures = [];
    let totalPositions = 0;
    let measuredPositions = 0;
    let measuredRuns = 0;
    let flightsWithMeasurements = 0;

    for (const feature of fc.features || []) {
        const geometry = feature?.geometry;
        const properties = feature?.properties || {};
        if (geometry?.type !== 'LineString' || geometry.coordinates.length < 2) {
            continue;
        }
        const values = _numericArray(
            properties[valueKey],
            geometry.coordinates.length,
        );
        totalPositions += values.length;
        const featureMeasuredPositions = values.reduce(
            (count, value) => count + (value === null ? 0 : 1),
            0,
        );
        measuredPositions += featureMeasuredPositions;
        if (featureMeasuredPositions) flightsWithMeasurements++;
        if (showUnmeasuredBase) {
            lineFeatures.push({
                geometry,
                properties,
                style: {
                    line_color: '#94a3b8',
                    line_width: 0.9,
                    line_opacity: 0.55,
                    line_style: '-',
                },
            });
        }
        const runs = _measuredLineRuns(geometry.coordinates, values);
        measuredRuns += runs.length;
        for (const run of runs) {
            lineFeatures.push({
                geometry: { type: 'LineString', coordinates: run.coordinates },
                properties,
                data: run.values,
                style: {
                    line_cmap: cmap,
                    line_width: 1.5,
                    line_opacity: 0.85,
                    line_style: '-',
                },
            });
        }

    }

    if (valueKey === 'altitude_ft_array') {
        console.info('[NMAP aviation] Reported-altitude coverage', {
            trackSegments: (fc.features || []).length,
            totalPositions,
            measuredPositions,
            measuredPercent: totalPositions
                ? +(100 * measuredPositions / totalPositions).toFixed(1)
                : 0,
            trackSegmentsWithMeasurements: flightsWithMeasurements,
            drawableMeasuredRuns: measuredRuns,
        });
    }

    // Progressive animation requires every frame to return the same number of
    // layers. An empty FeatureCollection is a valid no-op GeometryComponent;
    // returning zero layers here would make a later non-empty frame address a
    // MultiPlotLayer that was never created from the first frame.
    const component = new apgl.GeometryComponent(lineFeatures);
    return {
        layers: [new apgl.PlotLayer(layerId, component)],
        colorbar: [apgl.makeColorBar(cmap, {
            label: colorbarLabel,
            fontface: 'Trebuchet MS',
            ticks,
            orientation: 'horizontal',
            tick_direction: 'bottom',
        })],
        sampler: _makeSampler(lineFeatures),
    };
}

export default {
    faa_tracks_altitude: {
        label: 'FAA Tracks by Reported Altitude + Unmeasured',
        group: 'misc',
        available_for: ['FAA_ASDI'],
        data_keys: ['_all'],
        default_query_params: {
            window_minutes: 30,
            operation: 'both',
            carriers: 'major',
        },
        make_layers(data, _grid) {
            return _buildTracks('faa_tracks_altitude', data, {
                valueKey: 'altitude_ft_array',
                cmap: ALTITUDE_CMAP,
                colorbarLabel: 'FAA Reported Altitude (ft)',
                ticks: ALTITUDE_LEVELS,
                showUnmeasuredBase: true,
            });
        },
    },

    faa_tracks_altitude_measured_only: {
        label: 'FAA Tracks by Reported Altitude (Measured Only)',
        group: 'misc',
        available_for: ['FAA_ASDI'],
        data_keys: ['_all'],
        default_query_params: {
            window_minutes: 30,
            operation: 'both',
            carriers: 'major',
        },
        make_layers(data, _grid) {
            return _buildTracks('faa_tracks_altitude_measured_only', data, {
                valueKey: 'altitude_ft_array',
                cmap: ALTITUDE_CMAP,
                colorbarLabel: 'FAA Reported Altitude (ft)',
                ticks: ALTITUDE_LEVELS,
                showUnmeasuredBase: false,
            });
        },
    },

    faa_tracks_speed: {
        label: 'FAA Flight Tracks by Ground Speed',
        group: 'misc',
        available_for: ['FAA_ASDI'],
        data_keys: ['_all'],
        default_query_params: {
            window_minutes: 30,
            operation: 'both',
            carriers: 'major',
        },
        make_layers(data, _grid) {
            return _buildTracks('faa_tracks_speed', data, {
                valueKey: 'ground_speed_kt_array',
                cmap: SPEED_CMAP,
                colorbarLabel: 'FAA Aircraft Ground Speed (kt)',
                ticks: SPEED_LEVELS,
            });
        },
    },
};
