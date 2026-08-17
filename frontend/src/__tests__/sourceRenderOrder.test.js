import { describe, expect, it } from 'vitest';

import { orderSourcesForRendering, sourceRenderPriority } from '../domain/sourceRenderOrder.js';

const products = {
    water_vapor: {group: 'goes_conus'},
    heights: {group: 'overlays'},
    vad: {group: 'point'},
    temperature: {group: 'basic'},
};

describe('source render order', () => {
    it('places imagery below contours and point symbols regardless of procedure order', () => {
        const sources = [
            {id: 'MESO', productKey: 'heights', entry: {endpoint_type: 'gridded', data_category: 'gridded_analysis'}},
            {id: 'GOES-E', productKey: 'water_vapor', entry: {endpoint_type: 'gridded', data_category: 'gridded_imagery'}},
            {id: 'VAD', productKey: 'vad', entry: {endpoint_type: 'profile_obs', data_category: 'profile_obs'}},
        ];

        expect(orderSourcesForRendering(sources, products).map(source => source.id))
            .toEqual(['GOES-E', 'MESO', 'VAD']);
    });

    it('preserves procedure order within the same priority tier', () => {
        const sources = [
            {id: 'B', productKey: 'temperature', entry: {endpoint_type: 'gridded'}},
            {id: 'A', productKey: 'temperature', entry: {endpoint_type: 'gridded'}},
        ];
        expect(orderSourcesForRendering(sources, products).map(source => source.id)).toEqual(['B', 'A']);
    });

    it('allows a product to override its priority explicitly', () => {
        expect(sourceRenderPriority(
            {productKey: 'custom', entry: {endpoint_type: 'gridded'}},
            {custom: {render_priority: 450}},
        )).toBe(450);
    });
});
