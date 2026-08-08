import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/colormaps.js', () => ({ default: {} }));
vi.mock('autumnplot-gl', () => ({ colormaps: {} }));

import pointProducts from '../domain/dataProducts/point.js';

describe('lightning product range loading', () => {
    it('paginates long strike-by-age loops so early frames keep their lookback window', () => {
        const product = pointProducts.strikes_by_age;

        expect(product.point_range_paginate).toBe(true);
        expect(product.point_range_page_size).toBe(100000);
    });
});
