import * as apgl from 'autumnplot-gl';

const MODEL_COLORS = {
    OFCL: '#f97316',
    HWRF: '#38bdf8',
    HMON: '#22c55e',
    AVNO: '#facc15',
    AEMN: '#a78bfa',
    TVCN: '#f472b6',
    CTCX: '#34d399',
    UKXI: '#93c5fd',
    __default__: '#e2e8f0',
};

const INTENSITY_LEVELS = [34, 64, 83, 96, 113, 137, 170];
const INTENSITY_COLORS = ['#7dd3fc', '#22c55e', '#facc15', '#fb923c', '#ef4444', '#a855f7'];

function _isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function _modelColor(model) {
    if (!model) return MODEL_COLORS.__default__;
    return MODEL_COLORS[String(model).toUpperCase()] || MODEL_COLORS.__default__;
}

function _intensityColor(maxWindKt) {
    if (!_isNum(maxWindKt)) return '#cbd5e1';
    for (let i = 0; i < INTENSITY_LEVELS.length - 1; i++) {
        const lo = INTENSITY_LEVELS[i];
        const hi = INTENSITY_LEVELS[i + 1];
        if (maxWindKt >= lo && maxWindKt < hi) return INTENSITY_COLORS[i];
    }
    return INTENSITY_COLORS[INTENSITY_COLORS.length - 1];
}

function _trackModelLabel(props) {
    return (props?.model || '?').toString().toUpperCase().trim();
}

function _trackStormLabel(props) {
    const name = (props?.storm_name || '').toString().trim();
    // Fall back to storm_id but strip basin code prefix (e.g. 'AL02' → keep as-is only if no name)
    return (name && name.toUpperCase() !== 'INVEST') ? name : (props?.storm_id || '?').toString().trim();
}

function _makeSampler(comp) {
    return function _atcfSampler(lon, lat) {
        if (!comp?.queryPoint) return null;
        const hits = comp.queryPoint(lon, lat);
        if (!hits?.length) return null;

        const labels = hits.map((f) => {
            const p = f.properties || {};
            const storm = p.storm_name || p.storm_id || '?';
            const model = p.model || '?';
            const fhr = _isNum(p.fhr) ? `F${String(p.fhr).padStart(3, '0')}` : '';
            const vmax = _isNum(p.max_wind_kt) ? `${Math.round(p.max_wind_kt)}kt` : '';
            const mslp = _isNum(p.min_pressure_mb) ? `${Math.round(p.min_pressure_mb)}mb` : '';
            return [storm, model, fhr, vmax, mslp].filter(Boolean).join(' ');
        });

        return { Cyclone: labels.join(' | ') };
    };
}

function _asFeatureCollection(data) {
    return data?._all || { type: 'FeatureCollection', features: [] };
}

// Colormap shared for intensity-by-vertex track rendering
const INTENSITY_CMAP = new apgl.ColorMap(
    INTENSITY_LEVELS,
    INTENSITY_COLORS,
    { underflow_color: INTENSITY_COLORS[0], overflow_color: INTENSITY_COLORS[INTENSITY_COLORS.length - 1] },
);

function _toTrackGeomFeatures(fc, opts = {}) {
    if (!fc?.features?.length) return [];
    const colorBy = opts.colorBy || 'model';

    return fc.features.flatMap((f) => {
        const g = f?.geometry;
        const p = f?.properties || {};
        if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return [];

        const widthBase = _isNum(p.max_wind_kt) ? Math.max(1.5, Math.min(4.5, 1.5 + (p.max_wind_kt / 70))) : 2;

        if (colorBy === 'intensity' && Array.isArray(p.wind_kt_array) && p.wind_kt_array.length > 0) {
            // Per-vertex intensity coloring using the per-forecast-hour wind speeds
            const vertexData = p.wind_kt_array.map(v => (_isNum(v) ? v : 0));
            return [{
                geometry: g,
                properties: p,
                data: vertexData,
                style: {
                    line_cmap: INTENSITY_CMAP,
                    line_width: widthBase,
                    line_opacity: 0.95,
                    line_style: '-',
                },
            }];
        }

        const color = colorBy === 'intensity'
            ? _intensityColor(p.max_wind_kt)
            : _modelColor(p.model);

        return [{
            geometry: g,
            properties: p,
            style: {
                line_color: color,
                line_width: widthBase,
                line_opacity: 0.95,
                line_style: '-',
            },
        }];
    });
}

function _extractLineStartCoordinate(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'LineString') {
        return Array.isArray(geometry.coordinates) && geometry.coordinates.length ? geometry.coordinates[0] : null;
    }
    if (geometry.type === 'MultiLineString') {
        const firstLine = Array.isArray(geometry.coordinates) && geometry.coordinates.length ? geometry.coordinates[0] : null;
        return Array.isArray(firstLine) && firstLine.length ? firstLine[0] : null;
    }
    return null;
}

function _extractLineEndCoordinate(geometry) {
    if (!geometry) return null;
    if (geometry.type === 'LineString') {
        const c = geometry.coordinates;
        return Array.isArray(c) && c.length ? c[c.length - 1] : null;
    }
    if (geometry.type === 'MultiLineString') {
        const lines = geometry.coordinates;
        if (!Array.isArray(lines) || !lines.length) return null;
        const lastLine = lines[lines.length - 1];
        return Array.isArray(lastLine) && lastLine.length ? lastLine[lastLine.length - 1] : null;
    }
    return null;
}

function _toTrackLabelFeatures(fc) {
    if (!fc?.features?.length) return [];

    const startPts = [], startLabels = [];
    const endPts = [], endLabels = [];

    for (const f of fc.features) {
        const g = f?.geometry;
        const p = f?.properties || {};

        const startCoord = _extractLineStartCoordinate(g);
        if (startCoord?.length >= 2) {
            startPts.push([startCoord[0], startCoord[1]]);
            startLabels.push(_trackStormLabel(p));
        }

        const endCoord = _extractLineEndCoordinate(g);
        if (endCoord?.length >= 2) {
            endPts.push([endCoord[0], endCoord[1]]);
            endLabels.push(_trackModelLabel(p));
        }
    }

    const features = [];
    if (startPts.length) {
        features.push({
            geometry: { type: 'MultiPoint', coordinates: startPts },
            text: startLabels,
            data: startLabels.map(() => 1),
            style: {
                text_color: '#fde68a',
                text_halo: true,
                text_halo_color: '#020617',
                text_font_size: 13,
            },
        });
    }
    if (endPts.length) {
        features.push({
            geometry: { type: 'MultiPoint', coordinates: endPts },
            text: endLabels,
            data: endLabels.map(() => 1),
            style: {
                text_color: '#f8fafc',
                text_halo: true,
                text_halo_color: '#020617',
                text_font_size: 11,
            },
        });
    }
    return features;
}

function _toForecastPointFeature(fc) {
    if (!fc?.features?.length) return [];

    const coords = [];
    const labels = [];
    const winds = [];

    for (const f of fc.features) {
        const g = f?.geometry;
        const p = f?.properties || {};
        if (!g || g.type !== 'Point') continue;
        const c = g.coordinates;
        if (!Array.isArray(c) || c.length < 2) continue;

        coords.push([c[0], c[1]]);
        labels.push(_trackLabel(p));
        winds.push(_isNum(p.max_wind_kt) ? p.max_wind_kt : 0);
    }

    if (!coords.length) return [];

    const windCmap = new apgl.ColorMap(
        INTENSITY_LEVELS,
        INTENSITY_COLORS,
        { underflow_color: INTENSITY_COLORS[0], overflow_color: INTENSITY_COLORS[INTENSITY_COLORS.length - 1] },
    );

    const markerFeature = {
        geometry: { type: 'MultiPoint', coordinates: coords },
        text: labels.map(() => '●'),
        data: winds,
        style: {
            text_cmap: windCmap,
            text_halo: true,
            text_halo_color: '#020617',
            text_font_size: 15,
        },
    };

    const labelFeature = {
        geometry: { type: 'MultiPoint', coordinates: coords },
        text: labels,
        data: labels.map(() => 1),
        style: {
            text_color: '#f8fafc',
            text_halo: true,
            text_halo_color: '#020617',
            text_font_size: 11,
        },
    };

    return {
        features: [markerFeature, labelFeature],
        colorbar: [
            apgl.makeColorBar(windCmap, {
                label: 'ATCF Max Wind (kt)',
                fontface: 'Trebuchet MS',
                ticks: INTENSITY_LEVELS,
                orientation: 'horizontal',
                tick_direction: 'bottom',
            }),
        ],
    };
}

function _makeTrackLayers(layerId, data, opts = {}) {
    const fc = _asFeatureCollection(data);
    const lineFeatures = _toTrackGeomFeatures(fc, opts);
    const labelFeatures = opts.labels ? _toTrackLabelFeatures(fc) : [];
    const geomComp = new apgl.GeometryComponent([...lineFeatures, ...labelFeatures]);

    return {
        layers: [new apgl.PlotLayer(layerId, geomComp)],
        colorbar: [],
        sampler: _makeSampler(geomComp),
    };
}

function _toBestTrackGeomFeatures(fc) {
    if (!fc?.features?.length) return [];
    return fc.features.flatMap((f) => {
        const g = f?.geometry;
        if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return [];
        return [{
            geometry: g,
            properties: f?.properties || {},
            style: {
                line_color: '#ffffff',
                line_width: 3.5,
                line_opacity: 1.0,
                line_style: '--',
            },
        }];
    });
}

function _makeBestTrackLayers(layerId, data) {
    const fc = _asFeatureCollection(data);
    const lineFeatures = _toBestTrackGeomFeatures(fc);
    const labelFeatures = _toTrackLabelFeatures(fc);
    const geomComp = new apgl.GeometryComponent([...lineFeatures, ...labelFeatures]);
    return {
        layers: [new apgl.PlotLayer(layerId, geomComp)],
        colorbar: [],
        sampler: _makeSampler(geomComp),
    };
}

function _makePointLayers(layerId, data) {
    const fc = _asFeatureCollection(data);
    const built = _toForecastPointFeature(fc);
    if (!built.length && !built.features) {
        return { layers: [], colorbar: [], sampler: null };
    }

    const geomComp = new apgl.GeometryComponent(built.features);
    return {
        layers: [new apgl.PlotLayer(layerId, geomComp)],
        colorbar: built.colorbar || [],
        sampler: _makeSampler(geomComp),
    };
}

export default {
    atcf_tracks_all_models: {
        label: 'ATCF Tracks (All Forecast Models)',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'cycle',
        data_keys: ['_all'],
        // exclude_best filters out the BEST track so only forecast models show
        default_query_params: { exclude_best: true },

        make_layers(data, _grid) {
            return _makeTrackLayers('atcf_tracks_all_models', data, {
                colorBy: 'model',
                labels: true,
            });
        },
    },

    atcf_tracks_best: {
        label: 'ATCF Best Track',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'cycle',
        data_keys: ['_all'],
        default_query_params: { model: 'BEST' },

        make_layers(data, _grid) {
            return _makeBestTrackLayers('atcf_tracks_best', data);
        },
    },

    atcf_tracks_ofcl: {
        label: 'ATCF Tracks (OFCL)',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'cycle',
        data_keys: ['_all'],
        default_query_params: { model: 'OFCL' },

        make_layers(data, _grid) {
            return _makeTrackLayers('atcf_tracks_ofcl', data, {
                colorBy: 'intensity',
                labels: true,
            });
        },
    },

    atcf_tracks_hwrf: {
        label: 'ATCF Tracks (HWRF)',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'cycle',
        data_keys: ['_all'],
        default_query_params: { model: 'HWRF' },

        make_layers(data, _grid) {
            return _makeTrackLayers('atcf_tracks_hwrf', data, {
                colorBy: 'intensity',
                labels: true,
            });
        },
    },

    atcf_tracks_gefs: {
        label: 'ATCF Tracks (GEFS Ensemble)',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'cycle',
        data_keys: ['_all'],
        // AP00–AP30 are the 30 GEFS ensemble members in ATCF
        default_query_params: { model_prefix: 'AP' },

        make_layers(data, _grid) {
            return _makeTrackLayers('atcf_tracks_gefs', data, {
                colorBy: 'model',
                labels: false,
            });
        },
    },

    atcf_points_f024: {
        label: 'ATCF Forecast Points',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'fhr',
        data_keys: ['_all'],

        make_layers(data, _grid) {
            return _makePointLayers('atcf_points_f024', data);
        },
    },

    atcf_points_f048: {
        label: 'ATCF Forecast Points (OFCL)',
        group: 'storm_attributes',
        available_for: ['ATCF_TRACKS'],
        frame_mode: 'fhr',
        data_keys: ['_all'],
        default_query_params: { model: 'OFCL' },

        make_layers(data, _grid) {
            return _makePointLayers('atcf_points_f048', data);
        },
    },
};
