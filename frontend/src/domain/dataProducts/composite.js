import COLORMAPS from '../../config/colormaps.js';
import { smooth2D } from './utils.js';

export default {

    'eff_shear_and_mlcape': {
        label: 'Eff. Shear & MLCAPE',
        group: 'composite',
        available_for: ['MESOANALYSIS_GRID'],
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Effective Bulk Wind Difference [kts] & Mixed-Layer CAPE [J kg⁻¹]',
        data_keys: ['ebwdu', 'ebwdv', 'mlcape'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const u = data.ebwdu.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v = data.ebwdv.multiply(1.94384).renderCPU(); // Convert from m/s to knots

            const wspd = apgl.RawScalarField.aggregateFields(Math.hypot, u, v).renderCPU();
            // Detect missing: sentinel -9999 m/s becomes ~-19439 kt after conversion; hypot of two
            // such values yields ~27490 kt — not -9999 — so mask from u/v directly.
            const missing_mask = u.data.map((val, i) => val < -9000 || v.data[i] < -9000);
            const wspdMasked = wspd.data.map((val, i) => missing_mask[i] ? NaN : val);

            const wspd_mask = wspdMasked.map(val => val >= 20); // Mask values below 20 knots
            const u_masked = new apgl.RawScalarField(grid, u.data.map((val, i) => wspd_mask[i] ? val : NaN));
            const v_masked = new apgl.RawScalarField(grid, v.data.map((val, i) => wspd_mask[i] ? val : NaN));

            const wind = new apgl.RawVectorField(grid, u_masked.data, v_masked.data, { relative_to: 'earth' });

            const shear_cmap = new apgl.ColorMap(
                [20, 30, 40, 50, 60],
                ['#a1a9bd', '#91a5bc', '#7594c0', '#6974c8'],
                { overflow_color:  '#5b5bbb' , underflow_color: '#ffffff' }
            );
            
            const barbs = new apgl.Barbs(wind, { cmap: shear_cmap, thin_fac: 16 });

            const shear_cbar = apgl.makeColorBar(shear_cmap, {
                label: 'Effective Bulk Wind Difference [kt]', fontface: 'Trebuchet MS',
                ticks: [20, 30, 40, 50, 60],
                orientation: 'horizontal', tick_direction: 'bottom',
            });

            const cape = new apgl.RawScalarField(grid, smooth2D(data.mlcape.data, grid.ni, grid.nj));
            //const cin = new apgl.RawScalarField(grid, data.mlcin.data.map(v => Math.max(v, 0)));
            //                1    2    3   4     5     6     7     8     9     10    11    12    13    14
            const levels = [100, 250, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000];
            const colors = ['#FFB6C1', '#FFB6C1',  '#e83a4b', '#e83a4b', '#e83a4b', '#e83a4b', '#9c222e', '#9c222e', '#9c222e', '#b83c8f', '#b83c8f', '#b83c8f', '#b83c8f'];
            
            const cb = new apgl.ColorMap(levels, colors);
            const contour  = new apgl.Contour(cape, { cmap: cb, opacity: 1, line_width: level => level < 1000 ? 1.0 : 2.5, levels: levels });
    
            const cape_lbls  = new apgl.ContourLabels(contour, {
                text_color: '#aa2f2f', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            return {
                layers: [
                    new apgl.PlotLayer('eff_shear_barbs', barbs),
                    new apgl.PlotLayer('mlcape_contour', contour),
                    new apgl.PlotLayer('mlcape_labels', cape_lbls),

                    //new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                ],
                colorbar: [shear_cbar],
                sampler: [],
            };
        },
    },

    'scp': {
        label: 'Supercell Composite Parameter (Eff.)',
        group: 'composite',
        available_for: ['MESOANALYSIS_GRID'],
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Supercell Composite Parameter (Eff Layer w/ MUCIN)',
        data_keys: ['scpe'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const scpeData = data.scpe.data.map(v => (v === -9999 ? 0 : v));
            const scpe = new apgl.RawScalarField(grid, smooth2D(scpeData, grid.ni, grid.nj));
            //const cin = new apgl.RawScalarField(grid, data.mlcin.data.map(v => Math.max(v, 0)));
            //                1    2    3   4     5     6     7     8     9     10    11    12    13    14
            const levels = [0.5,1,2,4,6,8,10,12,15,20];
            const colors = ['#FFB6C1', '#FFB6C1',  '#e83a4b', '#e83a4b', '#9c222e', '#b83c8f', '#b83c8f', '#b83c8f', '#b83c8f'];
            
            const cb = new apgl.ColorMap(levels, colors);
            const contour  = new apgl.Contour(scpe, { cmap: cb, opacity: 1, line_width: level => level < 2 ? 1.0 : 2.5, levels: levels });
    
            const scpe_lbls  = new apgl.ContourLabels(contour, {
                text_color: '#aa2f2f', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            return {
                layers: [
                    new apgl.PlotLayer('scpe_contour', contour),
                    new apgl.PlotLayer('scpe_labels', scpe_lbls),

                    //new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                ],
                colorbar: [],
                sampler: [],
            };
        },
    },


    'stp': {
        label: 'Significant Tornado Parameter (Eff.)',
        group: 'composite',
        available_for: ['MESOANALYSIS_GRID'],
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Significant Tornado Parameter (Eff Layer w/ MUCIN)',
        data_keys: ['stpe'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const stpeData = data.stpe.data.map(v => (v === -9999 ? 0 : v));
            const stpe = new apgl.RawScalarField(grid, smooth2D(stpeData, grid.ni, grid.nj));
            //const cin = new apgl.RawScalarField(grid, data.mlcin.data.map(v => Math.max(v, 0)));
            //                1    2    3   4     5     6     7     8     9     10    11    12    13    14
            const levels = [0.5,1,2,4,6,8,10,12,15,20];
            const colors = ['#FFB6C1', '#FFB6C1',  '#e83a4b', '#e83a4b', '#9c222e', '#b83c8f', '#b83c8f', '#b83c8f', '#b83c8f'];
            
            const cb = new apgl.ColorMap(levels, colors);
            const contour  = new apgl.Contour(stpe, { cmap: cb, opacity: 1, line_width: level => level < 2 ? 1.0 : 2.5, levels: levels });
    
            const stpe_lbls  = new apgl.ContourLabels(contour, {
                text_color: '#aa2f2f', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            return {
                layers: [
                    new apgl.PlotLayer('stpe_contour', contour),
                    new apgl.PlotLayer('stpe_labels', stpe_lbls),

                    //new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                ],
                colorbar: [],
                sampler: [],
            };
        },
    },


    'stp_prob': {
        label: '[PR] STP > 1 (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Probability of STP > 1 (Filled)',
        group: 'composite',
        available_for: ['NSSL_GEFS'],
        data_keys: ['prob_STP_fixed_gt1'],
        make_layers(data, grid) {
            // Try expected key first; add aliases if backend naming differs.
            const field =
                data?.prob_STP_fixed_gt1 ??
                data?.prob_stp_gt1 ??
                data?.STP_prob_gt1;

            if (!field || !field.grid) {
                console.warn('[stp_prob] Missing/invalid field for ContourFill', {
                    keys: Object.keys(data ?? {}),
                    hasField: !!field,
                    hasGrid: !!field?.grid,
                });
                return {
                    layers: [],
                    colorbar: [],
                    sampler: () => ({ prob_STP_gt1: null }),
                };
            }

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['yrp_prob'] });
            const svg = apgl.makeColorBar(COLORMAPS['yrp_prob'], {
                label: 'Probability',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('stp_fill', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ prob_STP_gt1: field.sampleField(lon, lat) }),
            };
        },
    },

    'scp_prob': {
        label: '[PR] SCP-Fixed > 1 (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Probability of SCP-Fixed > 1 (Filled)',
        group: 'composite',
        available_for: ['NSSL_GEFS'],
        data_keys: ['prob_SCP_fixed_gt1'],
        make_layers(data, grid) {
            // Try expected key first; add aliases if backend naming differs.
            const field =
                data?.prob_SCP_fixed_gt1 ??
                data?.prob_scp_gt1 ??
                data?.SCP_prob_gt1;

            if (!field || !field.grid) {
                console.warn('[scp_prob] Missing/invalid field for ContourFill', {
                    keys: Object.keys(data ?? {}),
                    hasField: !!field,
                    hasGrid: !!field?.grid,
                });
                return {
                    layers: [],
                    colorbar: [],
                    sampler: () => ({ prob_SCP_gt1: null }),
                };
            }
            const fieldSmth = new apgl.RawScalarField(grid, smooth2D(field.renderCPU().data, grid.ni, grid.nj));
            const fill = new apgl.ContourFill(fieldSmth, { cmap: COLORMAPS['yrp_prob'] });
            const contour = new apgl.Contour(fieldSmth, { levels: [10,30,50,70,90], color: '#000000', line_width: 2 });
            const contourLabels = new apgl.ContourLabels(contour, {
                text_color: '#000000', halo: true, halo_color: '#ffffff', fontface: 'Trebuchet MS',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const svg = apgl.makeColorBar(COLORMAPS['yrp_prob'], {
                label: 'Probability',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('scp_fill', fill), new apgl.PlotLayer('scp_contour', contour), new apgl.PlotLayer('scp_labels', contourLabels)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ prob_SCP_gt1: field.sampleField(lon, lat) }),
            };
        },
    },

};