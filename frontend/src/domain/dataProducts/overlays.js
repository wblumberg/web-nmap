// Products group: BASIC
// Analogous to the "basic" group entries in NMAP2's mod_res.tbl
// Covers: temperature, dewpoint, heights, winds

import COLORMAPS from '../../config/colormaps.js';
import { smooth2D } from './utils.js';

export default {
    '500mb_hght_yellow': {
        label: '500 mb Height (Yellow; ∆z=60m)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  500mb Heights (Yellow Contours)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.hght_500hpa.renderCPU();
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.data, grid.ni, grid.nj));
            const cntr  = new apgl.Contour(hghtSmth, {
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
        label: '500 mb Height (Purple; ∆z=60m)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  500mb Heights (Purple Contours)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['hght_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.hght_500hpa.renderCPU();
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.data, grid.ni, grid.nj));
            const cntr  = new apgl.Contour(hghtSmth, {
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
        label: 'MSLP (Yellow; ∆p=4mb)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  MSLP (Yellow Contours)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['pmsl'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const pmslRaw  = data.pmsl.renderCPU();
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const cntr = new apgl.Contour(
                pmslSmth,
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
    'mslp_pink': {
        label: 'MSLP (Pink; ∆p=4mb)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  MSLP (Pink Contours)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['pmsl'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const pmslRaw  = data.pmsl.renderCPU();
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const cntr = new apgl.Contour(
                pmslSmth,
                { interval: 4, color: '#e96fe7', line_width: 3 }
            );
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#d27edd', halo: true, font_size: 16, halo_color: '#000000',
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

    'mslp_yellow_2mb': {
        label: 'MSLP (Yellow; ∆p=2 mb)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  MSLP (Yellow Contours)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['pmsl'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const pmslRaw  = data.pmsl.renderCPU();
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const cntr = new apgl.Contour(
                pmslSmth,
                { interval: 2, color: '#ffff00', line_width: 3 }
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
    'mslp_pink_2mb': {
        label: 'MSLP (Pink; ∆p=2 mb)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  MSLP (Pink Contours)',
        group: 'overlays',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['pmsl'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const pmslRaw  = data.pmsl.renderCPU();
            const pmslSmth = new apgl.RawScalarField(grid, smooth2D(pmslRaw.data, grid.ni, grid.nj));
            const cntr = new apgl.Contour(
                pmslSmth,
                { interval: 2, color: '#e96fe7', line_width: 3 }
            );
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#d27edd', halo: true, font_size: 16, halo_color: '#000000',
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
    '500mb_hght_yellow_mean': {
        label: '[MN] 500 mb Hght (Yellow; ∆z=60m)',
        title: 'Valid: {valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  F{fhr3} {source} Mean 500mb Heights (Yellow)',
        group: 'overlays',
        available_for: ['ECMWF_ENS', 'NSSL_GEFS'],
        data_keys: ['mean_HGT_pres_500'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.mean_HGT_pres_500.renderCPU();
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.data, grid.ni, grid.nj));
            const cntr  = new apgl.Contour(hghtSmth, {
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
    '500mb_hght_purple_mean': {
        label: '[MN] 500 mb Hght (Purple; ∆z=60m)',
        title: 'Valid: {valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  F{fhr3} {source} Mean 500mb Heights (Purple)',
        group: 'overlays',
        available_for: ['ECMWF_ENS', 'NSSL_GEFS'],
        data_keys: ['mean_HGT_pres_500'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght = data.mean_HGT_pres_500.renderCPU();
            const hghtSmth = new apgl.RawScalarField(grid, smooth2D(hght.data, grid.ni, grid.nj));
            const cntr  = new apgl.Contour(hghtSmth, {
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
};
