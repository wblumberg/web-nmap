// Products group: BASIC
// Analogous to the "basic" group entries in NMAP2's mod_res.tbl
// Covers: temperature, dewpoint, heights, winds

import COLORMAPS from '../../config/colormaps.js';

export default {

    'href_pb_cref40': {
        label: '[PB] CREF > 40 dBZ',
        group: 'storm_attributes',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  Paintball Composite Reflectivity > 40 dBZ',
        available_for: ['HREF'],
        data_keys: ['paintball_REFC_gt40', 'prob_MAXREF_hght_1000_max_4h_gt40_4h_40km'],
        make_layers(data, grid) {
            // Plot the neighborhood probabilities
            const nh_prob_field = data.prob_MAXREF_hght_1000_max_4h_gt40_4h_40km;
            const nh_prob_contour = new apgl.Contour(nh_prob_field, {'levels': [10, 30, 50, 70, 90], 'color': '#a2a54e'});
            // Draw the contour labels
            const labels = new apgl.ContourLabels(nh_prob_contour, {text_color: '#ffffff', halo: true, 
                                                            label_formatter: val => Math.round(val).toString(),
                                                            font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf'})

            // Set up colors for paintball plot
            const href_pb_colors = ['#9d4c1c', '#f2b368', '#792394', '#d99cf9', '#1e3293', '#aabee3', '#bc373b', '#f0928f', '#397d21', '#b5f0ab'];

            // Set up paintball field
            const pb_field = data.paintball_REFC_gt40;
            const paintball = new apgl.Paintball(pb_field, {'colors': [...href_pb_colors].reverse()});
            
            // Create paintball key
            const svg = apgl.makePaintballKey(href_pb_colors,
                                            ['HRRR', 'HRRR -6h', 'HRW ARW', 'HRW ARW -12h', 'HRW FV3', 'HRW FV3 -12h', 'HRW NSSL', 'HRW NSSL -12h', 'NAM 3k', 'NAM 3k -12h'],
                                            {n_cols: 5});
            return {
                layers: [
                    new apgl.PlotLayer('nh_probs', nh_prob_contour),
                    new apgl.PlotLayer('nh_prob_labels', labels),
                    new apgl.PlotLayer('paintball', paintball),
                ],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

    'href_pb_bref40': {
        label: '[PB] BREF > 40 dBZ',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  Paintball Base Reflectivity > 40 dBZ',
        group: 'storm_attributes',
        available_for: ['HREF'],
        data_keys: ['paintball_REFD_hght_1000_gt40'],
        make_layers(data, grid) {
        
            // Set up colors for paintball plot
            const href_pb_colors = ['#9d4c1c', '#f2b368', '#792394', '#d99cf9', '#1e3293', '#aabee3', '#bc373b', '#f0928f', '#397d21', '#b5f0ab'];

            // Set up paintball field
            const pb_field = data.paintball_REFD_hght_1000_gt40;
            const paintball = new apgl.Paintball(pb_field, {'colors': [...href_pb_colors].reverse()});
            
            // Create paintball key
            const svg = apgl.makePaintballKey(href_pb_colors,
                                            ['HRRR', 'HRRR -6h', 'HRW ARW', 'HRW ARW -12h', 'HRW FV3', 'HRW FV3 -12h', 'HRW NSSL', 'HRW NSSL -12h', 'NAM 3k', 'NAM 3k -12h'],
                                            {n_cols: 5});
            return {
                layers: [
                    new apgl.PlotLayer('paintball', paintball),
                ],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

    'href_pb_uh75': {
        label: '[PB] 4 hr 2-5 km UH>75 m²/s²',
        group: 'storm_attributes',
        available_for: ['HREF'],
        data_keys: ['paintball_MXUPHL_hght_5000_2000_max_4h_gt75'],
        make_layers(data, grid) {
        
            // Set up colors for paintball plot
            const href_pb_colors = ['#9d4c1c', '#f2b368', '#792394', '#d99cf9', '#1e3293', '#aabee3', '#bc373b', '#f0928f', '#397d21', '#b5f0ab'];

            // Set up paintball field
            const pb_field = data.paintball_MXUPHL_hght_5000_2000_max_4h_gt75;
            const paintball = new apgl.Paintball(pb_field, {'colors': [...href_pb_colors].reverse()});
            
            // Create paintball key
            const svg = apgl.makePaintballKey(href_pb_colors,
                                            ['HRRR', 'HRRR -6h', 'HRW ARW', 'HRW ARW -12h', 'HRW FV3', 'HRW FV3 -12h', 'HRW NSSL', 'HRW NSSL -12h', 'NAM 3k', 'NAM 3k -12h'],
                                            {n_cols: 5});
            return {
                layers: [
                    new apgl.PlotLayer('paintball', paintball),
                ],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

'href_4h_ensemble_max_25uh_np75': {
        label: '[MX, NP] 4h 2-5 km UH & NP >75 m²/s²',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  4h Ensemble Max 2-5 km UH & 40-km Neighborhood Prob. of UH>75 m²/s²',
        group: 'storm_attributes',
        available_for: ['HREF'],
        data_keys: ['max4h_MXUPHL_hght_5000_2000_max_4h', 'prob_MXUPHL_hght_5000_2000_max_4h_gt75_4h_40km'],
        make_layers(data, grid) {
            // Plot the neighborhood probabilities
            const nh_prob_field = data.prob_MXUPHL_hght_5000_2000_max_4h_gt75_4h_40km;
            const nh_prob_contour = new apgl.Contour(nh_prob_field, {'levels': [10, 30, 50, 70, 90], 'color': '#e52b1a', line_width: 3});
            // Draw the contour labels
            const labels = new apgl.ContourLabels(nh_prob_contour, {text_color: '#e52b1a', halo: true, font_size: 16, halo_color: '#1f1c1c',
                                                            label_formatter: val => Math.round(val).toString(),
                                                            font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf'})

            // Set up paintball field
            const ensmax_field = data.max4h_MXUPHL_hght_5000_2000_max_4h;
            const fill  = new apgl.ContourFill(ensmax_field, { cmap: COLORMAPS['pw_uh'] });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_uh'], {
                label: '4h Ensemble Max 2-5 km Updraft Helicity (m²/s²)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400]
            });
            
            return {
                layers: [
                    new apgl.PlotLayer('ensmax_fill', fill),
                    new apgl.PlotLayer('nh_probs', nh_prob_contour),
                    new apgl.PlotLayer('nh_prob_labels', labels),
                ],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

'href_4h_ensemble_max_25uh_np150': {
        label: '[MX, NP] 4h 2-5 km UH & NP >150 m²/s²',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  4h Ensemble Max 2-5 km UH & 40-km Neighborhood Prob. of UH>150 m²/s²',
        group: 'storm_attributes',
        available_for: ['HREF'],
        data_keys: ['max4h_MXUPHL_hght_5000_2000_max_4h', 'prob_MXUPHL_hght_5000_2000_max_4h_gt150_4h_40km'],
        make_layers(data, grid) {
            // Plot the neighborhood probabilities
            const nh_prob_field = data.prob_MXUPHL_hght_5000_2000_max_4h_gt150_4h_40km;
            const nh_prob_contour = new apgl.Contour(nh_prob_field, {'levels': [10, 30, 50, 70, 90], 'color': '#e52b1a', line_width: 3});
            // Draw the contour labels
            const labels = new apgl.ContourLabels(nh_prob_contour, {text_color: '#e52b1a', halo: true, font_size: 16, halo_color: '#1f1c1c',
                                label_formatter: val => Math.round(val).toString(),
                                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf'})

            // Set up paintball field
            const ensmax_field = data.max4h_MXUPHL_hght_5000_2000_max_4h;
            const fill  = new apgl.ContourFill(ensmax_field, { cmap: COLORMAPS['pw_uh'] } );
            const svg   = apgl.makeColorBar(COLORMAPS['pw_uh'], {
                label: 'Updraft Helicity (m²/s²)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [0, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400]
            });
            
            return {
                layers: [
                    new apgl.PlotLayer('ensmax_fill', fill),
                    new apgl.PlotLayer('nh_probs', nh_prob_contour),
                    new apgl.PlotLayer('nh_prob_labels', labels),
                ],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

    '1km_refl_and_uh': {
        label: '1-km Refl. and UH',
        group: 'storm_attributes',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  1-km Base Reflectivity & 2-5 km Updraft Helicity > 25 m²/s²',
        available_for: ['NSSL_WRF', "HRRR", 'HRW_ARW', 'HRW_FV3', 'NAM_NEST', 'NSSL_MPAS_RN'],
        data_keys: ['REFD_hght_1000', 'MXUPHL_hght_5000_2000_max_1h'],
        make_layers(data, grid) {

            console.log(data.REFD_hght_1000);
            const reflField = data.REFD_hght_1000;
            const reflValues = reflField?.values ?? reflField?.data ?? reflField;
            let reflMin = Infinity;
            let reflMax = -Infinity;

            if (reflValues && typeof reflValues[Symbol.iterator] === 'function') {
                for (const v of reflValues) {
                    if (Number.isFinite(v)) {
                        if (v < reflMin) reflMin = v;
                        if (v > reflMax) reflMax = v;
                    }
                }
                console.log('REFD_hght_1000 min/max:', reflMin, reflMax);
            } else {
                console.log('REFD_hght_1000 min/max unavailable');
            }

            const fill = new apgl.ContourFill(reflField, { cmap: COLORMAPS['pw_refl'] });
            const contour = new apgl.Contour(data.MXUPHL_hght_5000_2000_max_1h, { levels: [25], color: '#ff00e1', line_width: 2 });

            const svg = apgl.makeColorBar(COLORMAPS['pw_refl'], {
                label: 'Reflectivity [dBZ]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
            });

            return {
                layers: [new apgl.PlotLayer('1km_refl', fill), new apgl.PlotLayer('1km_uh', contour)],
                colorbar: [svg],
                sampler: null,
            };
        },
    },

    'cref': {
        label: 'Composite Reflectivity',
        group: 'storm_attributes',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Composite Reflectivity',
        available_for: ['NSSL_WRF', "HRRR", 'HRW_ARW', 'HRW_FV3', 'NAM_NEST', 'NSSL_MPAS_RN'],
        data_keys: ['REFC'],
        make_layers(data, grid) {

            const fill = new apgl.ContourFill(data.REFC, { cmap: COLORMAPS['pw_refl'] });

            const svg = apgl.makeColorBar(COLORMAPS['pw_refl'], {
                label: 'Reflectivity [dBZ]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70],
            });

            return {
                layers: [new apgl.PlotLayer('cref', fill)],
                colorbar: [svg],
                sampler: null,
            };
        },
    },
};
