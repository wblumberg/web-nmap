// Products group: INSTABILITY
// Covers: CAPE, CIN, LI, STP, SCP, EHI, etc.

import COLORMAPS from '../config/colormaps.js';

export default {

    'mlcape_fill': {
        label: 'MLCAPE (Filled)',
        group: 'instability',
        available_for: ['GFS', 'NAM', 'HRRR', 'RAP'],
        data_keys: ['mlcape'],
        make_layers(data, grid) {
            const field = new apgl.RawScalarField(grid, data.mlcape);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'MLCAPE (J/kg)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [new apgl.PlotLayer('mlcape_fill', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ mlcape: field.sampleField(lon, lat) }),
            };
        },
    },

    'stp_fill': {
        label: 'Significant Tornado Parameter (Filled)',
        group: 'instability',
        available_for: ['GFS', 'NAM', 'HRRR', 'RAP'],
        data_keys: ['stp'],
        make_layers(data, grid) {
            const field = new apgl.RawScalarField(grid, data.stp);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['stp'] });
            const cntr  = new apgl.Contour(field, { levels: [1, 2, 4, 6, 8], color: '#ffffff', line_width: 2 });
            const svg   = apgl.makeColorBar(COLORMAPS['stp'], {
                label: 'STP',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [
                    new apgl.PlotLayer('stp_fill', fill),
                    new apgl.PlotLayer('stp_cntr', cntr),
                ],
                colorbar: [svg],
                sampler: (lon, lat) => ({ stp: field.sampleField(lon, lat) }),
            };
        },
    },
};
