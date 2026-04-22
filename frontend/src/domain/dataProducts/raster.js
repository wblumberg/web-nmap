// Products group: RASTER
// Covers: MRMS (multi-sensor QPE, composites), satellite imagery

import COLORMAPS from '../../config/colormaps.js';

export default {

    'mrms_cref': {
        label: 'MRMS Composite Reflectivity',
        group: 'mrms_conus',
        available_for: ['MRMS_CONUS_CREF'],
        data_keys: ['cref', 'ptype_mask'],
        make_layers(data, grid) {
            const field = data.cref;
            const cmaps = [
                COLORMAPS['mrms_cref_rain'],
                COLORMAPS['mrms_cref_snow'],
                COLORMAPS['mrms_cref_ice'],
                COLORMAPS['mrms_cref_frzr'],
            ];
            const raster = new apgl.Raster(field, { cmap: cmaps, cmap_mask: data.ptype_mask.data });
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
            const field = data.CMI;
            const cmaps = COLORMAPS['wv_tpc'];
            const raster = new apgl.Raster(field, { cmap: cmaps });
            return {
                layers: [new apgl.PlotLayer('goes_conus_wv', raster)],
                colorbar: []
            };
        },
    },

    'goes_conus_vis': {
        label: 'GOES CONUS Visible (Channel 2)',
        group: 'goes_conus',
        available_for: ['GOES-E_CONUS_C02'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = data.CMI;
            const cmaps = apgl.colormaps.wv_cimss;
            const raster = new apgl.Raster(field, { cmap: cmaps });
            return {
                layers: [new apgl.PlotLayer('goes_conus_vis', raster)],
                colorbar: []
            };
        },
    },

    'mrms_cref': {
        label: 'MRMS Base Reflectivity QC',
        group: 'mrms_conus',
        available_for: ['MRMS_CONUS_MergedBaseReflectivityQC'],
        data_keys: ['MergedBaseReflectivityQC'],
        make_layers(data, grid) {
            const field = data.MergedBaseReflectivityQC;
            const raster = new apgl.Raster(field, { cmap: COLORMAPS['nws_reflectivity']});

            const cb = apgl.makeColorBar(COLORMAPS['nws_reflectivity'], {
                label: 'Base Reflectivity dBZ',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', 
                ticks: [-20,-10, 0, 10, 20, 30, 40, 50, 60, 70],
            });
            return {
                layers: [new apgl.PlotLayer('mrms_cref', raster)],
                colorbar: [cb],
            };
        },
    },
};
