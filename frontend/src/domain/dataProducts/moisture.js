// Products group: MOISTURE
// Analogous to the "moisture" group entries in NMAP2's mod_res.tbl
// Covers: dewpoint

import COLORMAPS from '../../config/colormaps.js';

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

};
