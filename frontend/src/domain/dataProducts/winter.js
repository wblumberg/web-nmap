
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

    'dom_ptype_mean_1km_refd': {
        label: '[MN] Base Reflectivity \& Dominant Precip. Type',
        group: 'winter',
        available_for: ['HREF'],
        data_keys: ['dominant_precipitation_type', 'mean_REFD_hght_1000'],
        make_layers(data, _grid) {
            // Get the colormaps and set them to constants
            const crain_cmap = COLORMAPS['ptype_rain_reflectivity'];
            const csnow_cmap = COLORMAPS['ptype_snow_reflectivity'];
            const cicep_cmap = COLORMAPS['ptype_icep_reflectivity'];
            const cfrzr_cmap = COLORMAPS['ptype_frzr_reflectivity'];

            console.log("Our Data:", data);
            // Make the colorbars
            const svg_crain = apgl.makeColorBar(crain_cmap, {label: "Rain Reflectivity (dBZ)", size_long: 320, size_short: 67, 
                                                     fontface: 'Trebuchet MS', 
                                                     ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_csnow = apgl.makeColorBar(csnow_cmap, {label: "Snow Reflectivity (dBZ)", size_long: 320, size_short: 67, 
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_cicep = apgl.makeColorBar(cicep_cmap, {label: "Sleet Reflectivity (dBZ)", size_long: 320, size_short: 67,     
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_cfrzr = apgl.makeColorBar(cfrzr_cmap, {label: "Freezing Rain Reflectivity (dBZ)", size_long: 320, size_short: 67, 
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const cmap_mask = new Uint8Array(data.dominant_precipitation_type.data);

            // Create the raster layer for the dominant precipitation type and reflectivity
            const raster_cref = new apgl.Raster(data.mean_REFD_hght_1000, {cmap: [crain_cmap, cicep_cmap, cfrzr_cmap, csnow_cmap], 
                                                                 cmap_mask: cmap_mask});
            const raster_layer = new apgl.PlotLayer('meanREFD_dom_ptype_href', raster_cref);

            return { layers: [raster_layer], colorbar: [svg_crain, svg_csnow, svg_cicep, svg_cfrzr], sampler: null };
        },
    },

    'dom_ptype_median_1km_refd': {
        label: '[P50] Base Reflectivity \& Dominant Precip. Type',
        group: 'winter',
        available_for: ['HREF'],
        data_keys: ['dominant_precipitation_type', 'median_REFD_hght_1000'],
        make_layers(data, _grid) {
            // Get the colormaps and set them to constants
            const crain_cmap = COLORMAPS['ptype_rain_reflectivity'];
            const csnow_cmap = COLORMAPS['ptype_snow_reflectivity'];
            const cicep_cmap = COLORMAPS['ptype_icep_reflectivity'];
            const cfrzr_cmap = COLORMAPS['ptype_frzr_reflectivity'];

            console.log("Our Data:", data);
            // Make the colorbars
            const svg_crain = apgl.makeColorBar(crain_cmap, {label: "Rain Reflectivity (dBZ)", size_long: 320, size_short: 67, 
                                                     fontface: 'Trebuchet MS', 
                                                     ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_csnow = apgl.makeColorBar(csnow_cmap, {label: "Snow Reflectivity (dBZ)", size_long: 320, size_short: 67, 
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_cicep = apgl.makeColorBar(cicep_cmap, {label: "Sleet Reflectivity (dBZ)", size_long: 320, size_short: 67,     
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_cfrzr = apgl.makeColorBar(cfrzr_cmap, {label: "Freezing Rain Reflectivity (dBZ)", size_long: 320, size_short: 67, 
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const cmap_mask = new Uint8Array(data.dominant_precipitation_type.data);

            // Create the raster layer for the dominant precipitation type and reflectivity
            const raster_cref = new apgl.Raster(data.median_REFD_hght_1000, {cmap: [crain_cmap, cicep_cmap, cfrzr_cmap, csnow_cmap], 
                                                                 cmap_mask: cmap_mask});
            const raster_layer = new apgl.PlotLayer('medianREFD_dom_ptype_href', raster_cref);

            return { layers: [raster_layer], colorbar: [svg_crain, svg_csnow, svg_cicep, svg_cfrzr], sampler: null };
        },
    },

    'prob_qpf_0p01_ptype': {
        label: '[PR] QPF>0.01 in by Precip. Type ',
        group: 'winter',
        available_for: ['HREF'],
        data_keys: ['prob_qpf_gt0p01in_freezing_rain', 'prob_qpf_gt0p01in_rain', 'prob_qpf_gt0p01in_sleet', 'prob_qpf_gt0p01in_snow'],
        make_layers(data, _grid) {
            // Get the colormaps and set them to constants
            const crain_cmap = COLORMAPS['ptype_rain_probability'];
            const csnow_cmap = COLORMAPS['ptype_snow_probability'];
            const cicep_cmap = COLORMAPS['ptype_icep_probability'];
            const cfrzr_cmap = COLORMAPS['ptype_frzr_probability'];

            //console.log("Our Data:", Math.max(...data.prob_qpf_gt0p01in_rain.data), Math.max(...data.prob_qpf_gt0p01in_snow.data), Math.max(...data.prob_qpf_gt0p01in_sleet.data), Math.max(...data.prob_qpf_gt0p01in_freezing_rain.data));
            // Make the colorbars
            const svg_crain = apgl.makeColorBar(crain_cmap, {label: "Probability of Rain", size_long: 320, size_short: 67, 
                                                     fontface: 'Trebuchet MS', 
                                                     ticks: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_csnow = apgl.makeColorBar(csnow_cmap, {label: "Probability of Snow", size_long: 320, size_short: 67, 
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_cicep = apgl.makeColorBar(cicep_cmap, {label: "Probability of Ice Pellets", size_long: 320, size_short: 67,     
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            const svg_cfrzr = apgl.makeColorBar(cfrzr_cmap, {label: "Probability of Freezing Rain", size_long: 320, size_short: 67, 
                                                            fontface: 'Trebuchet MS', 
                                                            ticks: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});

            
            // Create the raster layer for the dominant precipitation type and reflectivity
            const prob_rain = new apgl.Raster(data.prob_qpf_gt0p01in_rain, {cmap: crain_cmap, alpha: 0.5, });
            const prob_snow = new apgl.Raster(data.prob_qpf_gt0p01in_snow, {cmap: csnow_cmap, alpha: 0.5, });
            const prob_icep = new apgl.Raster(data.prob_qpf_gt0p01in_sleet, {cmap: cicep_cmap, alpha: 0.5, });
            const prob_frzr = new apgl.Raster(data.prob_qpf_gt0p01in_freezing_rain, {cmap: cfrzr_cmap, alpha: 0.5, });

            const pr_rain_layer = new apgl.PlotLayer('prob_rain', prob_rain);
            const pr_snow_layer = new apgl.PlotLayer('prob_snow', prob_snow);
            const pr_icep_layer = new apgl.PlotLayer('prob_icep', prob_icep);
            const pr_frzr_layer = new apgl.PlotLayer('prob_frzr', prob_frzr);

            return { layers: [pr_snow_layer, pr_icep_layer, pr_frzr_layer, pr_rain_layer], colorbar: [svg_crain, svg_csnow, svg_cicep, svg_cfrzr], sampler: null };
        },
    }
};