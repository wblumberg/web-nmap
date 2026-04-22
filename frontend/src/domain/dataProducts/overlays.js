// Products group: BASIC
// Analogous to the "basic" group entries in NMAP2's mod_res.tbl
// Covers: temperature, dewpoint, heights, winds

import COLORMAPS from '../../config/colormaps.js';

export default {
    '500mb_hght_yellow': {
        label: '500 mb Height (Yellow)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.hght_500hpa;
            const cntr  = new apgl.Contour(hght, {
                interval: 60, color: '#e7f800',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5, quad_as_tri: false
            });
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#eaff00', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            return {
                layers: [
                    new apgl.PlotLayer('500_cntr',  cntr),
                    new apgl.PlotLayer('500_lbls',  lbls),
                ],
                colorbar: [],
                sampler: []
            };
        },
    },
    '500mb_hght_purple': {
        label: '500 mb Height (Purple)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.hght_500hpa;
            const cntr  = new apgl.Contour(hght, {
                interval: 60, color: '#9900f8',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5, quad_as_tri: false,
            });
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#b700ff', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            return {
                layers: [
                    new apgl.PlotLayer('500_cntr',  cntr),
                    new apgl.PlotLayer('500_lbls',  lbls),
                ],
                colorbar: [],
                sampler: []
            };
        },
    },
    'mslp_yellow': {
        label: 'MSLP (Yellow)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['pmsl'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const cntr = new apgl.Contour(
                data.pmsl,
                { interval: 4, color: '#ffff00', line_width: 3 }
            );
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#f2ff00', halo: true, font_size: 16, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            return {
                layers: [
                    new apgl.PlotLayer('pmsl_cntr',  cntr),
                    new apgl.PlotLayer('pmsl_lbls',  lbls),
                ],
                colorbar: [],
                sampler: []
            };
        },
    },
};
