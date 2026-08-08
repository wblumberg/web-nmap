// Products group: INSTABILITY
// Covers: CAPE, CIN, LI, STP, SCP, EHI, etc.

import COLORMAPS from '../../config/colormaps.js';
import { smooth2D } from './utils.js';

export default {

    'mlcape_fill': {
        label: 'MLCAPE (Filled)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Mixed-Layer CAPE [J kg⁻¹]',
        group: 'instability',
        available_for: ['MESOANALYSIS_GRID'],
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
            //const field = data.mlcape;
            const field = new apgl.RawScalarField(grid, data.mlcape.data.map(v => Math.max(v, 0)));
            // console.warn('[mlcape_fill] RawScalarField created:', field);

            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            // console.warn('[mlcape_fill] ContourFill created:', fill);

            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'CAPE [J kg⁻¹]',
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

    'mlcin_lt50_hatched': {
        label: '[TEST] MLCIN < -50 (Hatched)',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Mixed-Layer CIN < -50 J kg⁻¹',
        group: 'instability',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['mlcin'],
        make_layers(data, grid) {
            const field = data.mlcin?.grid
                ? data.mlcin
                : new apgl.RawScalarField(grid, data.mlcin.data);

            // Keep the underlying field transparent; only the requested CIN
            // interval is visible through the procedural hatch overlay.
            const transparent = new apgl.ColorMap(
                [-10000, 10000],
                ['#00000000'],
                {underflow_color: '#00000000', overflow_color: '#00000000'},
            );
            const fill = new apgl.ContourFill(field, {
                cmap: transparent,
                patterns: [{
                    range: [-Infinity, -50],
                    type: 'hatch',
                    color: '#6f42c1',
                    opacity: 0.9,
                    spacing: 9,
                    width: 1.5,
                    angle: 45,
                }],
            });

            return {
                layers: [new apgl.PlotLayer('mlcin_lt50_hatched', fill)],
                colorbar: [],
                sampler: (lon, lat) => ({ mlcin: field.sampleField(lon, lat) }),
            };
        },
    },

    'mlcape_contour': {
        label: 'MLCAPE',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Mixed-Layer CAPE [J kg⁻¹]',
        group: 'instability',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['mlcape'],
        make_layers(data, grid) {
            const cape = new apgl.RawScalarField(grid, smooth2D(data.mlcape.data, grid.ni, grid.nj));
            //const cin = new apgl.RawScalarField(grid, data.mlcin.data.map(v => Math.max(v, 0)));
            //                1    2    3   4     5     6     7     8     9     10    11    12    13    14
            const levels = [100.01, 250.01, 500.01, 1000.01, 1500.01, 2000.01, 2500.01, 3000.01, 3500.01, 4000.01, 4500.01, 5000.01, 5500.01, 6000.01];
            const colors = ['#FFB6C1', '#FFB6C1',  '#e83a4b', '#e83a4b', '#e83a4b', '#e83a4b', '#9c222e', '#9c222e', '#9c222e', '#b83c8f', '#b83c8f', '#b83c8f', '#b83c8f'];
            
            const cb = new apgl.ColorMap(levels, colors);
            const contour  = new apgl.Contour(cape, { cmap: cb, opacity: 1, line_width: level => level < 1000 ? 1.0 : 2.5, levels: levels });
    
            const cape_lbls  = new apgl.ContourLabels(contour, {
                cmap: cb, halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf', label_formatter: val => Math.round(val).toString(),
            });

            return {
                layers: [new apgl.PlotLayer('mlcape_contour', contour), new apgl.PlotLayer('mlcape_labels', cape_lbls)],
                colorbar: [],
                sampler: null,
            };
        },
    },


    'sbcape_contour': {
        label: 'SBCAPE',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Surface-Based CAPE [J kg⁻¹]',
        group: 'instability',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['sbcape'],
        make_layers(data, grid) {
            const cape = new apgl.RawScalarField(grid, smooth2D(data.sbcape.data, grid.ni, grid.nj));
            //const cin = new apgl.RawScalarField(grid, data.mlcin.data.map(v => Math.max(v, 0)));
            //                1    2    3   4     5     6     7     8     9     10    11    12    13    14
            const levels = [100.01, 250.01, 500.01, 1000.01, 1500.01, 2000.01, 2500.01, 3000.01, 3500.01, 4000.01, 4500.01, 5000.01, 5500.01, 6000.01];
            const colors = ['#FFB6C1', '#FFB6C1',  '#e83a4b', '#e83a4b', '#e83a4b', '#e83a4b', '#9c222e', '#9c222e', '#9c222e', '#b83c8f', '#b83c8f', '#b83c8f', '#b83c8f'];
            
            const cb = new apgl.ColorMap(levels, colors);
            const contour  = new apgl.Contour(cape, { cmap: cb, opacity: 1, line_width: level => level < 1000 ? 1.0 : 2.5, levels: levels });
            const cape_lbls  = new apgl.ContourLabels(contour, {
                cmap: cb, halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf', label_formatter: val => Math.round(val).toString(),
            });

            return {
                layers: [new apgl.PlotLayer('sbcape_contour', contour), new apgl.PlotLayer('sbcape_labels', cape_lbls)],
                colorbar: [],
                sampler: null,
            };
        },
    },


    'mucape_contour': {
        label: 'MUCAPE',
        title: '{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  Mesoanalysis Most-Unstable CAPE [J kg⁻¹]',
        group: 'instability',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['mucape'],
        make_layers(data, grid) {
            const cape = new apgl.RawScalarField(grid, smooth2D(data.mucape.data, grid.ni, grid.nj));
            //const cin = new apgl.RawScalarField(grid, data.mlcin.data.map(v => Math.max(v, 0)));
            //                1    2    3   4     5     6     7     8     9     10    11    12    13    14
            const levels = [100.01, 250.01, 500.01, 1000.01, 1500.01, 2000.01, 2500.01, 3000.01, 3500.01, 4000.01, 4500.01, 5000.01, 5500.01, 6000.01];
            const colors = ['#FFB6C1', '#FFB6C1',  '#e83a4b', '#e83a4b', '#e83a4b', '#e83a4b', '#9c222e', '#9c222e', '#9c222e', '#b83c8f', '#b83c8f', '#b83c8f', '#b83c8f'];
            
            const cb = new apgl.ColorMap(levels, colors);
            const contour  = new apgl.Contour(cape, { cmap: cb, opacity: 1, line_width: level => level < 1000 ? 1.0 : 2.5, levels: levels });
            const cape_lbls  = new apgl.ContourLabels(contour, {
                cmap: cb, halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf', label_formatter: val => Math.round(val).toString(),
            });

            return {
                layers: [new apgl.PlotLayer('mucape_contour', contour), new apgl.PlotLayer('mucape_labels', cape_lbls)],
                colorbar: [],
                sampler: null,
            };
        },
    },

    'sbcape_fill': {
        label: '[MN] SBCAPE (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Mean SBCAPE [J kg⁻¹]',
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
            const field = data.mean_CAPE;
            // console.warn('[mlcape_fill] RawScalarField created:', field);

            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            // console.warn('[mlcape_fill] ContourFill created:', fill);

            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'CAPE [J kg⁻¹]',
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


    'cape_gt1000_prob': {
        label: '[PR] MLCAPE > 1000 (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Probability of MLCAPE > 1000 J kg⁻¹',
        group: 'instability',
        available_for: ['NSSL_GEFS'],
        data_keys: ['prob_MLCAPE_gt1000'],
        make_layers(data, grid) {
            // Try expected key first; add aliases if backend naming differs.
            const field =
                data?.prob_MLCAPE_gt1000 ??
                data?.prob_mlcape_gt1000 ??
                data?.MLCAPE_prob_gt1000;

            if (!field || !field.grid) {
                console.warn('[cape_gt1000_prob] Missing/invalid field for ContourFill', {
                    keys: Object.keys(data ?? {}),
                    hasField: !!field,
                    hasGrid: !!field?.grid,
                });
                return {
                    layers: [],
                    colorbar: [],
                    sampler: () => ({ prob_MLCAPE_gt1000: null }),
                };
            }

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['yrp_prob'] });
            const svg = apgl.makeColorBar(COLORMAPS['yrp_prob'], {
                label: 'Probability [%]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('mlcape_gt1000_prob', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ prob_MLCAPE_gt1000: field.sampleField(lon, lat) }),
            };
        },
    },

    'cape_gt2000_prob': {
        label: '[PR] MLCAPE > 2000 (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Probability of MLCAPE > 2000 J kg⁻¹',
        group: 'instability',
        available_for: ['NSSL_GEFS'],
        data_keys: ['prob_MLCAPE_gt2000'],
        make_layers(data, grid) {
            // Try expected key first; add aliases if backend naming differs.
            const field =
                data?.prob_MLCAPE_gt2000 ??
                data?.prob_mlcape_gt2000 ??
                data?.MLCAPE_prob_gt2000;

            if (!field || !field.grid) {
                console.warn('[cape_gt2000_prob] Missing/invalid field for ContourFill', {
                    keys: Object.keys(data ?? {}),
                    hasField: !!field,
                    hasGrid: !!field?.grid,
                });
                return {
                    layers: [],
                    colorbar: [],
                    sampler: () => ({ prob_MLCAPE_gt2000: null }),
                };
            }

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['yrp_prob'] });
            const svg = apgl.makeColorBar(COLORMAPS['yrp_prob'], {
                label: 'Probability [%]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('mlcape_gt2000_prob', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ prob_MLCAPE_gt2000: field.sampleField(lon, lat) }),
            };
        },
    },


    'cape_gt3000_prob': {
        label: '[PR] MLCAPE > 3000 (Filled)',
        title: '{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  Probability of MLCAPE > 3000 J kg⁻¹',
        group: 'instability',
        available_for: ['NSSL_GEFS'],
        data_keys: ['prob_MLCAPE_gt3000'],
        make_layers(data, grid) {
            // Try expected key first; add aliases if backend naming differs.
            const field =
                data?.prob_MLCAPE_gt3000 ??
                data?.prob_mlcape_gt3000 ??
                data?.MLCAPE_prob_gt3000;

            if (!field || !field.grid) {
                console.warn('[cape_gt3000_prob] Missing/invalid field for ContourFill', {
                    keys: Object.keys(data ?? {}),
                    hasField: !!field,
                    hasGrid: !!field?.grid,
                });
                return {
                    layers: [],
                    colorbar: [],
                    sampler: () => ({ prob_MLCAPE_gt3000: null }),
                };
            }

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['yrp_prob'] });
            const svg = apgl.makeColorBar(COLORMAPS['yrp_prob'], {
                label: 'Probability [%]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('mlcape_gt3000_prob', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ prob_MLCAPE_gt3000: field.sampleField(lon, lat) }),
            };
        },
    },
};
