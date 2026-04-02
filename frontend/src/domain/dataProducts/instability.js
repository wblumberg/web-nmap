// Products group: INSTABILITY
// Covers: CAPE, CIN, LI, STP, SCP, EHI, etc.

import COLORMAPS from '../../config/colormaps.js';

export default {

    'mlcape_fill': {
        label: 'MLCAPE (Filled)',
        group: 'instability',
        available_for: ['GFS', 'NAM', 'HRRR', 'RAP', 'MESOANALYSIS_GRID'],
        data_keys: ['mlcape'],
        make_layers(data, grid) {
            /* console.warn('[mlcape_fill] make_layers CALLED');
            // console.warn('[mlcape_fill] data keys:', Object.keys(data));
            // console.warn('[mlcape_fill] data.mlcape type:', data.mlcape?.constructor?.name,
                'length:', data.mlcape?.length,
                'first5:', data.mlcape?.slice?.(0,5),
                'isF32:', data.mlcape instanceof Float32Array);
            console.warn('[mlcape_fill] grid:', grid?.constructor?.name, grid);
            console.warn('[mlcape_fill] COLORMAPS.pw_cape:', COLORMAPS['pw_cape']);
            console.warn('[mlcape_fill] typeof apgl:', typeof apgl, '| window.apgl:', typeof window.apgl);
            */
            const field = new apgl.RawScalarField(grid, data.mlcape);
            // console.warn('[mlcape_fill] RawScalarField created:', field);

            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            // console.warn('[mlcape_fill] ContourFill created:', fill);

            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'MLCAPE (J/kg)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', size_long: 600, ticks: [0, 1000, 2000, 3000, 4000, 5000, 6000],
            });
            // console.warn('[mlcape_fill] ColorBar created:', svg);

            const layer = new apgl.PlotLayer('mlcape_fill', fill);
            // console.warn('[mlcape_fill] PlotLayer created:', layer, 'id:', layer.id);

            return {
                layers: [layer],
                colorbar: [svg],
                sampler: (lon, lat) => ({ mlcape: field.sampleField(lon, lat) }),
            };
        },
    },

    'sbcape_fill': {
        label: 'Mean SBCAPE (Filled)',
        group: 'instability',
        available_for: ['HREF'],
        data_keys: ['mean_CAPE'],
        make_layers(data, grid) {
            /* console.warn('[mlcape_fill] make_layers CALLED');
            // console.warn('[mlcape_fill] data keys:', Object.keys(data));
            // console.warn('[mlcape_fill] data.mlcape type:', data.mlcape?.constructor?.name,
                'length:', data.mlcape?.length,
                'first5:', data.mlcape?.slice?.(0,5),
                'isF32:', data.mlcape instanceof Float32Array);
            console.warn('[mlcape_fill] grid:', grid?.constructor?.name, grid);
            console.warn('[mlcape_fill] COLORMAPS.pw_cape:', COLORMAPS['pw_cape']);
            console.warn('[mlcape_fill] typeof apgl:', typeof apgl, '| window.apgl:', typeof window.apgl);
            */
            const field = new apgl.RawScalarField(grid, data.mean_CAPE);
            // console.warn('[mlcape_fill] RawScalarField created:', field);

            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            // console.warn('[mlcape_fill] ContourFill created:', fill);

            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'Mean SBCAPE (J/kg)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', size_long: 600, ticks: [0, 1000, 2000, 3000, 4000, 5000, 6000],
            });
            // console.warn('[mlcape_fill] ColorBar created:', svg);

            const layer = new apgl.PlotLayer('mean_CAPE_fill', fill);
            // console.warn('[mlcape_fill] PlotLayer created:', layer, 'id:', layer.id);

            return {
                layers: [layer],
                colorbar: [svg],
                sampler: (lon, lat) => ({ mean_CAPE: field.sampleField(lon, lat) }),
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
