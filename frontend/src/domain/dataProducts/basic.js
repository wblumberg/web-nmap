// Products group: BASIC
// Analogous to the "basic" group entries in NMAP2's mod_res.tbl
// Covers: temperature, dewpoint, heights, winds

import COLORMAPS from '../../config/colormaps.js';
import { hasFiniteValues, smooth2D } from './utils.js';
import { recordDiagnostic } from '../../services/mapDiagnostics.js';

function makeOptionalMslpLayers(data, grid, product) {
    const sourceField = data?.mean_MSLMA;
    if (!sourceField || typeof sourceField.renderCPU !== 'function') {
        recordDiagnostic('field-overlay-skipped', {
            product,
            field: 'mean_MSLMA',
            reason: 'missing-data-key',
            message: 'MSLP contours skipped: mean_MSLMA was not returned',
        });
        return [];
    }

    const raw = sourceField.renderCPU();
    if (!hasFiniteValues(raw?.data)) {
        recordDiagnostic('field-overlay-skipped', {
            product,
            field: 'mean_MSLMA',
            reason: 'no-finite-values',
            valueCount: raw?.data?.length ?? 0,
            message: 'MSLP contours skipped: mean_MSLMA contains no finite values',
        });
        return [];
    }

    const smoothed = new apgl.RawScalarField(grid, smooth2D(raw.data, grid.ni, grid.nj));
    const contour = new apgl.Contour(smoothed, {
        interval: 4, color: '#000000', line_width: 3,
    });
    const labels = new apgl.ContourLabels(contour, {
        text_color: '#ffffff', halo: true, font_size: 16, halo_color: '#000000',
        font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
    });
    return [
        new apgl.PlotLayer('mslp_cntr', contour),
        new apgl.PlotLayer('mslp_lbls', labels),
    ];
}

export default {

    'sfc_temp_fill': {
        label: '2m Temperature (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  ECMWF HiRes  F{fhr3}  2m Temperature (°F)',
        group: 'basic',
        available_for: ['ECMWF_HR'],
        data_keys: ['temperature_2m'],
        make_layers(data, grid) {
            // renderCPU() materialises the ComputedScalarField into a
            // RawScalarField<Float32Array> — required because Contour needs
            // CPU-side data for its marching-squares contour solver.
            const field = data.temperature_2m.subtract(273.15).multiply(9/5).add(32).renderCPU();
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_t2m'] });
            const cntr  = new apgl.Contour(field, { levels: [32], line_width: 3, color: '#ffffff' });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_t2m'], {
                label: '2m Temperature (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [-40, -20, 0, 20, 40, 60, 80, 100, 120],
            });
            return {
                layers: [
                    new apgl.PlotLayer('t2m_fill', fill),
                    new apgl.PlotLayer('t2m_32f',  cntr),
                ],
                colorbar: [svg],
                sampler: (lon, lat) => ({ temperature_2m: field.sampleField(lon, lat) }),
            };
        },
    },

    'sfc_dwpt_fill': {
        label: '2m Dewpoint (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  ECMWF HiRes  F{fhr3}  2m Dewpoint (°F)',
        group: 'basic',
        available_for: ['ECMWF_HR'],
        data_keys: ['dewpoint_2m'],
        make_layers(data, grid) {
            const field = data.dewpoint_2m.subtract(273.15).multiply(9/5).add(32);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_td2m'], opacity: 0.5 });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_td2m'], {
                label: '2m Dewpoint (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [new apgl.PlotLayer('d2m_fill', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ dewpoint_2m: field.sampleField(lon, lat) }),
            };
        },
    },

    'sfc_temp_fill_mean': {
        label: '[MN] 2m Temperature and MSLP',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Mean 2-m Temperature & Mean Sea Level Pressure [mb]',
        group: 'basic',
        available_for: ['HREF'],
        data_keys: ['mean_TMP_hght_2', 'mean_MSLMA'],
        make_layers(data, grid) {
            const field = data.mean_TMP_hght_2;
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_t2m'] });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_t2m'], {
                label: '2-m Temperature (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [-40, -20, 0, 20, 40, 60, 80, 100, 120],
            });
            const mslpLayers = makeOptionalMslpLayers(data, grid, 'sfc_temp_fill_mean');
            return {
                layers: [new apgl.PlotLayer('2m_fill', fill), ...mslpLayers],
                colorbar: [svg],
                sampler: (lon, lat) => ({ mean_TMP_hght_2: field.sampleField(lon, lat) }),
            };
        },
    },

    'sfc_dwpt_fill_mean': {
        label: '[MN] 2m Dewpoint and MSLP',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Mean 2-m Dewpoint & Mean Sea Level Pressure [mb]',
        group: 'basic',
        available_for: ['HREF'],
        data_keys: ['mean_DPT_hght_2', 'mean_MSLMA'],
        make_layers(data, grid) {
            const field = data.mean_DPT_hght_2;
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_td2m'] });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_td2m'], {
                label: '2-m Dewpoint (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80]
            });
            const mslpLayers = makeOptionalMslpLayers(data, grid, 'sfc_dwpt_fill_mean');
            return {
                layers: [new apgl.PlotLayer('2m_fill', fill), ...mslpLayers],
                colorbar: [svg],
                sampler: (lon, lat) => ({ mean_DPT_hght_2: field.sampleField(lon, lat) }),
            };
        },
    },

    '500mb_analysis': {
        label: '500mb Heights / Wind Speed / Barbs',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  ECMWF HiRes  F{fhr3}  500mb Heights / Winds',
        group: 'basic',
        available_for: ['ECMWF_HR'],
        data_keys: ['hght_500mb', 'ugrd_500mb', 'vgrd_500mb'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.hght_500mb;
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const wind = new apgl.RawVectorField(grid, data.ugrd_500mb.data, data.vgrd_500mb.data,
                                                 { relative_to: 'grid' });
            const wspd = apgl.RawScalarField.aggregateFields(Math.hypot, data.ugrd_500mb, data.vgrd_500mb);

            const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const cntr  = new apgl.Contour(hghtSmth, {
                interval: 6, color: '#000000',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5,
            });
            const barbs = new apgl.Barbs(wind,  { color: '#000000', thin_fac: 16 });
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#ffffff', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_speed500mb'], {
                label: '500mb Wind Speed (kts)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [20, 40, 60, 80, 100, 120, 140],
            });
            return {
                layers: [
                    new apgl.PlotLayer('500_fill',  fill),
                    new apgl.PlotLayer('500_cntr',  cntr),
                    new apgl.PlotLayer('500_barbs', barbs),
                    new apgl.PlotLayer('500_lbls',  lbls),
                ],
                colorbar: [svg],
                sampler: (lon, lat) => ({
                    hght: hght.sampleField(lon, lat),
                    wind: wind.sampleField(lon, lat),
                }),
            };
        },
    },

    '500mb_map': {
        label: '500 mb Height, Temp, and Winds',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis 500mb Heights / Temp / Winds',
        group: 'base',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_500hpa', 'tmpk_500hpa', 'urel_500hpa', 'vrel_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const tmpc = data.tmpk_500hpa.subtract(273.15).renderCPU();
            const hght = data.hght_500hpa;
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const wind = new apgl.RawVectorField(grid, data.urel_500hpa.data, data.vrel_500hpa.data,
                                                 { relative_to: 'grid' });

            //const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 60, color: '#fdd34a',
                line_width: 3,
            });
            const tmpc_cntr  = new apgl.Contour(tmpc, {
                interval: 2, color: '#da4343',
                line_width: 2, line_style: '--',
            });

            //const barbs = new apgl.Barbs(wind,  { color: '#303030', thin_fac: 12 });
            const barbs = new apgl.Barbs(wind,  { color: '#7f99b1', thin_fac: 16 });

            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#ecec5e', halo: true, halo_color: '#000000',
                font_url_template: '/static/font/{fontstack}/{range}.pbf',
            });
            const tmpc_lbls  = new apgl.ContourLabels(tmpc_cntr, {
               text_color: '#f94040', halo: true, halo_color: '#000000',
               font_url_template: '/static/font/{fontstack}/{range}.pbf',
            });          

            return {
                layers: [
                    //new apgl.PlotLayer('500_fill',  fill),
                    new apgl.PlotLayer('500_hght',  hght_cntr),
                    new apgl.PlotLayer('500_tmpc',  tmpc_cntr),
                    new apgl.PlotLayer('500_barbs', barbs),
                    new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                    new apgl.PlotLayer('500_tmpc_lbls',  tmpc_lbls),
                ],
                colorbar: [],
                sampler: [],
            };
        },
    },

    '700mb_map': {
        label: '700 mb Height, Temp, and Winds',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis 700mb Heights / Temp / Winds',
        group: 'base',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_700hpa', 'tmpk_700hpa', 'urel_700hpa', 'vrel_700hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const tmpc = data.tmpk_700hpa.subtract(273.15).renderCPU();
            const hght = data.hght_700hpa;
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const wind = new apgl.RawVectorField(grid, data.urel_700hpa.data, data.vrel_700hpa.data,
                                                 { relative_to: 'grid' });

            //const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 60, color: '#fdd34a',
                line_width: 3,
            });
            const tmpc_cntr  = new apgl.Contour(tmpc, {
                interval: 2, color: '#da4343',
                line_width: 2, line_style: '--',
            });

            const barbs = new apgl.Barbs(wind,  { color: '#7f99b1', thin_fac: 16 });
            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#ecec5e', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const tmpc_lbls  = new apgl.ContourLabels(tmpc_cntr, {
                text_color: '#f94040', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });          

            return {
                layers: [
                    //new apgl.PlotLayer('700_fill',  fill),
                    new apgl.PlotLayer('700_hght',  hght_cntr),
                    new apgl.PlotLayer('700_tmpc',  tmpc_cntr),
                    new apgl.PlotLayer('700_barbs', barbs),
                    new apgl.PlotLayer('700_hght_lbls',  hght_lbls),
                    new apgl.PlotLayer('700_tmpc_lbls',  tmpc_lbls),
                ],
                colorbar: [],
                sampler: [],
            };
        },
    },

    '850mb_map': {
        label: '850 mb Height, Temp, and Winds',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis 850mb Heights / Temp / Winds',
        group: 'base',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_850hpa', 'tmpk_850hpa', 'urel_850hpa', 'vrel_850hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const tmpc = data.tmpk_850hpa.subtract(273.15).renderCPU();
            const hght = data.hght_850hpa;
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const wind = new apgl.RawVectorField(grid, data.urel_850hpa.data, data.vrel_850hpa.data,
                                                 { relative_to: 'grid' });

            //const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 60, color: '#fdd34a',
                line_width: 3,
            });
            const tmpc_cntr  = new apgl.Contour(tmpc, {
                interval: 2, color: '#da4343',
                line_width: 2, line_style: '--',
            });

            const barbs = new apgl.Barbs(wind,  { color: '#7f99b1', thin_fac: 16 });
            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#ecec5e', halo: true, halo_color: '#000000',
                //font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
                font_url_template: '/static/font/{fontstack}/{range}.pbf',
            });
            const tmpc_lbls  = new apgl.ContourLabels(tmpc_cntr, {
                text_color: '#f94040', halo: true, halo_color: '#000000',
                font_url_template: '/static/font/{fontstack}/{range}.pbf',
                //font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });          

            return {
                layers: [
                    //new apgl.PlotLayer('850_fill',  fill),
                    new apgl.PlotLayer('850_hght',  hght_cntr),
                    new apgl.PlotLayer('850_tmpc',  tmpc_cntr),
                    new apgl.PlotLayer('850_barbs', barbs),
                    new apgl.PlotLayer('850_hght_lbls',  hght_lbls),
                    new apgl.PlotLayer('850_tmpc_lbls',  tmpc_lbls),
                ],
                colorbar: [],
                sampler: [],
            };
        },
    },

    '500mb_mean': {
        label: '[MNSD] 500 mb Heights',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Ens. Mean 500mb Heights / Spread',
        group: 'base',
        available_for: ['NSSL_GEFS', 'ECMWF_ENS'],
        data_keys: ['mean_HGT_pres_500', 'spread_HGT_pres_500'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const hght = data.mean_HGT_pres_500;
            const spread = data.spread_HGT_pres_500;

            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const levels = [0, 30, 60, 90, 120, 150, 180] 
            //const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027'];

            const colors = [
                '#ffffffbb',
                '#deebf7',
                '#9ecae1',
                '#4292c6',
                '#08519c',
                '#041f4a',
            ];

            const cb = new apgl.ColorMap(levels, colors, {
                underflow_color: '#ffffff',
                overflow_color: '#041f4a',
            });
            const fill  = new apgl.ContourFill(spread,  { cmap: cb, opacity: 0.8 });
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 30, color: '#000000',
                line_width: lev => (lev % 60 === 0) ? 3 : 2.5,
            });

            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#ffffff', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            const spread_cbar = apgl.makeColorBar(cb, {label: "500 mb Height Spread [gpm]", fontface: 'Trebuchet MS',
                                                ticks: [30, 60, 90, 120, 150, 180, 210, 240, 270, 300],
                                                orientation: 'horizontal', tick_direction: 'bottom'});
            return {
                layers: [
                    new apgl.PlotLayer('500_fill',  fill),
                    new apgl.PlotLayer('500_hght',  hght_cntr),
                    new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                ],
                colorbar: [spread_cbar],
                sampler: [],
            };
        },
    },

    'mn_pmsl_td2m': {
        label: '[MN] MSLP and 2-m Dewpoint',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Ens Mean MSLP / 2m Dewpoint',
        group: 'base',
        available_for: ['NSSL_GEFS', 'ECMWF_ENS'],
        data_keys: ['mean_MSLMA', 'mean_DPT_hght_2'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const pmslRaw  = data.mean_MSLMA.renderCPU();
            const pmslSmth = pmslRaw;
            //const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const dpt = data.mean_DPT_hght_2.subtract(273.15).multiply(9/5).add(32).renderCPU();

            const fill  = new apgl.ContourFill(dpt,  { cmap: COLORMAPS['pw_td2m'], opacity: 0.8 });
            const pmsl_cntr  = new apgl.Contour(pmslSmth, {
                interval: 4, color: '#000000',
                line_width: 2,
            });

            const pmsl_lbls  = new apgl.ContourLabels(pmsl_cntr, {
                text_color: '#ffffff', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            const dpt_cbar = apgl.makeColorBar(COLORMAPS['pw_td2m'], {label: "Mean 2-m Dewpoint [°F]", fontface: 'Trebuchet MS',
                                                ticks: [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80],
                                                orientation: 'horizontal', tick_direction: 'bottom'});
            return {
                layers: [
                    new apgl.PlotLayer('2m_dwpt_fill',  fill),
                    new apgl.PlotLayer('MSLMA',  pmsl_cntr),
                    new apgl.PlotLayer('MSLMA_lbls',  pmsl_lbls),
                ],
                colorbar: [dpt_cbar],
                sampler: [],
            };
        },
    },

    'mn_pmsl_t2m': {
        label: '[MN] MSLP and 2-m Temperature',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Ens Mean MSLP / 2m Temperature',
        group: 'base',
        available_for: ['NSSL_GEFS', 'ECMWF_ENS'],
        data_keys: ['mean_MSLMA', 'mean_TMP_hght_2'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const pmslRaw  = data.mean_MSLMA.renderCPU();
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const tmp = data.mean_TMP_hght_2.subtract(273.15).multiply(9/5).add(32).renderCPU();

            const fill  = new apgl.ContourFill(tmp,  { cmap: COLORMAPS['pw_t2m'], opacity: 0.8 });
            const pmsl_cntr  = new apgl.Contour(pmslSmth, {
                interval: 4, color: '#000000',
                line_width: 2,
            });

            const pmsl_lbls  = new apgl.ContourLabels(pmsl_cntr, {
                text_color: '#ffffff', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            const tmp_cbar = apgl.makeColorBar(COLORMAPS['pw_t2m'], {label: "Mean 2-m Temperature [°F]", fontface: 'Trebuchet MS',
                                                ticks: [-40, -20, 0, 20, 40, 60, 80, 100, 120],
                                                orientation: 'horizontal', tick_direction: 'bottom'});
            return {
                layers: [
                    new apgl.PlotLayer('2m_tmp_fill',  fill),
                    new apgl.PlotLayer('MSLMA',  pmsl_cntr),
                    new apgl.PlotLayer('MSLMA_lbls',  pmsl_lbls),
                ],
                colorbar: [tmp_cbar],
                sampler: [],
            };
        },
    },

 'cam_pmsl_t2m': {
        label: 'MSLP and 2-m Temperature',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  MSLP / 2m Temperature',
        group: 'base',
        available_for: ['NSSL_WRF', 'HRRR', 'HRW_ARW', 'HRW_FV3', 'NAM_NEST'],
        data_keys: ['MSLMA', 'TMP_hght_2'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const pmslRaw  = data.MSLMA.renderCPU();
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const tmp = data.TMP_hght_2.subtract(273.15).multiply(9/5).add(32).renderCPU();

            const fill  = new apgl.ContourFill(tmp,  { cmap: COLORMAPS['pw_t2m'], opacity: 0.8 });
            const pmsl_cntr  = new apgl.Contour(pmslSmth, {
                interval: 4, color: '#000000',
                line_width: lev => (lev % 4 === 0) ? 3 : 1.5,
            });

            const pmsl_lbls  = new apgl.ContourLabels(pmsl_cntr, {
                text_color: '#ffffff', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            const tmp_cbar = apgl.makeColorBar(COLORMAPS['pw_t2m'], {label: "Mean 2-m Temperature [°F]", fontface: 'Trebuchet MS',
                                                ticks: [-40, -20, 0, 20, 40, 60, 80, 100, 120],
                                                orientation: 'horizontal', tick_direction: 'bottom'});
            return {
                layers: [
                    new apgl.PlotLayer('2m_tmp_fill',  fill),
                    new apgl.PlotLayer('MSLMA',  pmsl_cntr),
                    new apgl.PlotLayer('MSLMA_lbls',  pmsl_lbls),
                ],
                colorbar: [tmp_cbar],
                sampler: [],
            };
        },
    },

 'cam_pmsl_d2m': {
        label: 'MSLP and 2-m Dewpoint',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  MSLP / 2m Dewpoint',
        group: 'base',
        available_for: ['NSSL_WRF', 'HRRR', 'HRW_ARW', 'HRW_FV3', 'NAM_NEST'],
        data_keys: ['MSLMA', 'DPT_hght_2'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            console.log("MSLMA seems to be missing from data.")
            const pmslRaw  = data.MSLMA.divide(100.).renderCPU();
            //console.log("pmslRaw", pmslRaw);
            //console.log("raw: ", data.MSLMA);
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const tmp = data.DPT_hght_2.subtract(273.15).multiply(9/5).add(32).renderCPU();

            const fill  = new apgl.ContourFill(tmp,  { cmap: COLORMAPS['pw_td2m'], opacity: 0.8 });
            const pmsl_cntr  = new apgl.Contour(pmslSmth, {
                interval: 4, color: '#000000',
                line_width: lev => (lev % 4 === 0) ? 3 : 1.5,
            });

            const pmsl_lbls  = new apgl.ContourLabels(pmsl_cntr, {
                text_color: '#ffffff', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            const dpt_cbar = apgl.makeColorBar(COLORMAPS['pw_td2m'], {label: "Mean 2-m Dewpoint [°F]", fontface: 'Trebuchet MS',
                                                ticks: [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80],
                                                orientation: 'horizontal', tick_direction: 'bottom'});
            return {
                layers: [
                    new apgl.PlotLayer('2m_tmp_fill',  fill),
                    new apgl.PlotLayer('MSLMA',  pmsl_cntr),
                    new apgl.PlotLayer('MSLMA_lbls',  pmsl_lbls),
                ],
                colorbar: [dpt_cbar],
                sampler: [],
            };
        },
    },
};
