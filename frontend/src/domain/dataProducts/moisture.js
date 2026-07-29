// Products group: MOISTURE
// Analogous to the "moisture" group entries in NMAP2's mod_res.tbl
// Covers: dewpoint

import COLORMAPS from '../../config/colormaps.js';
import { smooth2D } from './utils.js';

export default {

    'sfc_dwpt_fill': {
        label: '2 m Dewpoint (Filled)',
        group: 'moisture',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['dwpk_2m'],
        make_layers(data, grid) {
            const field = data.dwpk_2m.subtract(273.15).multiply(9/5).add(32);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_td2m'], opacity: 0.5 });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_td2m'], {
                label: '2 m Dewpoint (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80]
            });
            return {
                layers: [new apgl.PlotLayer('d2m_fill', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ dwpk_2m: field.sampleField(lon, lat) }),
            };
        },
    },

    'sfc_dwpt_contour': {
        label: '2 m Dewpoint (Contour)',
        group: 'moisture',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['dwpk_2m'],
        make_layers(data, grid) {
            const field = data.dwpk_2m.subtract(273.15).multiply(9/5).add(32);
            const fieldSmth = new apgl.RawScalarField(grid, smooth2D(field.renderCPU().data, grid.ni, grid.nj));
           
            const levels = [40.01,45.01,50.01,55.01,60.01,65.01,70.01,75.01,80.01,85.01];
            //const levels = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85];
            const dwpfCntr  = new apgl.Contour(fieldSmth, {
                levels: levels, cmap: COLORMAPS['pw_td2m'],
                line_width: 2, line_style: '-',
            });
            const cntr_lbls  = new apgl.ContourLabels(dwpfCntr, {
                cmap: COLORMAPS['pw_td2m'], halo: true, halo_color: '#000000', fontface: 'Trebuchet MS',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf', label_formatter: val => Math.round(val).toString(),
                font_size: 14
            });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_td2m'], {
                label: '2 m Dewpoint (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80]
            });
            return {
                layers: [new apgl.PlotLayer('d2m_contour', dwpfCntr), new apgl.PlotLayer('d2m_labels', cntr_lbls)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ dwpk_2m: field.sampleField(lon, lat) }),
            };
        },
    },

};
