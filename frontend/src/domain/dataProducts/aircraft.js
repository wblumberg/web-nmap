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
const MAX_CALLSIGN_LABELS = 150;

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

function _makeSampler(component) {
    return (lon, lat) => {
        const hits = component?.queryPoint?.(lon, lat) || [];
        if (!hits.length) return null;
        return {
            Flights: hits.map(hit => {
                const p = hit.properties || {};
                const route = [p.departure_airport, p.arrival_airport]
                    .filter(Boolean).join('→');
                return [p.acid || p.flight_ref, route].filter(Boolean).join(' ');
            }).join(' | '),
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
    const markerCoordinates = [];
    const markerLabels = [];
    const markerValues = [];
    const unmeasuredMarkerCoordinates = [];
    const unmeasuredMarkerLabels = [];

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
        if (showUnmeasuredBase) {
            lineFeatures.push({
                geometry,
                properties,
                style: {
                    line_color: '#94a3b8',
                    line_width: 1.5,
                    line_opacity: 0.55,
                    line_style: '-',
                },
            });
        }
        const runs = _measuredLineRuns(geometry.coordinates, values);
        for (const run of runs) {
            lineFeatures.push({
                geometry: { type: 'LineString', coordinates: run.coordinates },
                properties,
                data: run.values,
                style: {
                    line_cmap: cmap,
                    line_width: 2.5,
                    line_opacity: 0.85,
                    line_style: '-',
                },
            });
        }

        if (properties.is_latest_segment !== false) {
            const lastIndex = geometry.coordinates.length - 1;
            if (values[lastIndex] !== null) {
                markerCoordinates.push(geometry.coordinates[lastIndex]);
                markerLabels.push(properties.acid || properties.flight_ref || '?');
                markerValues.push(values[lastIndex]);
            } else if (showUnmeasuredBase) {
                unmeasuredMarkerCoordinates.push(geometry.coordinates[lastIndex]);
                unmeasuredMarkerLabels.push(
                    properties.acid || properties.flight_ref || '?'
                );
            }
        }
    }

    if (markerCoordinates.length) {
        lineFeatures.push({
            geometry: { type: 'MultiPoint', coordinates: markerCoordinates },
            text: markerCoordinates.map(() => '●'),
            data: markerValues,
            style: {
                text_cmap: cmap,
                text_halo: true,
                text_halo_color: '#020617',
                text_font_size: 14,
            },
        });

        // Preserve every current-position dot, but label only an evenly spaced
        // subset. Hundreds of overlapping callsigns obscure both tracks and
        // underlying weather layers at national zoom levels.
        const labelCount = Math.min(MAX_CALLSIGN_LABELS, markerCoordinates.length);
        const labelIndexes = Array.from({ length: labelCount }, (_, i) => (
            Math.floor(i * markerCoordinates.length / labelCount)
        ));
        lineFeatures.push({
            geometry: {
                type: 'MultiPoint',
                coordinates: labelIndexes.map(i => markerCoordinates[i]),
            },
            text: labelIndexes.map(i => markerLabels[i]),
            data: labelIndexes.map(i => markerValues[i]),
            style: {
                text_color: '#f8fafc',
                text_halo: true,
                text_halo_color: '#020617',
                text_font_size: 10,
            },
        });
    }
    if (unmeasuredMarkerCoordinates.length) {
        lineFeatures.push({
            geometry: {
                type: 'MultiPoint',
                coordinates: unmeasuredMarkerCoordinates,
            },
            text: unmeasuredMarkerCoordinates.map(() => '●'),
            data: unmeasuredMarkerCoordinates.map(() => 1),
            style: {
                text_color: '#94a3b8',
                text_halo: true,
                text_halo_color: '#020617',
                text_font_size: 14,
            },
        });

        const remainingLabelBudget = Math.max(
            0,
            MAX_CALLSIGN_LABELS - Math.min(MAX_CALLSIGN_LABELS, markerCoordinates.length)
        );
        const labelCount = Math.min(
            remainingLabelBudget, unmeasuredMarkerCoordinates.length
        );
        const labelIndexes = Array.from({ length: labelCount }, (_, i) => (
            Math.floor(i * unmeasuredMarkerCoordinates.length / labelCount)
        ));
        if (labelIndexes.length) lineFeatures.push({
            geometry: {
                type: 'MultiPoint',
                coordinates: labelIndexes.map(
                    i => unmeasuredMarkerCoordinates[i]
                ),
            },
            text: labelIndexes.map(i => unmeasuredMarkerLabels[i]),
            data: labelIndexes.map(() => 1),
            style: {
                text_color: '#cbd5e1',
                text_halo: true,
                text_halo_color: '#020617',
                text_font_size: 10,
            },
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
        sampler: _makeSampler(component),
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
