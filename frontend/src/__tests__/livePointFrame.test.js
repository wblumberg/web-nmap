import { describe, expect, it, vi } from 'vitest';

import { fetchLivePointFrame } from '../services/livePointFrame.js';

describe('live point frame reconstruction', () => {
    it('uses a paginated raw range and retains 45-60 minute lightning strikes', async () => {
        const center = new Date('2026-08-13T12:00:00Z');
        const strike = minutes => ({
            coord: {lon: -97, lat: 35},
            valid_time: new Date(center.getTime() - minutes * 60_000).toISOString(),
            data: {polarity: '-'},
        });
        const fetchRange = vi.fn().mockResolvedValue({
            obs_json: [strike(2), strike(50), strike(61)],
            meta: {
                binflag: 'true', before_minutes: '60', after_minutes: '0', return_age: 'true',
            },
        });

        const result = await fetchLivePointFrame({
            sourceId: 'LIGHTNING',
            frameKey: '20260813_1200',
            centerTime: center,
            dataKeys: ['age_minutes', 'polarity'],
            pointPolicy: {binflag: true, before_minutes: 60, after_minutes: 0, return_age: true},
            productSuite: {
                point_range_page_size: 100000,
                point_range_paginate: true,
                cache_live_point_ranges: false,
            },
            queryParams: {},
            fetchRange,
        });

        expect(fetchRange).toHaveBeenCalledWith(
            'LIGHTNING',
            ['age_minutes', 'polarity'],
            new Date('2026-08-13T11:00:00Z'),
            center,
            expect.objectContaining({limit: 100000, paginate: true, cache: false}),
        );
        expect(result.data.obs_json).toHaveLength(2);
        expect([...result.data.obs_time_ms]).toEqual([
            center.getTime() - 50 * 60_000,
            center.getTime() - 2 * 60_000,
        ]);
    });
});
