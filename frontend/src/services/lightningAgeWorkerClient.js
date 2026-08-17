let requestSequence = 0;

/** Run one lightning live-range request in an isolated, short-lived worker. */
export function fetchLightningAgeFramesInWorker(request) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            new URL('../workers/lightningAgeFrame.worker.js', import.meta.url),
            {type: 'module', name: 'web-nmap-lightning-age'},
        );
        const id = ++requestSequence;
        const finish = callback => value => {
            worker.terminate();
            callback(value);
        };
        worker.onmessage = event => {
            if (event.data?.id !== id) return;
            if (event.data.error) finish(reject)(new Error(event.data.error));
            else finish(resolve)(event.data.result);
        };
        worker.onerror = event => finish(reject)(new Error(event.message || 'Lightning worker failed'));
        worker.postMessage({id, request});
    });
}

export async function fetchLightningAgeFrameInWorker(request) {
    const result = await fetchLightningAgeFramesInWorker(request);
    return {...result, data: result.frames[0]?.data};
}
