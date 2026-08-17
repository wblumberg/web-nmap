import {
    buildPointFrames,
    normalizePointPolicy,
    pointRangeForFrames,
} from '../domain/pointFrames.js';
import { fetchLightningAgeFrameInWorker, fetchLightningAgeFramesInWorker } from './lightningAgeWorkerClient.js';

export { fetchLightningAgeFramesInWorker };

/** Fetch and reconstruct one live point frame with the same policy as bulk loop loading. */
export async function fetchLivePointFrame({
    sourceId,
    frameKey,
    centerTime,
    dataKeys,
    pointPolicy,
    productSuite,
    queryParams,
    fetchRange,
}) {
    const centerMs = centerTime instanceof Date ? centerTime.getTime() : Number(centerTime);
    const frameSpecs = [{frameKey, centerMs}];
    const requestPolicy = normalizePointPolicy(pointPolicy);
    const range = pointRangeForFrames(frameSpecs, requestPolicy);
    if (productSuite.live_point_worker === 'lightning-age') {
        try {
            return await fetchLightningAgeFrameInWorker({
                sourceId,
                fields: dataKeys,
                startIso: new Date(range.startMs).toISOString(),
                endIso: new Date(range.endMs).toISOString(),
                centerMs,
                frameSpecs,
                beforeMinutes: requestPolicy.beforeMinutes,
                afterMinutes: requestPolicy.afterMinutes,
                binflag: requestPolicy.binflag,
                queryParams,
                limit: productSuite.point_range_page_size ?? productSuite.point_range_limit,
                paginate: productSuite.point_range_paginate === true,
            });
        } catch (error) {
            // Preserve the established path in browsers where module workers
            // are unavailable or if worker initialization unexpectedly fails.
            console.warn('[NMAP] Lightning worker failed; using main-thread point reconstruction:', error.message);
        }
    }
    const result = await fetchRange(
        sourceId,
        dataKeys,
        new Date(range.startMs),
        new Date(range.endMs),
        {
            queryParams,
            limit: productSuite.point_range_page_size ?? productSuite.point_range_limit,
            paginate: productSuite.point_range_paginate === true,
            cache: productSuite.cache_live_point_ranges !== false,
        },
    );
    const responsePolicy = normalizePointPolicy({
        ...pointPolicy,
        ...(result.meta || {}),
    });
    return {
        data: buildPointFrames(result.obs_json, frameSpecs, responsePolicy).get(frameKey),
        meta: result.meta || {},
    };
}
