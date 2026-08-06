import { describe, expect, it } from 'vitest';

import {
    estimateFrameBytes,
    runRollingFramePipeline,
} from '../services/rollingFramePipeline.js';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

describe('runRollingFramePipeline', () => {
    it('replenishes a rolling request slot without waiting for the whole group', async () => {
        const requests = [deferred(), deferred(), deferred()];
        const started = [];
        const prepared = [];

        const pipeline = runRollingFramePipeline(
            [0, 1, 2],
            item => {
                started.push(item);
                return requests[item].promise;
            },
            result => prepared.push(result),
            { networkConcurrency: 2 },
        );

        await Promise.resolve();
        expect(started).toEqual([0, 1]);

        requests[0].resolve('frame-0');
        await new Promise(resolve => setTimeout(resolve, 5));

        expect(prepared).toEqual(['frame-0']);
        expect(started).toEqual([0, 1, 2]);

        requests[1].resolve('frame-1');
        requests[2].resolve('frame-2');
        await pipeline;
        expect(prepared).toEqual(['frame-0', 'frame-1', 'frame-2']);
    });

    it('counts typed-array storage without double-counting shared values', () => {
        const data = new Float32Array(8);
        expect(estimateFrameBytes({ data, duplicate: data })).toBe(data.byteLength);
    });
});
