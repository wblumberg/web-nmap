/**
 * Run frame fetches through a bounded rolling pipeline.
 *
 * Requests overlap up to `networkConcurrency`, while `prepareItem` is awaited
 * sequentially in input order. This avoids Promise.all batch barriers and
 * prevents a burst of several decoded frames from hitting layer/GPU setup at
 * once. Completed results apply backpressure to new request launches.
 */

export const DEFAULT_FRAME_PIPELINE_OPTIONS = Object.freeze({
    networkConcurrency: 4,
    maxBufferedItems: 3,
    maxBufferedBytes: 128 * 1024 * 1024,
});

/** Give pending worker messages, input, and a browser paint an opportunity to run. */
export async function yieldToBrowser() {
    const requestedAt = performance.now();
    if (typeof requestAnimationFrame === 'function' &&
        (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    return performance.now() - requestedAt;
}

/** Estimate the typed-array memory retained by a fetched frame result. */
export function estimateFrameBytes(value, seen = new Set()) {
    if (value == null || typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);

    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (value instanceof ArrayBuffer) return value.byteLength;

    let total = 0;
    for (const child of Object.values(value)) {
        total += estimateFrameBytes(child, seen);
    }
    return total;
}

/**
 * @template T,R
 * @param {T[]} items
 * @param {(item:T, index:number) => Promise<R>} fetchItem
 * @param {(result:R, item:T, index:number) => (void|Promise<void>)} prepareItem
 * @param {object} [options]
 */
export async function runRollingFramePipeline(items, fetchItem, prepareItem, options = {}) {
    if (!items.length) return;

    const networkConcurrency = Math.max(
        1,
        Math.floor(options.networkConcurrency ?? DEFAULT_FRAME_PIPELINE_OPTIONS.networkConcurrency),
    );
    const maxBufferedItems = Math.max(
        1,
        Math.floor(options.maxBufferedItems ?? DEFAULT_FRAME_PIPELINE_OPTIONS.maxBufferedItems),
    );
    const maxBufferedBytes = Math.max(
        1,
        options.maxBufferedBytes ?? DEFAULT_FRAME_PIPELINE_OPTIONS.maxBufferedBytes,
    );
    const estimateBytes = options.estimateBytes ?? estimateFrameBytes;
    const onError = options.onError ?? (() => {});

    const requests = new Map();
    let nextToLaunch = 0;
    let settledItems = 0;
    let settledBytes = 0;

    const launch = index => {
        const request = Promise.resolve()
            .then(() => fetchItem(items[index], index))
            .then(
                value => ({ status: 'fulfilled', value, bytes: estimateBytes(value) }),
                reason => ({ status: 'rejected', reason, bytes: 0 }),
            )
            .then(outcome => {
                outcome.settled = true;
                settledItems++;
                settledBytes += outcome.bytes;
                return outcome;
            });
        requests.set(index, request);
    };

    const fillNetworkSlots = () => {
        while (
            nextToLaunch < items.length &&
            requests.size < networkConcurrency &&
            settledItems < maxBufferedItems &&
            settledBytes < maxBufferedBytes
        ) {
            launch(nextToLaunch++);
        }
    };

    fillNetworkSlots();

    for (let index = 0; index < items.length; index++) {
        // Byte/count pressure may have prevented this request from launching.
        if (!requests.has(index)) launch(index);
        if (index >= nextToLaunch) nextToLaunch = index + 1;

        const outcome = await requests.get(index);
        requests.delete(index);
        settledItems--;
        settledBytes -= outcome.bytes;

        if (outcome.status === 'fulfilled') {
            await prepareItem(outcome.value, items[index], index);
        } else {
            onError(outcome.reason, items[index], index);
        }

        // Do not launch another request until the delivered frame has had a
        // browser paint. This also lets completed worker messages run before
        // more Zarr work is admitted to the pipeline.
        await yieldToBrowser();
        fillNetworkSlots();
    }
}
