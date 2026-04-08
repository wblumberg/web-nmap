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
            const field = new apgl.RawScalarField(grid, data.cref);
            const cmaps = [
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
                        label: ['Rain', 'Snow', 'Sleet', 'Freezing Rain'][i] + ' dBZ',
                        orientation: 'horizontal', tick_direction: 'bottom',
                        fontface: 'Trebuchet MS', size_long: 320, size_short: 67,
                        ticks: [10, 20, 30, 40, 50],
                    })
                ),
            };
        },
    },

    'goes_conus_wv': {
        label: 'GOES CONUS Water Vapor (Channel 8)',
        group: 'goes_conus',
        available_for: ['GOES-E_CONUS_C08'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = new apgl.RawScalarField(grid, data.CMI);
            const cmaps = apgl.colormaps.wv_cimss;
            console.log("CMAPS:", cmaps)
            const raster = new apgl.Raster(field, { cmap: cmaps });
            return {
                layers: [new apgl.PlotLayer('goes_conus_wv', raster)],
                colorbar: []
            };
        },
    },

    'goes_vis': {
        label: 'GOES Visible',
        group: 'raster',
        available_for: ['GOESE_VISCH2'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = new apgl.RawScalarField(grid, data.CMI);
            const cmaps = apgl.colormaps.wv_cimss;
            // Use a simple greyscale colormap for visible imagery
            //const greyscale = [];
            ///for (let i = 0; i <= 255; i++) {
            //    const v = i / 255;
            //    greyscale.push([v, v, v, 1]);
            //}
            //const cmaps = greyscale;
            console.log("CMAPS:", cmaps)
            const raster = new apgl.Raster(field, { cmap: cmaps });
            return {
                layers: [new apgl.PlotLayer('goes_vis', raster)],
                colorbar: []
            };
        },
    },
};
