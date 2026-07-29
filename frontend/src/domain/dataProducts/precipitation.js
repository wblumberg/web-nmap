
import COLORMAPS from '../../config/colormaps.js';

// Generic number to 1 decimal place
const fmtNum1 = val => isMissing(val) ? '' : val.toFixed(1);

// --- Shared unit conversions and chaining functions
const pipe = (...fns) => val =>
    fns.reduce((v, fn) => fn(v), val);

const isMissing = val => val === null || isNaN(val);
const safe = fn => val => isMissing(val) ? null : fn(val);



function buildObsLayer(layerId, obsJson, spConfig, opts = {}) {
    const {
        thin_fac = 8,
        font_size = 14,
        font_face = 'Trebuchet MS',
        // If you have a local glyph server, set this; otherwise apgl uses
        // the map style's glyphs URL automatically
        font_url_template = 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
    } = opts;

    const grid = new apgl.UnstructuredGrid(obsJson.map(o => o.coord));
    const field = new apgl.RawObsField(grid, obsJson.map(o => o.data));
    const plot = new apgl.StationPlot(field, {
        config: spConfig,
        thin_fac,
        font_size,
        font_face,
        font_url_template,
    });

    return new apgl.PlotLayer(layerId, plot);
}


export default {
    'color_rainfall_lsr': {
        label: 'Rainfall Amounts',
        group: 'precip',
        available_for: ['LSR'],
        data_keys: ['descript', 'magnitude'],

        make_layers(data, _grid) {
            const KEYS = ['descript', 'magnitude'];
            const obsJson = (data.obs_json || []).map(o => {
                if (o.data.descript === 'Rain') {
                    o.data.magnitude = Number(o.data.magnitude);
                } else {
                    o.data.magnitude = null;
                }
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            console.log('Rainfall obsJson:', obsJson);
            const layer = buildObsLayer(
                'rain_lsr',
                obsJson,
                {
                    magnitude: {
                        type: 'number', pos: 'c', cmap: COLORMAPS['href_qpf'],
                        formatter: fmtNum1, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(COLORMAPS['href_qpf'], {label: "Rainfall Amount [in]", fontface: 'Trebuchet MS',
                                                            ticks: [0.01, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0, 20.0],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },


     'color_rainfall_1hr': {
        label: '1-hr Rainfall Amounts',
        group: 'precip',
        available_for: ['SAO'],
        data_keys: ['p01i'],
        
        make_layers(data, _grid) {
            const KEYS = ['p01i'];
            const obsJson = (data.obs_json || []).map(o => {
                if (o.data.p01i !== undefined) {
                    o.data.p01i = Number(o.data.p01i);
                } else {
                    o.data.p01i = null;
                }
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            const layer = buildObsLayer(
                'rain_1hr',
                obsJson,
                {
                    p01i: {
                        type: 'number', pos: 'c', cmap: COLORMAPS['href_qpf'],
                        formatter: fmtNum1, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(COLORMAPS['href_qpf'], {label: "1 hour Rainfall Amount [in]", fontface: 'Trebuchet MS',
                                                            ticks: [0.01, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0, 20.0],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },   
    

    'color_rainfall_3hr': {
        label: '3-hr Rainfall Amounts',
        group: 'precip',
        available_for: ['SAO'],
        data_keys: ['p03i'],

        make_layers(data, _grid) {
            const KEYS = ['p03i'];
            const obsJson = (data.obs_json || []).map(o => {
                if (o.data.p03i !== undefined) {
                    o.data.p03i = Number(o.data.p03i);
                } else {
                    o.data.p03i = null;
                }
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            const layer = buildObsLayer(
                'rain_3hr',
                obsJson,
                {
                    p03i: {
                        type: 'number', pos: 'c', cmap: COLORMAPS['href_qpf'],
                        formatter: fmtNum1, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(COLORMAPS['href_qpf'], {label: "3 hour Rainfall Amount [in]", fontface: 'Trebuchet MS',
                                                            ticks: [0.01, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0, 20.0],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },

    'color_rainfall_6hr': {
        label: '6-hr Rainfall Amounts',
        group: 'precip',
        available_for: ['SAO'],
        data_keys: ['p06i'],

        make_layers(data, _grid) {
            const KEYS = ['p06i'];
            const obsJson = (data.obs_json || []).map(o => {
                if (o.data.p06i !== undefined) {
                    o.data.p06i = Number(o.data.p06i);
                } else {
                    o.data.p06i = null;
                }
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            const layer = buildObsLayer(
                'rain_6hr',
                obsJson,
                {
                    p06i: {
                        type: 'number', pos: 'c', cmap: COLORMAPS['href_qpf'],
                        formatter: fmtNum1, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(COLORMAPS['href_qpf'], {label: "6 hour Rainfall Amount [in]", fontface: 'Trebuchet MS',
                                                            ticks: [0.01, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0, 20.0],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },




    'color_rainfall_24hr': {
        label: '24-hr Rainfall Amounts',
        group: 'precip',
        available_for: ['SAO'],
        data_keys: ['p24i'],

        make_layers(data, _grid) {
            const KEYS = ['p24i'];
            const obsJson = (data.obs_json || []).map(o => {
                if (o.data.p24i !== undefined) {
                    o.data.p24i = Number(o.data.p24i);
                } else {
                    o.data.p24i = null;
                }
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            const layer = buildObsLayer(
                'rain_24hr',
                obsJson,
                {
                    p24i: {
                        type: 'number', pos: 'c', cmap: COLORMAPS['href_qpf'],
                        formatter: fmtNum1, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(COLORMAPS['href_qpf'], {label: "24 hour Rainfall Amount [in]", fontface: 'Trebuchet MS',
                                                            ticks: [0.01, 0.1, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.0, 10.0, 15.0, 20.0],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },


    '1hr_acpc': {
        label: '1-hr Accumulated Precip.',
        group: 'precip',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  1-hr Accumulated Precipitation [in]',
        available_for:  ['NSSL_WRF', "HRRR", 'HRW_ARW', 'HRW_FV3', 'NAM_NEST', 'NSSL_MPAS_RN'],
        data_keys: ['APCP_accum_1h'],
        make_layers(data, grid) {
            const field = data.APCP_accum_1h.multiply(0.0393701).renderCPU();

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['href_qpf'] });

            const svg = apgl.makeColorBar(COLORMAPS['href_qpf'], {
                label: 'Accumulated Precipitation [in]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('accum_precip_1hr', fill)],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

};