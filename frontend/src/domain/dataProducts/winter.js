
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
    'color_snowfall': {
        label: 'Snowfall Amounts',
        group: 'winter',
        available_for: ['LSR'],
        data_keys: ['descript', 'magnitude'],

        make_layers(data, _grid) {
            const KEYS = ['descript', 'magnitude'];
            const obsJson = (data.obs_json || []).map(o => {
                if (o.data.descript === 'Snow') {
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

            console.log('Snowfall obsJson:', obsJson);
            const layer = buildObsLayer(
                'snow_lsr',
                obsJson,
                {
                    magnitude: {
                        type: 'number', pos: 'c', cmap: COLORMAPS['pw_snow'],
                        formatter: fmtNum1, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(COLORMAPS['pw_snow'], {label: "Snowfall Amount [in]", fontface: 'Trebuchet MS',
                                                            ticks: [0, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 34, 40, 50, 60],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },


};