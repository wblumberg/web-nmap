import { smooth2D } from './utils.js';
import COLORMAPS from '../../config/colormaps.js';

export default {

  '500mb_qg_ab': {
        label: '500mb QG Omega (Vort+Temp)',
        group: 'lift',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_500hpa', 'qgvo_500hpa', 'qgto_500hpa', 'tmpk_500hpa', 'urel_500hpa', 'vrel_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const tmpc = data.tmpk_500hpa.subtract(273.15).renderCPU();
            const hght = data.hght_500hpa;
            const wind = new apgl.RawVectorField(grid, data.urel_500hpa.data, data.vrel_500hpa.data,
                                                 { relative_to: 'grid' });

            //const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const tmpcSmth = new apgl.RawScalarField(grid, smooth2D(tmpc.data, grid.ni, grid.nj));
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 60, color: '#afa600',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5,
            });
            const tmpc_cntr  = new apgl.Contour(tmpcSmth, {
                interval: 2, color: '#a74949',
                line_width: 2, line_style: '--',
            });

            const barbs = new apgl.Barbs(wind,  { color: '#303030', thin_fac: 10 });
            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#d9d96a', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const tmpc_lbls  = new apgl.ContourLabels(tmpc_cntr, {
                text_color: '#b64141', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });          
            const levels = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50] 
            //const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027'];
            const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#00000000', '#00000000', '#fee090', '#fdae61', '#f46d43', '#d73027'];

            const cb = new apgl.ColorMap(levels, colors, {underflow_color: '#313695', overflow_color: '#d73027'});

            const qg_omega = data.qgto_500hpa.add(data.qgvo_500hpa).multiply(36).renderCPU() // Convert from Pa/s to mb/hr
            const fill = new apgl.ContourFill(qg_omega, {cmap: cb, opacity: 0.7})
            const svg   = apgl.makeColorBar(cb, {
                label: '500 mb QG Omega from Vorticity and Temperature Terms [mb/hr]',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [
                    //new apgl.PlotLayer('500_fill',  fill),
                    new apgl.PlotLayer('500_omega', fill), 
                    new apgl.PlotLayer('500_hght',  hght_cntr),
                    new apgl.PlotLayer('500_tmpc',  tmpc_cntr),
                    new apgl.PlotLayer('500_barbs', barbs),
                    new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                    new apgl.PlotLayer('500_tmpc_lbls',  tmpc_lbls),
                ],
                colorbar: [svg],
                sampler: [],
            };
        },
    },

  '700mb_qg_ab': {
        label: '700mb QG Omega (Vort+Temp)',
        group: 'lift',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_700hpa', 'qgvo_700hpa', 'qgto_700hpa', 'tmpk_700hpa', 'urel_700hpa', 'vrel_700hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const tmpc = data.tmpk_700hpa.subtract(273.15).renderCPU();
            const hght = data.hght_700hpa;
            const wind = new apgl.RawVectorField(grid, data.urel_700hpa.data, data.vrel_700hpa.data,
                                                 { relative_to: 'grid' });

            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const tmpcSmth = new apgl.RawScalarField(grid, smooth2D(tmpc.data, grid.ni, grid.nj));
            //const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 60, color: '#afa600',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5,
            });
            const tmpc_cntr  = new apgl.Contour(tmpcSmth, {
                interval: 2, color: '#a74949',
                line_width: 2, line_style: '--',
            });

            const barbs = new apgl.Barbs(wind,  { color: '#303030', thin_fac: 10 });
            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#d9d96a', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const tmpc_lbls  = new apgl.ContourLabels(tmpc_cntr, {
                text_color: '#b64141', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });          
            const levels = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50] 
            //const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027'];
            const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#00000000', '#00000000', '#fee090', '#fdae61', '#f46d43', '#d73027'];

            const cb = new apgl.ColorMap(levels, colors, {underflow_color: '#313695', overflow_color: '#d73027'});

            const qg_omega = data.qgto_700hpa.add(data.qgvo_700hpa).multiply(36).renderCPU() // Convert from Pa/s to mb/hr
            const fill = new apgl.ContourFill(qg_omega, {cmap: cb, opacity: 0.7})
            const svg   = apgl.makeColorBar(cb, {
                label: '700 mb QG Omega from Vorticity and Temperature Terms [mb/hr]',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [
                    //new apgl.PlotLayer('700_fill',  fill),
                    new apgl.PlotLayer('700_omega', fill), 
                    new apgl.PlotLayer('700_hght',  hght_cntr),
                    new apgl.PlotLayer('700_tmpc',  tmpc_cntr),
                    new apgl.PlotLayer('700_barbs', barbs),
                    new apgl.PlotLayer('700_hght_lbls',  hght_lbls),
                    new apgl.PlotLayer('700_tmpc_lbls',  tmpc_lbls),
                ],
                colorbar: [svg],
                sampler: [],
            };
        },
    },
  '850mb_qg_ab': {
        label: '850mb QG Omega (Vort+Temp)',
        group: 'lift',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_850hpa', 'qgvo_850hpa', 'qgto_850hpa', 'tmpk_850hpa', 'urel_850hpa', 'vrel_850hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const tmpc = data.tmpk_850hpa.subtract(273.15).renderCPU();
            const hght = data.hght_850hpa;
            const wind = new apgl.RawVectorField(grid, data.urel_850hpa.data, data.vrel_850hpa.data,
                                                 { relative_to: 'grid' });

            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.renderCPU().data, grid.ni, grid.nj));
            const tmpcSmth = new apgl.RawScalarField(grid, smooth2D(tmpc.data, grid.ni, grid.nj));
            //const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const hght_cntr  = new apgl.Contour(hghtSmth, {
                interval: 60, color: '#afa600',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5,
            });
            const tmpc_cntr  = new apgl.Contour(tmpcSmth, {
                interval: 2, color: '#a74949',
                line_width: 2, line_style: '--',
            });

            const barbs = new apgl.Barbs(wind,  { color: '#303030', thin_fac: 10 });
            const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
                text_color: '#d9d96a', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const tmpc_lbls  = new apgl.ContourLabels(tmpc_cntr, {
                text_color: '#b64141', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });          
            const levels = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50] 
            //const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027'];
            const colors = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#00000000', '#00000000', '#fee090', '#fdae61', '#f46d43', '#d73027'];

            const cb = new apgl.ColorMap(levels, colors, {underflow_color: '#313695', overflow_color: '#d73027'});

            const qg_omega = data.qgto_850hpa.add(data.qgvo_850hpa).multiply(36).renderCPU() // Convert from Pa/s to mb/hr
            const fill = new apgl.ContourFill(qg_omega, {cmap: cb, opacity: 0.7})
            const svg   = apgl.makeColorBar(cb, {
                label: '850 mb QG Omega from Vorticity and Temperature Terms [mb/hr]',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [
                    //new apgl.PlotLayer('500_fill',  fill),
                    new apgl.PlotLayer('850_omega', fill), 
                    new apgl.PlotLayer('850_hght',  hght_cntr),
                    new apgl.PlotLayer('850_tmpc',  tmpc_cntr),
                    new apgl.PlotLayer('850_barbs', barbs),
                    new apgl.PlotLayer('850_hght_lbls',  hght_lbls),
                    new apgl.PlotLayer('850_tmpc_lbls',  tmpc_lbls),
                ],
                colorbar: [svg],
                sampler: [],
            };
        },
    },
};