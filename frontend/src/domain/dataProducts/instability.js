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
            const field = data.mlcape;
            // console.warn('[mlcape_fill] RawScalarField created:', field);

            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            // console.warn('[mlcape_fill] ContourFill created:', fill);

            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'MLCAPE [J kg⁻¹]',
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
            const field = data.mean_CAPE;
            // console.warn('[mlcape_fill] RawScalarField created:', field);

            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_cape'], opacity: 0.85 });
            // console.warn('[mlcape_fill] ContourFill created:', fill);

            const svg   = apgl.makeColorBar(COLORMAPS['pw_cape'], {
                label: 'Mean SBCAPE [J kg⁻¹]',
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
                label: 'Probability of MLCAPE > 1000 J kg⁻¹ [%]',
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
                label: 'Probability of MLCAPE > 2000 J kg⁻¹ [%]',
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
                label: 'Probability of MLCAPE > 3000 J kg⁻¹ [%]',
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
