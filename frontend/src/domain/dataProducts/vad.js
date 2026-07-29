import * as apgl from 'autumnplot-gl';

const MS_TO_KT = 1.94384449;

function _isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function _windFromUV(u, v) {
    if (!_isNum(u) || !_isNum(v)) return [null, null];
    const speedKt = Math.sqrt((u * u) + (v * v)) * MS_TO_KT;
    const dirDeg = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    return [speedKt, dirDeg];
}

function _normalizeAltitudeKm(altVals) {
    const valid = (altVals || []).filter(_isNum);
    if (!valid.length) return [];
    const maxAbs = Math.max(...valid.map((v) => Math.abs(v)));
    const metersLike = maxAbs > 80;
    return valid.map((z) => (metersLike ? z / 1000.0 : z));
}

function _firstValidWind(profileVars) {
    const uVals = profileVars?.u_wind?.values || [];
    const vVals = profileVars?.v_wind?.values || [];
    const n = Math.min(uVals.length, vVals.length);
    for (let i = 0; i < n; i++) {
        const u = uVals[i];
        const v = vVals[i];
        if (_isNum(u) && _isNum(v)) return _windFromUV(u, v);
    }
    return [null, null];
}

function _interpolateAtHeight(profileVars, targetKmMsl) {
    const altVals = profileVars?.altitude?.values || [];
    const altKmVals = _normalizeAltitudeKm(altVals);
    const uVals = profileVars?.u_wind?.values || [];
    const vVals = profileVars?.v_wind?.values || [];
    const n = Math.min(altKmVals.length, uVals.length, vVals.length);
    if (n < 1) return [null, null];

    const points = [];
    for (let i = 0; i < n; i++) {
        const z = altKmVals[i];
        const u = uVals[i];
        const v = vVals[i];
        if (!_isNum(z) || !_isNum(u) || !_isNum(v)) continue;
        points.push({ z, u, v });
    }
    if (!points.length) return [null, null];

    points.sort((a, b) => a.z - b.z);

    if (targetKmMsl <= points[0].z) return [points[0].u, points[0].v];
    if (targetKmMsl >= points[points.length - 1].z) {
        const p = points[points.length - 1];
        return [p.u, p.v];
    }

    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        if (targetKmMsl < p0.z || targetKmMsl > p1.z) continue;
        const dz = p1.z - p0.z;
        if (dz <= 0) return [p0.u, p0.v];
        const t = (targetKmMsl - p0.z) / dz;
        const u = p0.u + t * (p1.u - p0.u);
        const v = p0.v + t * (p1.v - p0.v);
        return [u, v];
    }

    return [null, null];
}

function _buildObsLayer(layerId, obsJson, spConfig, opts = {}) {
    const {
        thin_fac = 8,
        font_size = 14,
        font_face = 'Trebuchet MS',
        font_url_template = 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
    } = opts;

    const grid = new apgl.UnstructuredGrid(obsJson.map((o) => o.coord));
    const field = new apgl.RawObsField(grid, obsJson.map((o) => o.data));
    const plot = new apgl.StationPlot(field, {
        config: spConfig,
        thin_fac,
        font_size,
        font_face,
        font_url_template,
    });

    return new apgl.PlotLayer(layerId, plot);
}

function _toObsJson(data) {
    return (data?.obs_json || []).map((o) => {
        const d = { ...(o.data || {}) };
        const profileVars = d?.profile?.variables || {};
        d.wind = _firstValidWind(profileVars);
        return {
            coord: o.coord,
            valid_time: o.valid_time,
            data: d,
        };
    });
}

function _toObsJsonAtLevel(data, targetMetersAgl) {
    const targetKmAgl = targetMetersAgl / 1000.0;
    return (data?.obs_json || []).map((o) => {
        const d = { ...(o.data || {}) };
        const profileVars = d?.profile?.variables || {};
        const stationElevM = _isNum(d?.station_elevation_m) ? d.station_elevation_m : 0;
        const stationElevKm = stationElevM / 1000.0;
        const targetKmMsl = stationElevKm + targetKmAgl;
        const [u, v] = _interpolateAtHeight(profileVars, targetKmMsl);
        d.wind = _windFromUV(u, v);
        d.vad_level_m_agl = targetMetersAgl;
        return {
            coord: o.coord,
            valid_time: o.valid_time,
            data: d,
        };
    });
}

function _toHodographField(data, opts = {}) {
    const maxLevels = Number.isFinite(opts.maxLevels) ? Math.max(2, opts.maxLevels) : 30;
    const obs = data?.obs_json || [];
    const coords = [];
    const profiles = [];

    for (const o of obs) {
        const lon = o?.coord?.lon;
        const lat = o?.coord?.lat;
        const profileVars = o?.data?.profile?.variables || {};
        if (!_isNum(lon) || !_isNum(lat)) continue;

        const zVals = profileVars?.altitude?.values || [];
        const zKmVals = _normalizeAltitudeKm(zVals);
        const uVals = profileVars?.u_wind?.values || [];
        const vVals = profileVars?.v_wind?.values || [];
        const n = Math.min(zKmVals.length, uVals.length, vVals.length, maxLevels);

        const zipped = [];
        for (let i = 0; i < n; i++) {
            const z = zKmVals[i];
            const u = uVals[i];
            const v = vVals[i];
            if (!_isNum(z) || !_isNum(u) || !_isNum(v)) continue;
            zipped.push({ z, u, v });
        }

        if (zipped.length < 2) continue;
        zipped.sort((a, b) => a.z - b.z);

        coords.push({ lon, lat });
        profiles.push({
            ilon: profiles.length,
            jlat: 0,
            z: new Float32Array(zipped.map((p) => p.z)),
            u: new Float32Array(zipped.map((p) => p.u * MS_TO_KT)),
            v: new Float32Array(zipped.map((p) => p.v * MS_TO_KT)),
        });
    }

    if (!profiles.length) return null;

    const grid = new apgl.UnstructuredGrid(coords);
    return new apgl.RawProfileField(grid, profiles);
}

export default {
    vad_profile_barbs: {
        label: 'VAD Profile Barbs',
        group: 'point',
        available_for: ['VAD_PROFILE'],
        data_keys: ['profile', 'station_id'],

        make_layers(data, _grid) {
            const obsJson = _toObsJson(data);
            const layer = _buildObsLayer(
                'vad_profile_barbs',
                obsJson,
                {
                    station_id: {
                        type: 'string', pos: 'ur', color: '#f4f4f4', halo: false,
                    },
                    wind: { type: 'barb', pos: 'c', color: '#70ffe6' },
                },
                { thin_fac: 10, font_size: 13 },
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    vad_profile_barbs_500m: {
        label: 'VAD Barbs 500 m',
        group: 'point',
        available_for: ['VAD_PROFILE'],
        data_keys: ['profile', 'station_id', 'station_elevation_m'],

        make_layers(data, _grid) {
            const obsJson = _toObsJsonAtLevel(data, 500);
            const layer = _buildObsLayer(
                'vad_profile_barbs_500m',
                obsJson,
                {
                    station_id: { type: 'string', pos: 'ur', color: '#f4f4f4', halo: false },
                    wind: { type: 'barb', pos: 'c', color: '#b3fffc' },
                },
                { thin_fac: 10, font_size: 13 },
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    vad_profile_barbs_1km: {
        label: 'VAD Barbs 1 km',
        group: 'point',
        available_for: ['VAD_PROFILE'],
        data_keys: ['profile', 'station_id', 'station_elevation_m'],

        make_layers(data, _grid) {
            const obsJson = _toObsJsonAtLevel(data, 1000);
            const layer = _buildObsLayer(
                'vad_profile_barbs_1km',
                obsJson,
                {
                    station_id: { type: 'string', pos: 'ur', color: '#f4f4f4', halo: false },
                    wind: { type: 'barb', pos: 'c', color: '#8be2ff' },
                },
                { thin_fac: 10, font_size: 13 },
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    vad_profile_barbs_3km: {
        label: 'VAD Barbs 3 km',
        group: 'point',
        available_for: ['VAD_PROFILE'],
        data_keys: ['profile', 'station_id', 'station_elevation_m'],

        make_layers(data, _grid) {
            const obsJson = _toObsJsonAtLevel(data, 3000);
            const layer = _buildObsLayer(
                'vad_profile_barbs_3km',
                obsJson,
                {
                    station_id: { type: 'string', pos: 'ur', color: '#f4f4f4', halo: false },
                    wind: { type: 'barb', pos: 'c', color: '#7db4ff' },
                },
                { thin_fac: 10, font_size: 13 },
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    vad_profile_barbs_6km: {
        label: 'VAD Barbs 6 km',
        group: 'point',
        available_for: ['VAD_PROFILE'],
        data_keys: ['profile', 'station_id', 'station_elevation_m'],

        make_layers(data, _grid) {
            const obsJson = _toObsJsonAtLevel(data, 6000);
            const layer = _buildObsLayer(
                'vad_profile_barbs_6km',
                obsJson,
                {
                    station_id: { type: 'string', pos: 'ur', color: '#f4f4f4', halo: false },
                    wind: { type: 'barb', pos: 'c', color: '#7a8cff' },
                },
                { thin_fac: 10, font_size: 13 },
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    vad_profile_hodographs: {
        label: 'VAD Hodographs',
        group: 'point',
        available_for: ['VAD_PROFILE'],
        data_keys: ['profile', 'station_id'],

        make_layers(data, _grid) {
            const profileField = _toHodographField(data, { maxLevels: 30 });
            if (!profileField) return { layers: [], colorbar: [], sampler: null };

            const heightCmap = new apgl.ColorMap(
                [0, 0.5, 1, 2, 3, 6, 9, 12],
                ['#fff3bf', '#a5f3fc', '#67e8f9', '#22d3ee', '#38bdf8', '#6366f1', '#a78bfa'],
                { underflow_color: '#fff3bf', overflow_color: '#a78bfa' },
            );

            const hodographs = new apgl.Hodographs(profileField, {
                thin_fac: 2,
                hodo_line_width: 3.0,
                background_line_width: 1.6,
                max_wind_speed_ring: 40,
                bgcolor: '#dbe7ff',
                height_cmap: heightCmap,
            });
            const layer = new apgl.PlotLayer('vad_profile_hodographs', hodographs);
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },
};
