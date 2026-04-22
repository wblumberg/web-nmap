import COLORMAPS from '../../config/colormaps.js';

export default {
    'stp_prob': {
        label: 'Probability of STP > 1 (Filled)',
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

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['blues_prob'] });
            const svg = apgl.makeColorBar(COLORMAPS['blues_prob'], {
                label: 'Probability of STP > 1 [%]',
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
        label: 'Probability of SCP > 1 (Filled)',
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

            const fill = new apgl.ContourFill(field, { cmap: COLORMAPS['blues_prob'] });
            const svg = apgl.makeColorBar(COLORMAPS['blues_prob'], {
                label: 'Probability of SCP > 1 [%]',
                orientation: 'horizontal',
                tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });

            return {
                layers: [new apgl.PlotLayer('scp_fill', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ prob_SCP_gt1: field.sampleField(lon, lat) }),
            };
        },
    },
};