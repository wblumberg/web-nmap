import {
    Barbs,
    PlotComponent,
    RawVectorField,
    UnstructuredGrid,
} from 'autumnplot-gl';

const DEFAULT_BATCH_SIZE = 4095;

function validWindObservation(observation) {
    const speed = Number(observation?.data?.wind_speed_kt);
    const direction = Number(observation?.data?.wind_direction_deg);
    return Number.isFinite(observation?.coord?.lon)
        && Number.isFinite(observation?.coord?.lat)
        && Number.isFinite(speed)
        && Number.isFinite(direction);
}

function observationTimeMs(observation) {
    if (Number.isFinite(observation?.valid_time_ms)) return observation.valid_time_ms;
    const parsed = Date.parse(observation?.valid_time);
    return Number.isFinite(parsed) ? parsed : null;
}

function makeVectorField(observations) {
    const grid = new UnstructuredGrid(observations.map(observation => observation.coord));
    const u = new Float32Array(observations.length);
    const v = new Float32Array(observations.length);
    observations.forEach((observation, index) => {
        const speed = Number(observation.data.wind_speed_kt);
        const radians = Number(observation.data.wind_direction_deg) * Math.PI / 180;
        u[index] = -speed * Math.sin(radians);
        v[index] = -speed * Math.cos(radians);
    });
    return new RawVectorField(grid, u, v, { relative_to: 'earth' });
}

/** One scatterometer frame, split only to respect UnstructuredGrid's layout. */
class ScatterometerFrame extends PlotComponent {
    constructor(observations, options = {}) {
        super();
        const batchSize = Math.max(1, Math.min(
            DEFAULT_BATCH_SIZE,
            Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE),
        ));
        const valid = observations.filter(validWindObservation);
        this.observationCount = valid.length;
        this.components = [];
        for (let start = 0; start < valid.length; start += batchSize) {
            this.components.push(new Barbs(
                makeVectorField(valid.slice(start, start + batchSize)),
                {
                    cmap: options.cmap,
                    thin_fac: options.thinFac ?? 16,
                    line_width: options.lineWidth ?? 2,
                    barb_size_multiplier: options.barbSizeMultiplier ?? 1,
                },
            ));
        }
    }

    async onAdd(map, gl) {
        // GPU uploads are deliberately serialized. A large swath may contain
        // many compatibility batches, and initializing all of them together
        // causes the same burst pressure this layer is intended to avoid.
        for (const component of this.components) {
            await component.onAdd(map, gl);
        }
    }

    render(gl, matrix) {
        this.components.forEach(component => component.render(gl, matrix));
    }

    dispose(gl) {
        this.components.forEach(component => component.dispose(gl));
        this.components = [];
    }
}

/** One immutable observation pool whose visible six-hour window is a uniform. */
class TemporalScatterometerLayer {
    constructor(id, observations, frameWindows, options = {}) {
        this.id = id;
        this.type = 'custom';
        this.options = options;
        this.frameWindows = new Map(frameWindows);
        this.activeKey = this.frameWindows.keys().next().value ?? null;
        this.map = null;
        this.components = [];

        const valid = observations
            .filter(validWindObservation)
            .map(observation => {
                const timeMs = observationTimeMs(observation);
                return {
                    observation,
                    timeMinute: Number.isFinite(timeMs)
                        ? Math.floor(timeMs / 60000)
                        : null,
                };
            })
            .filter(({ timeMinute }) => Number.isFinite(timeMinute));
        this.observationCount = valid.length;
        let earliestMinute = Infinity;
        for (const { timeMinute } of valid) {
            earliestMinute = Math.min(earliestMinute, timeMinute);
        }
        if (!Number.isFinite(earliestMinute)) earliestMinute = 0;
        this.timeOriginMinute = earliestMinute;
        const batchSize = Math.max(1, Math.min(
            DEFAULT_BATCH_SIZE,
            Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE),
        ));

        for (let start = 0; start < valid.length; start += batchSize) {
            const entries = valid.slice(start, start + batchSize);
            const batch = entries.map(({ observation }) => observation);
            const offsets = Float32Array.from(entries, ({ timeMinute }) => (
                timeMinute - earliestMinute
            ));
            this.components.push(new Barbs(makeVectorField(batch), {
                cmap: options.cmap,
                thin_fac: options.thinFac ?? 16,
                line_width: options.lineWidth ?? 2,
                barb_size_multiplier: options.barbSizeMultiplier ?? 1,
                temporal_offsets: offsets,
                temporal_window: this._relativeWindow(this.activeKey),
            }));
        }
    }

    _relativeWindow(key) {
        const window = key === null ? null : this.frameWindows.get(key);
        if (!window) return [1, 0];
        return [
            window.startMinute - this.timeOriginMinute,
            window.endMinute - this.timeOriginMinute,
        ];
    }

    getKeys() {
        return [...this.frameWindows.keys()];
    }

    setActiveKey(key) {
        if (key !== null && !this.frameWindows.has(key)) return;
        this.activeKey = key;
        const [start, end] = this._relativeWindow(key);
        this.components.forEach(component => component.setTemporalWindow(start, end));
        this.map?.triggerRepaint();
    }

    async onAdd(map, gl) {
        this.map = map;
        for (const component of this.components) await component.onAdd(map, gl);
        this.setActiveKey(this.activeKey);
        console.info('[NMAP scatterometer temporal]', {
            observations: this.observationCount,
            gpuUploadsPerLoop: 0,
            batches: this.components.length,
        });
    }

    render(gl, matrix) {
        this.components.forEach(component => component.render(gl, matrix));
    }

    onRemove(_map, gl) {
        this.components.forEach(component => component.dispose(gl));
        this.components = [];
        this.map = null;
    }
}

/**
 * A MapLibre-compatible temporal layer that retains compact frames on the CPU
 * while allowing only the selected frame to own GPU resources.
 */
class ScatterometerTimeSeriesLayer {
    constructor(id, options = {}) {
        this.id = id;
        this.type = 'custom';
        this.options = options;
        this.frames = new Map();
        this.activeKey = null;
        this.residentKey = null;
        this.activeFrame = null;
        this.map = null;
        this.gl = null;
        this.activationPromise = null;
        this.removed = false;
    }

    addFrame(key, observations) {
        this.frames.set(key, observations);
        if (this.activeKey === null) this.setActiveKey(key);
    }

    removeFrame(key) {
        this.frames.delete(key);
        if (key === this.activeKey) this.setActiveKey(this.frames.keys().next().value ?? null);
    }

    getKeys() {
        return [...this.frames.keys()];
    }

    setActiveKey(key) {
        if (key !== null && !this.frames.has(key)) return;
        this.activeKey = key;
        if (key === null) {
            if (this.activeFrame && this.gl) this.activeFrame.dispose(this.gl);
            this.activeFrame = null;
            this.residentKey = null;
            this.map?.triggerRepaint();
            return;
        }
        this._ensureActivation();
    }

    _ensureActivation() {
        if (this.activationPromise || !this.map || !this.gl || this.activeKey === null) return;
        if (this.residentKey === this.activeKey) return;
        this.activationPromise = this._drainActivations().finally(() => {
            this.activationPromise = null;
            // A request can arrive between the loop's last comparison and this
            // finally callback. Start another drain rather than losing it.
            this._ensureActivation();
        });
    }

    async _drainActivations() {
        while (
            !this.removed
            && this.activeKey !== null
            && this.residentKey !== this.activeKey
        ) {
            const key = this.activeKey;
            const observations = this.frames.get(key);
            if (!observations || !this.map || !this.gl) return;
            const map = this.map;
            const gl = this.gl;
            const frame = new ScatterometerFrame(observations, this.options);
            await frame.onAdd(map, gl);

            // Keep the resident frame on screen while this upload runs. If the
            // loop advances again before completion, still present this fully
            // prepared frame, then continue directly toward the newest target.
            // Discarding every overtaken upload can otherwise leave the first
            // frame resident forever when preparation exceeds loop cadence.
            if (this.removed || this.activeKey === null || this.map !== map) {
                frame.dispose(gl);
                continue;
            }

            const oldFrame = this.activeFrame;
            this.activeFrame = frame;
            this.residentKey = key;
            map.triggerRepaint();
            oldFrame?.dispose(gl);
            console.info('[NMAP scatterometer]', {
                frame: key,
                requestedFrame: this.activeKey,
                skippedAhead: key !== this.activeKey,
                observations: frame.observationCount,
                gpuResidentFrames: 1,
                batches: frame.components.length,
            });
        }
    }

    onAdd(map, gl) {
        this.map = map;
        this.gl = gl;
        this.removed = false;
        this._ensureActivation();
    }

    render(gl, matrix) {
        this.activeFrame?.render(gl, matrix);
    }

    onRemove() {
        this.removed = true;
        if (this.activeFrame && this.gl) this.activeFrame.dispose(this.gl);
        this.activeFrame = null;
        this.residentKey = null;
        this.map = null;
        this.gl = null;
    }
}

export { ScatterometerFrame, ScatterometerTimeSeriesLayer, TemporalScatterometerLayer };
