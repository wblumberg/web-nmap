const POOL_SIZE = 2;
let sequence = 0;
const queue = [];
const slots = Array.from({length: POOL_SIZE}, (_, index) => ({
    index, worker: null, busy: false, job: null,
}));

function createWorker(slot) {
    const started = performance.now();
    const worker = new Worker(
        new URL('../workers/zarrDecode.worker.js', import.meta.url),
        {type: 'module', name: `web-nmap-zarr-decode-${slot.index + 1}`},
    );
    const constructMs = performance.now() - started;
    worker.onmessage = event => {
        const job = slot.job;
        if (!job || event.data?.id !== job.id) return;
        const result = event.data?.result;
        if (event.data?.error) job.reject(new Error(event.data.error));
        else job.resolve({
            ...result,
            clientRequestMs: performance.now() - job.enqueuedAt,
            poolQueueMs: job.dispatchedAt - job.enqueuedAt,
            workerConstructMs: job.workerConstructMs,
            workerStartupAndQueueMs: Math.max(0, Number(result?.requestReceivedEpochMs) - Number(result?.requestPostedEpochMs)),
            messageDeliveryMs: Math.max(0, Date.now() - Number(result?.returnReadyEpochMs)),
        });
        slot.busy = false;
        slot.job = null;
        dispatch();
    };
    worker.onerror = event => {
        const job = slot.job;
        worker.terminate();
        slot.worker = null;
        slot.busy = false;
        slot.job = null;
        job?.reject(new Error(event.message || 'Zarr decode worker failed'));
        dispatch();
    };
    slot.worker = worker;
    return constructMs;
}

function dispatch() {
    for (const slot of slots) {
        if (slot.busy || !queue.length) continue;
        const job = queue.shift();
        const workerConstructMs = slot.worker ? 0 : createWorker(slot);
        slot.busy = true;
        slot.job = job;
        job.dispatchedAt = performance.now();
        job.workerConstructMs = workerConstructMs;
        slot.worker.postMessage({id: job.id, request: job.request, requestPostedEpochMs: Date.now()});
    }
}

export function decodeZarrFrameInWorker(request) {
    return new Promise((resolve, reject) => {
        queue.push({id: ++sequence, request, resolve, reject, enqueuedAt: performance.now()});
        dispatch();
    });
}
