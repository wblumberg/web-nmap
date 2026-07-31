// Products group: RASTER
// Covers: MRMS (multi-sensor QPE, composites), satellite imagery

import COLORMAPS from '../../config/colormaps.js';

export default {

    'mrms_cref': {
        label: 'MRMS Composite Reflectivity',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  MRMS Composite Reflectivity',
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


    'goese_conus_vis': {
        label: 'Ch 02: Visible [0.64 µm]',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  GOES-East CONUS Visible [0.64 µm]',
        group: 'goes_conus',
        available_for: ['GOES-E_CONUS_C02'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = data.CMI;

            // CMI is uint16 (0–65535). Matplotlib shows clouds at low values and
            // ground at high values, so map low → white and high → dark (linear).
            const N = 257;  // 257 levels → 256 color bins
            const levels = Array.from({ length: N }, (_, i) =>
                Math.round(i * (65535) / (N - 1))
            );
            const colors = Array.from({ length: N - 1 }, (_, i) => {
                const gray = Math.round((1 - i / (N - 2)) * 255);  // white→black
                const hex = gray.toString(16).padStart(2, '0');
                return `#${hex}${hex}${hex}`;
            });
            const cmaps = new apgl.ColorMap(levels, colors.slice().reverse());
            const raster = new apgl.Raster(field, { cmap: cmaps });
            return {
                layers: [new apgl.PlotLayer('goes_conus_vis', raster)],
                colorbar: []
            };
        },
    },

    'goese_conus_wv': {
        label: 'Ch 08: Upper-Level WV [6.2 µm]',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  GOES-East CONUS Upper-Level Water Vapor [6.2 µm]',
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

    'goese_conus_ir': {
        label: 'Ch 13: Clean IR [10.7 µm]',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  GOES-East CONUS Clean IR [10.7 µm]',
        group: 'goes_conus',
        available_for: ['GOES-E_CONUS_C13'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = data.CMI.subtract(273.15).renderCPU();  // convert K → °C for more intuitive colormap
            const cmaps = COLORMAPS['satellite_ir_winter'];
            const raster = new apgl.Raster(field, { cmap: cmaps });
            const svg = apgl.makeColorBar(cmaps, {
                label: 'Brightness Temperature (°C)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', ticks: [0,50],
            });
            return {
                layers: [new apgl.PlotLayer('goes_conus_ir', raster)],
                colorbar: [svg]
            };
        },
    },


    'goesw_conus_vis': {
        label: 'Ch 02: Visible [0.64 µm]',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  GOES-West CONUS Visible [0.64 µm]',
        group: 'goes_conus',
        available_for: ['GOES-W_CONUS_C02'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = data.CMI;

            // CMI is uint16 (0–65535). Matplotlib shows clouds at low values and
            // ground at high values, so map low → white and high → dark (linear).
            const N = 257;  // 257 levels → 256 color bins
            const levels = Array.from({ length: N }, (_, i) =>
                Math.round(i * (65535) / (N - 1))
            );
            const colors = Array.from({ length: N - 1 }, (_, i) => {
                const gray = Math.round((1 - i / (N - 2)) * 255);  // white→black
                const hex = gray.toString(16).padStart(2, '0');
                return `#${hex}${hex}${hex}`;
            });
            const cmaps = new apgl.ColorMap(levels, colors.slice().reverse());
            const raster = new apgl.Raster(field, { cmap: cmaps });
            return {
                layers: [new apgl.PlotLayer('goes_conus_vis', raster)],
                colorbar: []
            };
        },
    },

    'goesw_conus_wv': {
        label: 'Ch 08: Upper-Level WV [6.2 µm]',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  GOES-West CONUS Upper-Level Water Vapor [6.2 µm]',
        group: 'goes_conus',
        available_for: ['GOES-W_CONUS_C08'],
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

    'goesw_conus_ir': {
        label: 'Ch 13: Clean IR [10.7 µm]',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  GOES-West CONUS Clean IR [10.7 µm]',
        group: 'goes_conus',
        available_for: ['GOES-W_CONUS_C13'],
        data_keys: ['CMI'],
        make_layers(data, grid) {
            const field = data.CMI.subtract(273.15).renderCPU();  // convert K → °C for more intuitive colormap
            const cmaps = COLORMAPS['satellite_ir_winter'];
            const raster = new apgl.Raster(field, { cmap: cmaps });
            const svg = apgl.makeColorBar(cmaps, {
                label: 'Brightness Temperature (°C)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', ticks: [0,50],
            });
            return {
                layers: [new apgl.PlotLayer('goes_conus_ir', raster)],
                colorbar: [svg]
            };
        },
    },


    'mrms_base_refl_qc': {
        label: 'MRMS Base Reflectivity QC',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  MRMS Merged Base Reflectivity QC',
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

    'mrms_base_refl_qc_gray': {
        label: 'MRMS Base Reflectivity QC (Grayscale)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  MRMS Merged Base Reflectivity QC',
        group: 'mrms_conus',
        available_for: ['MRMS_CONUS_MergedBaseReflectivityQC'],
        data_keys: ['MergedBaseReflectivityQC'],
        make_layers(data, grid) {
            const field = data.MergedBaseReflectivityQC;
            const levels = [-20,-15,-10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70];
            const colors = ['#0a0a0a', '#141414', '#1f1f1f', '#2b2b2b', '#373737', '#444444', '#515151', '#5f5f5f', '#6d6d6d', '#7c7c7c', '#8b8b8b', '#9b9b9b', '#ababab', '#bcbcbc', '#cecece', '#e0e0e0', '#f0f0f0', '#fafafa'];
            const cb = new apgl.ColorMap(levels, colors);
            const raster = new apgl.Raster(field, { cmap: cb });

            const colorbar = apgl.makeColorBar(cb, {
                label: 'Base Reflectivity dBZ',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS', 
                ticks: [-20,-10, 0, 10, 20, 30, 40, 50, 60, 70],
            });
            return {
                layers: [new apgl.PlotLayer('mrms_cref_gray', raster)],
                colorbar: [colorbar],
            };
        },
    },
};
