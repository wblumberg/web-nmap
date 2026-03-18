// Products group: RASTER
// Covers: MRMS (multi-sensor QPE, composites), satellite imagery

import COLORMAPS from '../../config/colormaps.js';

export default {

    'mrms_cref': {
        label: 'MRMS Composite Reflectivity',
        group: 'raster',
        available_for: ['MRMS'],
        data_keys: ['cref', 'ptype_mask'],
        make_layers(data, grid) {
            const field  = new apgl.RawScalarField(grid, data.cref);
            const cmaps  = [
                COLORMAPS['mrms_cref_rain'],
                COLORMAPS['mrms_cref_snow'],
                COLORMAPS['mrms_cref_ice'],
                COLORMAPS['mrms_cref_frzr'],
            ];
            const raster = new apgl.Raster(field, { cmap: cmaps, cmap_mask: data.ptype_mask });
            return {
                layers: [new apgl.PlotLayer('mrms_cref', raster)],
                colorbar: cmaps.map((cm, i) =>
                    apgl.makeColorBar(cm, {
                        label: ['Rain','Snow','Sleet','Freezing Rain'][i] + ' dBZ',
                        orientation: 'horizontal', tick_direction: 'bottom',
                        fontface: 'Trebuchet MS', size_long: 320, size_short: 67,
                        ticks: [10, 20, 30, 40, 50],
                    })
                ),
            };
        },
    },
};
