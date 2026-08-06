/**
 * appController.js — Main application orchestrator for web-nmap
 *
 * This is the "glue" module that connects all the individual pieces of the
 * application into one working pipeline.  If you're coming from Python, think
 * of this as the equivalent of a Flask/FastAPI app factory combined with the
 * main request handling logic.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURE OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The pieces being connected:
 *
 *   catalogClient.js   — Discovers what data sources & times exist on the server
 *   dataClient.js      — Fetches actual field values (Float32Arrays) from the API
 *   productIndex.js    — Registry of product visualization configs (like GEMPAK restore files)
 *   gridFactory.js     — Converts API grid descriptors → autumnplot-gl Grid objects
 *   layerBuilder.js    — Creates MultiPlotLayers from data + products (enables looping)
 *   TimeMatcher         — Matches times across different data sources
 *   LayerManager (view) — UI dialog for selecting data sources / frame config
 *   ProductGen (view)   — UI panel for drawing products on the map
 *   store.js           — Simple global state for catalog data + map reference
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MAIN FLOW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. init() — called once on page load:
 *      ├── Fetch data source catalog from API
 *      ├── Group available products per source
 *      ├── Create the MapLibre map
 *      └── Wire up toolbar buttons + keyboard shortcuts
 *
 *   2. User clicks "Load Data" → opens LayerManager
 *      ├── User adds data sources (e.g., GFS, MESOANALYSIS_GRID)
 *      ├── User sets dominant source (controls the timeline)
 *      ├── User configures number of frames, skip interval
 *      └── User clicks "Apply"
 *
 *   3. _onLayerManagerApply(config) — THE KEY CONNECTION POINT:
 *      For each selected source:
 *      ├── Pick a product → determines what variables to fetch + how to render
 *      ├── Fetch available times from API → get proper key strings
 *      ├── Time-match frame times to available keys
 *      ├── Fetch field data for each matched frame (batched)
 *      ├── Call buildMultiLayers() → creates MultiPlotLayers for looping
 *      └── Add MultiPlotLayers to the map
 *      Then:
 *      ├── Display colorbars
 *      ├── Set up mouse readout
 *      └── Jump to newest frame
 *
 *   4. Frame controls (keyboard / toolbar buttons):
 *      └── Each step calls controller.setKey() on all MultiPlotLayer controllers
 *          → autumnplot-gl swaps the GPU texture instantly (no flicker!)
 */

import * as apgl from 'autumnplot-gl';

// Make autumnplot-gl available globally so product suite make_layers() functions
// can reference apgl.RawScalarField, apgl.ContourFill, etc.
// (Product files like basic.js, instability.js use `apgl` as a global.)
window.apgl = apgl;

import * as CatalogClient from '../services/api/catalogClient.js';
import * as DataClient    from '../services/api/dataClient.js';
import {
    fetchAnalysisFieldsAuto,
    streamAnalysisFramesAuto,
    streamForecastFramesAuto,
} from '../services/api/dataClient.js';
import { PRODUCT_SUITES, PRODUCT_GROUPS } from '../domain/dataProducts/productIndex.js';
import { makeApglGrid }   from '../domain/gridFactory.js';
import {
    buildMultiLayers,
    buildProgressiveMultiLayers,
    buildTemporalScatterometerLayers,
} from '../domain/layerBuilder.js';
import { getState, setState } from '../app/store.js';
import { LayerManager }    from '../views/panels/productManager.js';
import { ProductGen }      from '../views/panels/productGenView.js';
import { DatasetStatus }   from '../views/panels/datasetStatus.js';
import { BasemapStyleView } from '../views/panels/basemapStyleView.js';
import { resolveTitle }    from '../domain/titleResolver.js';
import {
    buildPointFrames,
    normalizePointPolicy,
    pointRangeForFrames,
} from '../domain/pointFrames.js';
import { runRollingFramePipeline } from '../services/rollingFramePipeline.js';

// Load TimeMatcher (IIFE side-effect import — sets window.TimeMatcher)
import './timeMatcherController.js';


// ═════════════════════════════════════════════════════════════════════════════
// PRIVATE STATE
// ═════════════════════════════════════════════════════════════════════════════
//
// All mutable state is kept here in module-level variables.
// The store.js is used for catalog data + map reference that other modules need.
// Layer/frame state is managed internally by this controller.

/** @type {maplibregl.Map} */
let _map = null;

// ── Active layers currently displayed on the map ──
let _activeMultiLayers = [];    // MultiPlotLayer instances added to the map
let _layerControllers  = [];    // controller objects from buildMultiLayers()
let _activeColorbars   = [];    // SVG colorbar elements
/** @deprecated — use _layerControllers + getSampler() instead */ 
let _activeSampler     = null;  // kept only for legacy non-progressive paths
let _samplerEnabled    = false; // whether the cursor popup is active
let _mousemoveHandler  = null;  // current map mousemove handler

// ── Frame timeline ──
let _frameTimes      = [];      // Date[], sorted oldest → newest
let _frameKeys       = [];      // string[], parallel to _frameTimes
let _currentFrameIdx = -1;      // index into _frameTimes / _frameKeys

// ── Playback state ──
let _playbackTimer      = null;
let _loopEndTimeout     = null;    // setTimeout handle for end-of-loop pause
let _playbackMode       = 'pause'; // 'pause' | 'loop-fwd' | 'loop-back' | 'rock'
let _rockDirection      = 1;       // +1 = forward, -1 = backward
let PLAY_INTERVAL_MS    = 100;     // ms between frames during playback
let END_OF_LOOP_PAUSE_MS = 500;    // ms to hold at the last frame before wrapping

// ── Cached DOM elements ──
let _frameTimeEl       = null;
let _colorbarPanel     = null;
let _colorbarContainer = null;
let _readoutEl         = null;
let _samplerPopupEl    = null;

// ── Auto-update state ──
//
// _currentLoadConfig  — snapshot of the last LayerManager apply ({sources, dominantId, numFrames})
//                       so we know which source is dominant and how many frames to keep.
// _sourceUpdateState  — one entry per loaded source; each entry holds enough context to
//                       append a new frame without reloading everything:
//                         { srcId, addFrame(key,data), controller, isPointObs, dataKeys,
//                           productSuite, cycleTime }
// _autoUpdateSse      — the live EventSource connection to /api/v1/events/data
// _autoUpdateActive   — whether auto-update is currently enabled by the user
// _autoUpdatePending  — keys currently in-flight to stop duplicate fetches
let _currentLoadConfig  = null;
let _sourceUpdateState  = [];
let _autoUpdateSse      = null;
let _autoUpdateActive   = false;
let _autoUpdatePending  = new Set();

// Accumulates switch-to-render latency while the user plays through a loop.
// A summary is emitted after every frame has reached a MapLibre render event.
let _loopRenderTiming = null;

// ── Map title element (position:absolute inside #map — stays locked to bottom of viewport) ──
/** @type {HTMLDivElement|null} */
let _titleEl = null;

/** Minimal HTML-escape to prevent XSS when inserting resolved title strings. */
const _escHtml = s => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API: init()
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the entire application.
 *
 * This is the JavaScript equivalent of Python's:
 *     if __name__ == '__main__':
 *         app = create_app()
 *         app.run()
 *
 * Call this once from main.js after the page loads.
 */
export async function init() {
    console.info('%c[NMAP]%c Initializing web-nmap...',
        'color:#55d46a;font-weight:bold', 'color:inherit');

    // ── Pre-initialize the autumnplot-gl WASM module ──
    // The marchingsquares.wasm binary (used for contour computation) must be
    // loaded from a known URL. We ship it in public/ so webpack-dev-server
    // serves it at '/'.
    apgl.initAutumnPlot({ wasm_base_url: '/', contour_workers: Math.max(2, Math.min(navigator.hardwareConcurrency ?? 4, 8)) });

    // Cache DOM elements so we don't re-query the DOM on every frame step
    _frameTimeEl       = document.querySelector('#frame-time-value');
    _colorbarPanel     = document.querySelector('#colorbar-panel');
    _colorbarContainer = document.querySelector('#colorbar');
    _readoutEl         = document.querySelector('#readout');
    _samplerPopupEl    = document.querySelector('#sampler-popup');

    // ── Step 1: Fetch the catalog of available data sources from the API ──
    //
    // Python equivalent:
    //     resp = requests.get('/api/v1/catalog/sources')
    //     sources = resp.json()['sources']
    let sources = [];
    try {
        sources = await CatalogClient.listSources();
        console.info('%c[NMAP]%c Loaded %d data source(s) from API',
            'color:#55d46a;font-weight:bold', 'color:inherit', sources.length);
    } catch (err) {
        console.error('[NMAP] Failed to fetch data sources:', err);
    }

    // ── Step 2: Group available products by source ──
    //
    // PRODUCT_SUITES is a dict of visualization configs (like GEMPAK restore files).
    // Each product declares which sources it works with (via `available_for`).
    //
    // Result shape (like a Python dict of dicts):
    //   { 'GFS': { 'basic': [product1, product2], 'instability': [...] },
    //     'RAP': { 'basic': [...], 'shear': [...] }, ... }
    const groupedProducts = _buildGroupedProducts(sources);

    // ── Step 3: Store in global state + expose for debugging ──
    setState({ sources, grouped_products: groupedProducts });
    window.NMAP_SOURCES = sources;
    window.NMAP_GROUPED_PRODUCTS = groupedProducts;

    console.info('%c[NMAP]%c Products grouped by source:',
        'color:#55d46a;font-weight:bold', 'color:inherit', groupedProducts);

    // ── Step 4: Create the MapLibre GL map ──
    _map = new maplibregl.Map({
        container: 'map',
        style: '/styles/style.json',
        center: [-97.5, 38.5],   // centered on CONUS
        zoom: 4,
        maxZoom: 7,
        // Keep recently visited globe tiles resident across a few more zoom
        // levels, discard obsolete in-flight zoom requests, and rely on the
        // immutable HTTP cache rather than revalidating static basemap tiles.
        maxTileCacheZoomLevels: 7,
        cancelPendingTileRequestsWhileZooming: true,
        refreshExpiredTiles: false,
        // MapLibre does not resolve root-relative URLs found inside TileJSON
        // before passing them to Request(). Make every map resource absolute
        // at request time while retaining the hostname used to open the app.
        transformRequest: url => ({
            url: new URL(url, window.location.origin).href,
        }),
    });
    setState({ map: _map });
    // Register before the initial style finishes loading so the persisted
    // basemap projection and layer settings are applied on the first paint.
    BasemapStyleView.init(_map);

    // ── Step 5: Wire everything after the map's GL context is ready ──
    //
    // MapLibre fires 'load' once tiles are loaded and the GL context is
    // initialized. We must wait for this before adding any layers.
    _map.on('load', () => {
        console.info('%c[NMAP]%c Map loaded — ready for layers',
            'color:#55d46a;font-weight:bold', 'color:inherit');
        ProductGen.init(_map);
        DatasetStatus.init();
        _wireToolbar();
        _wireKeyboard();
        _updateFrameDisplay();
    });
}


// ═════════════════════════════════════════════════════════════════════════════
// TOOLBAR & KEYBOARD WIRING
// ═════════════════════════════════════════════════════════════════════════════

function _wireToolbar() {
    // ── "Load Data" button → opens the Layer Manager dialog ──
    //
    // The Layer Manager is the main entry point for selecting data sources.
    // When the user clicks "Apply", our _onLayerManagerApply() callback fires
    // with the full configuration (sources, dominant, frames).
    LayerManager.init();
    document.querySelector('#btn-load').addEventListener('click', () => {
        LayerManager.open((config) => _onLayerManagerApply(config));
    });

    // Helper to wire a button click
    const wire = (selector, handler) => {
        const el = document.querySelector(selector);
        if (el) el.addEventListener('click', handler);
    };

    // ── Playback buttons ──
    wire('#btn-goto-first', () => { _stopPlayback(); _setFrame(0); });
    wire('#btn-goto-last',  () => { _stopPlayback(); _setFrame(_frameTimes.length - 1); });
    wire('#btn-step-back',  () => { _stopPlayback(); _stepFrame(-1); });
    wire('#btn-step-fwd',   () => { _stopPlayback(); _stepFrame(+1); });
    wire('#btn-loop-back',  () => _togglePlayback('loop-back'));
    wire('#btn-loop-fwd',   () => _togglePlayback('loop-fwd'));
    wire('#btn-rock',       () => _togglePlayback('rock'));

    const slider = document.getElementById('loop_speed');
    // Map slider range → milliseconds per frame. Read slider min/max so
    // the mapping remains robust if the HTML is edited.
    const MIN_MS = 10;
    const MAX_MS = 1000;
    const _sliderToMs = (v, minV, maxV) => {
        const vv = Number(v);
        const lo = Number.isFinite(Number(minV)) ? Number(minV) : 1;
        const hi = Number.isFinite(Number(maxV)) ? Number(maxV) : 50;
        if (!Number.isFinite(vv)) return Math.round((MAX_MS + MIN_MS) / 2);
        const clamped = Math.min(hi, Math.max(lo, Math.round(vv)));
        // Interpolate linearly from [lo,hi] → [MAX_MS, MIN_MS]
        const t = (clamped - lo) / Math.max(1, (hi - lo));
        const ms = Math.round(MAX_MS - t * (MAX_MS - MIN_MS));
        return Math.max(MIN_MS, Math.min(MAX_MS, ms));
    };

    // Initialize PLAY_INTERVAL_MS to match the slider default value so UI and
    // runtime are consistent. Fall back to a sane default if the slider is
    // missing or malformed.
    if (slider) {
        const minV = slider.min ?? 1;
        const maxV = slider.max ?? 50;
        const valV = slider.value ?? ((Number(minV) + Number(maxV)) / 2);
        PLAY_INTERVAL_MS = _sliderToMs(valV, minV, maxV);
    } else {
        PLAY_INTERVAL_MS = 500;
    }

    if (slider) slider.addEventListener('input', (ev) => {
        const target = ev?.target || {};
        const val = target.value;
        const minV = target.min ?? slider.min ?? 1;
        const maxV = target.max ?? slider.max ?? 50;
        const prevMode = _playbackMode;
        const wasPlaying = !!_playbackTimer;
        PLAY_INTERVAL_MS = _sliderToMs(val, minV, maxV);
        console.info(`[NMAP] Playback speed set to ${PLAY_INTERVAL_MS} ms/frame (slider value: ${val}, range: ${minV}-${maxV})`);
        if (wasPlaying) {
            // Restart playback using the previous mode so changes take effect immediately.
            _stopPlayback();
            if (prevMode && prevMode !== 'pause') _togglePlayback(prevMode);
        }
    });

    // ── Freeze Map Location ──
    let frozen = false;
    wire('#btn-freeze', () => {
        frozen = !frozen;
        const btn = document.querySelector('#btn-freeze');
        btn.classList.toggle('active', frozen);
        btn.title = frozen ? 'Unfreeze Map Location' : 'Freeze Map Location';
        const interactions = [
            'dragPan', 'scrollZoom', 'boxZoom',
            'doubleClickZoom', 'touchZoomRotate', 'keyboard'
        ];
        interactions.forEach(name => _map[name][frozen ? 'disable' : 'enable']());
    });

    // ── Auto-Update — SSE-driven live frame append ──
    wire('#btn-autoupdate', () => {
        const btn = document.querySelector('#btn-autoupdate');
        if (_autoUpdateActive) {
            _stopAutoUpdate();
            btn.classList.remove('active');
            btn.title = 'Auto-Update (off)';
        } else {
            _startAutoUpdate();
            btn.classList.add('active');
            btn.title = 'Auto-Update (on)';
        }
    });

    // ── Product Generation panel toggle ──
    wire('#btn-product', () => {
        const btn = document.querySelector('#btn-product');
        const nowOpen = ProductGen.toggle();
        btn.classList.toggle('active', nowOpen);
    });

    // ── Basemap style configuration ──
    wire('#btn-basemap', () => {
        const btn = document.querySelector('#btn-basemap');
        btn.classList.toggle('active', BasemapStyleView.toggle());
    });

    // ── Data Sampler popup toggle ──
    wire('#btn-sampler', () => {
        _samplerEnabled = !_samplerEnabled;
        const btn = document.querySelector('#btn-sampler');
        btn.classList.toggle('active', _samplerEnabled);
        btn.title = _samplerEnabled ? 'Data Sampler (on)' : 'Data Sampler (off)';
        if (!_samplerEnabled && _samplerPopupEl) {
            _samplerPopupEl.classList.add('hidden');
        }
    });

    // ── Dataset availability / freshness monitor ──
    wire('#btn-dataset-status', () => {
        const open = DatasetStatus.toggle();
        document.querySelector('#btn-dataset-status').classList.toggle('active', open);
    });
}

function _wireKeyboard() {
    document.addEventListener('keydown', (ev) => {
        // Don't intercept typing in form fields
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;

        switch (ev.code) {
            case 'Space':
                ev.preventDefault();
                _playbackMode === 'pause'
                    ? _togglePlayback('loop-fwd')
                    : _stopPlayback();
                break;
            case 'Comma':
                ev.preventDefault();
                _stopPlayback();
                _stepFrame(-1);
                break;
            case 'Period':
                ev.preventDefault();
                _stopPlayback();
                _stepFrame(+1);
                break;
            case 'KeyL':
                ev.preventDefault();
                _togglePlayback('loop-fwd');
                break;
            case 'KeyK':
                ev.preventDefault();
                _togglePlayback('loop-back');
                break;
        }
    });
}


// ═════════════════════════════════════════════════════════════════════════════
// LAYER MANAGER APPLY — THE MAIN CONNECTION POINT
// ═════════════════════════════════════════════════════════════════════════════
//
// When the user configures sources in the Layer Manager and clicks "Apply",
// this callback fires.  It's the bridge between the UI and the data pipeline.
//
// Input shape (from LayerManager):
//   {
//     sources:    [{ uid, id, name, color, entry, cycleTime }],
//     dominantId: string,
//     numFrames:  number,
//     frameSkip:  number,
//     frames:     Date[]   // newest → oldest
//   }
//
// What happens next:
//   1. Clear old layers
//   2. Normalize frame times
//   3. For each source: fetch data → build MultiPlotLayers → add to map
//   4. Set up colorbars, readout, start at newest frame

async function _onLayerManagerApply({ sources, dominantId, numFrames, frameSkip, frames }) {
    const loadStarted = performance.now();
    console.group(
        '%c[NMAP]%c Loading data — %d source(s), %d frame(s), dominant=%s',
        'color:#55d46a;font-weight:bold', 'color:inherit',
        sources.length, frames.length, dominantId
    );

    // ── 1. Clear existing layers from the map ──
    _clearActiveLayers();

    // ── 1b. Save this configuration for auto-update reference ──
    _currentLoadConfig = { sources, dominantId, numFrames };
    _sourceUpdateState = [];
    _autoUpdatePending.clear();

    // ── 2. Normalize frame times ──
    //
    // LayerManager gives frames newest→oldest. We sort oldest→newest
    // which is the natural timeline order for looping.
    const sortedFrames = [...frames]
        .map(t => (t instanceof Date) ? t : new Date(t))
        .filter(d => Number.isFinite(d.getTime()))
        .sort((a, b) => a.getTime() - b.getTime());

    if (!sortedFrames.length) {
        console.warn('[NMAP] No valid frame times — nothing to load');
        console.groupEnd();
        _updateFrameDisplay();
        return;
    }

    // Store the frame timeline
    _frameTimes = sortedFrames;
    // Create string keys for MultiPlotLayer indexing: "YYYYMMDD_HHMM"
    _frameKeys = sortedFrames.map(d => _dateToKey(d));

    console.info('Frame range: %s → %s (%d frames)',
        sortedFrames[0].toISOString(),
        sortedFrames[sortedFrames.length - 1].toISOString(),
        sortedFrames.length
    );

    // ── 3. Show loading state ──
    _setFrameDisplayText('Loading...');
    setState({ ui: { loading: true, error: null } });

    try {
        // ── 4. For each source, load data and build MultiPlotLayers ──
        //
        // Progressive loading: the first frame is added to the map
        // immediately so the user sees data right away.  Remaining
        // frames are fetched in batches and appended incrementally.
        let firstFrameRendered = false;
        for (const src of sources) {
            try {
                await _loadAndBuildSource(src, sortedFrames, {
                    onFirstFrame() {
                        if (!firstFrameRendered) {
                            firstFrameRendered = true;
                            _renderColorbars();
                            _setupReadout();
                            _createTitleEl();
                            _setFrame(0);
                        }
                    },
                    onProgress(loaded, total) {
                        _setFrameDisplayText(`Loading ${loaded}/${total} frames\u2026`);
                    },
                });
            } catch (err) {
                console.error(`[NMAP] Failed to load source "${src.id}":`, err);
            }
        }

        // ── 5. Final display refresh ──
        _renderColorbars();
        _setupReadout();

        // ── 6. Jump to the newest frame ──
        _setFrame(_frameTimes.length - 1);

        console.info('[NMAP] Data load complete — %d MultiPlotLayer(s) active',
            _activeMultiLayers.length);
        console.info('[NMAP timing] Full data load pipeline complete', {
            sources: sources.length,
            frames: sortedFrames.length,
            totalMs: +(performance.now() - loadStarted).toFixed(1),
        });

    } catch (err) {
        console.error('[NMAP] Error during data load:', err);
        setState({ ui: { loading: false, error: err.message } });
    } finally {
        setState({ ui: { loading: false, error: null } });
    }

    console.groupEnd();
}


// ═════════════════════════════════════════════════════════════════════════════
// DATA LOADING PIPELINE — per source
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Load data for one source across all frame times, then build layers.
 *
 * Dispatches to a source-type-specific loader based on `src.entry.endpoint_type`
 * as reported by the catalog.  New endpoint types can be handled by adding
 * a case here and implementing the corresponding `_load*Source` function.
 *
 * @param {object} src        - { uid, id, name, color, entry, cycleTime }
 * @param {Date[]} frameTimes - sorted oldest → newest
 */
async function _loadAndBuildSource(src, frameTimes, { onFirstFrame, onProgress } = {}) {
    const endpointType = src.entry?.endpoint_type ?? 'gridded';

    switch (endpointType) {
        case 'gridded':
            return _loadGriddedSource(src, frameTimes, { onFirstFrame, onProgress });
        case 'point_obs':
            return _loadPointObsSource(src, frameTimes, { onFirstFrame, onProgress });
        case 'profile_obs':
            return _loadProfileObsSource(src, frameTimes, { onFirstFrame, onProgress });
        case 'geometry':
            return _loadGeometrySource(src, frameTimes, { onFirstFrame, onProgress });
        default:
            console.warn(
                `[NMAP] Source "${src.id}" has unknown endpoint_type="${endpointType}" — skipping.`
            );
            return;
    }
}

/**
 * Load gridded data for one source across all frame times, then build MultiPlotLayers.
 *
 * This is the core of the gridded data pipeline.  In Python pseudocode:
 *
 *     product = PRODUCT_SUITES[product_id]            # visualization config
 *     grid_info = catalog_client.get_grid_info(src)   # coordinate system
 *     grid = make_apgl_grid(grid_info)                # autumnplot-gl grid
 *
 *     available = catalog_client.list_times(src)      # what times exist
 *     for frame_time in frame_times:
 *         key = time_match(frame_time, available)     # find nearest match
 *         data[key] = data_client.fetch(src, product.data_keys, key)
 *
 *     multi_layers = build_multi_layers(product, data, grid, keys)
 *     map.add_layers(multi_layers)
 *
 * @param {object} src        - { uid, id, name, color, entry, cycleTime }
 * @param {Date[]} frameTimes - sorted oldest → newest
 */
async function _loadGriddedSource(src, frameTimes, { onFirstFrame, onProgress } = {}) {
    // ── Step A: Pick a product for this source ──
    //
    // Each data source (GFS, RAP, MESOANALYSIS_GRID) can render many products
    // (2m Temperature, 500mb Heights, CAPE, etc.).  The product determines:
    //   - What variables to fetch from the API (data_keys)
    //   - How to visualize them (make_layers function)
    //
    // Use the product the user explicitly selected in the DataSelector dialog.
    // Fall back to auto-picking the first available product if none was chosen.
    const productId = src.productKey || _pickDefaultProduct(src.id);
    if (!productId) {
        console.warn(`[NMAP] No products available for source "${src.id}" — skipping`);
        return;
    }

    const productSuite = PRODUCT_SUITES[productId];
    const dataKeys = productSuite.data_keys;  // e.g. ['t2m'] or ['hght_500mb', 'ugrd_500mb', 'vgrd_500mb']
    const queryParams = _getSourceQueryParams(src, productSuite);

    console.info(
        `[NMAP] Source "${src.id}" → product "${productId}" (variables: [${dataKeys.join(', ')}])`
    );
    console.warn('[NMAP] productSuite =', productSuite);
    console.warn('[NMAP] src.entry =', src.entry);
    console.warn('[NMAP] isForecast will be:', !!(src.entry?.has_cycles || src.cycleTime));

    // ── Step B: Fetch grid info from the API ──
    //
    // The grid descriptor tells autumnplot-gl the coordinate system, resolution,
    // and extent of the data.  We convert it to an apgl Grid object.
    // This is cached internally by fetchGridInfoCached — the grid never changes.
    const gridInfo = await CatalogClient.fetchGridInfoCached(src.id);
    console.warn('[NMAP] gridInfo for', src.id, '=', JSON.stringify(gridInfo));
    const grid = makeApglGrid(gridInfo);
    console.warn('[NMAP] apgl grid =', grid, '| type:', grid?.constructor?.name);

    // ── Step C: Determine if this is a forecast or analysis source ──
    //
    // Forecast sources have cycles (init times) and forecast hours.
    // Analysis/observation sources have simple valid times.
    const isForecast = !!(src.entry?.has_cycles || src.cycleTime);
    const isDominant  = src.id === (_currentLoadConfig?.dominantId);

    // ── Step D: Match frame times to available API keys ──
    //
    // For the dominant source (or forecast sources): use catalog fhrs / TimeMatcher.
    // For secondary analysis/obs sources: use the server-side build_map endpoint
    // so window enforcement is consistent with what the timematch API returns.
    let frameToKey;   // Map<number(ms), string(apiKey)>
    if (isForecast && src.cycleTime) {
        frameToKey = await _matchForecastFrames(src, frameTimes, queryParams);
    } else if (isDominant) {
        frameToKey = await _matchAnalysisFrames(src, frameTimes, queryParams);
    } else {
        frameToKey = await _matchFramesViaApi(src, frameTimes, queryParams);
    }

    console.warn('[NMAP] frameToKey size =', frameToKey.size, '| entries:', [...frameToKey.entries()].slice(0, 5).map(([ms, k]) => `${new Date(ms).toISOString()} → ${k}`));

    if (!frameToKey.size) {
        console.warn(`[NMAP] No matching times found for source "${src.id}" — skipping`);
        return;
    }

    // ── Step E: Progressive frame loading ──
    //
    // For forecast sources with a single Zarr store, we use a streaming
    // batch endpoint that opens the store once and sends all frames over
    // one HTTP connection.  For analysis/obs sources, we still fetch
    // frames individually (they're separate files).
    //
    // autumnplot-gl's MultiPlotLayer.addField() works after the layer
    // has been added to the map — it uploads the new texture and repaints.
    const namespace = src.uid || src.id;
    const frameEntries = [...frameToKey.entries()];  // [[ms, apiKey], ...]
    const totalFrames = frameEntries.length;

    if (isForecast && src.cycleTime && !src.entry?.has_fhrs) {
        // ────────────────────────────────────────────────────────────────────────────
        // ── STREAMING FORECAST PATH (single-store sources only) ──
        // Sources where all fhrs live in one Zarr store (e.g. HREF).
        // Per-file sources (has_fhrs=true, e.g. ECMWF_HR) fall through
        // to the per-frame path below.
        // Build a fhr→frameKey mapping and use the batch stream endpoint.
        // ────────────────────────────────────────────────────────────────────────────

        const cycleStr = _dateToCycleStr(src.cycleTime);
        const cycleMs  = src.cycleTime.getTime();

        // Ordered list of { fhr, frameKey } matching the frameEntries order
        const fhrMap = frameEntries.map(([frameMs]) => ({
            fhr:      Math.round((frameMs - cycleMs) / 3_600_000),
            frameKey: _dateToKey(new Date(frameMs)),
        }));
        const fhrs = fhrMap.map(f => f.fhr);
        // Quick lookup: key from server response → our display key
        const serverKeyToFrameKey = new Map(
            fhrMap.map(f => [`${cycleStr}_f${String(f.fhr).padStart(3, '0')}`, f.frameKey])
        );

        console.info(`[NMAP] Streaming ${fhrs.length} forecast frames for "${src.id}" cycle=${cycleStr}`);

        let progressive = null;
        let loaded = 0;

        await streamForecastFramesAuto(
            src.id, dataKeys, cycleStr, fhrs, gridInfo,
            // onFrame callback — invoked for each frame as it arrives from the stream
            async ({ fields, gridInfo, key: serverKey }) => {
                const frameKey = serverKeyToFrameKey.get(serverKey) || serverKey;
                loaded++;

                if (!progressive) {
                    // First frame: build layers and add to map
                    console.info(`[NMAP] First streamed frame "${frameKey}" — building layers (namespace="${namespace}")`);
                    progressive = buildProgressiveMultiLayers(
                        productSuite, frameKey, fields, grid, namespace
                    );
                    for (const ml of progressive.layers) {
                        try { _map.addLayer(ml, 'coastline'); }
                        catch (err) { console.error(`[NMAP] FAILED to add layer "${ml.id}":`, err); }
                    }
                    _activeMultiLayers.push(...progressive.layers);
                    _layerControllers.push(progressive.controller);
                    if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
                    if (progressive.sampler) _activeSampler = progressive.sampler;
                    onFirstFrame?.();
                } else {
                    // Subsequent frame: append to existing layers
                    await progressive.addFrame(frameKey, fields);
                }
                onProgress?.(loaded, totalFrames);
            },
            src.entry,
            {
                queryParams,
                apglGrid: grid,
            },
        );

        if (!progressive) {
            console.warn(`[NMAP] No data loaded for "${src.id}" — skipping layer build`);
            return;
        }

        console.info(`[NMAP] Streamed ${loaded}/${totalFrames} frames for "${src.id}/${productId}"`);
        _sourceUpdateState.push({
            srcId: src.id, addFrame: progressive.addFrame, removeFrame: progressive.removeFrame,
            controller: progressive.controller, isPointObs: false, isForecast, dataKeys,
            productSuite, cycleTime: src.cycleTime ?? null,
            srcEntry: src.entry, gridInfo,
            queryParams,
        });

    } else if (!isForecast) {
        // ────────────────────────────────────────────────────────────────────────────
        // ── ANALYSIS/OBSERVATION STREAMING PATH ──
        // Batch all keys through the analysis_stream endpoint (single HTTP
        // connection, length-prefixed protobuf frames, same wire format as
        // forecast_stream).  Client-side cache is checked first inside
        // DataClient.streamAnalysisFrames so cached frames skip the network.
        // ────────────────────────────────────────────────────────────────────────────

        // Build a one-to-many map: apiKey → [frameKey, ...] so that when multiple
        // dominant frames time-match to the same secondary API key (e.g. MESOANALYSIS_GRID
        // updating only once per hour while radar updates every 2 min), the layer
        // controller gets a frame registered under every dominant key, not just the last.
        const apiKeyToFrameKeys = new Map();
        for (const [frameMs, apiKey] of frameEntries) {
            const frameKey = _dateToKey(new Date(frameMs));
            if (!apiKeyToFrameKeys.has(apiKey)) apiKeyToFrameKeys.set(apiKey, []);
            apiKeyToFrameKeys.get(apiKey).push(frameKey);
        }
        // Deduplicate so we only request each unique API key once from the server.
        const apiKeys = [...apiKeyToFrameKeys.keys()];

        console.info(`[NMAP] Streaming ${apiKeys.length} unique analysis keys (${frameEntries.length} frames) for "${src.id}"`);

        let progressive = null;
        let loaded = 0;

        await streamAnalysisFramesAuto(
            src.id, dataKeys, apiKeys, gridInfo,
            async ({ fields, gridInfo: _gi, key: serverKey }) => {
                // All dominant frameKeys that map to this API key
                const frameKeys = apiKeyToFrameKeys.get(serverKey) || [serverKey];
                const primaryFrameKey = frameKeys[0];
                loaded++;

                if (!progressive) {
                    console.info(`[NMAP] First streamed frame "${primaryFrameKey}" — building layers (namespace="${namespace}")`);
                    try {
                        progressive = buildProgressiveMultiLayers(
                            productSuite, primaryFrameKey, fields, grid, namespace
                        );
                    } catch (err) {
                        console.warn(`[NMAP] make_layers failed for first frame "${primaryFrameKey}" — will retry with next frame:`, err);
                        // progressive stays null; the next frame will attempt to build the template
                        return;
                    }
                    for (const ml of progressive.layers) {
                        try { _map.addLayer(ml, 'coastline'); }
                        catch (err) { console.error(`[NMAP] FAILED to add layer "${ml.id}":`, err); }
                    }
                    _activeMultiLayers.push(...progressive.layers);
                    _layerControllers.push(progressive.controller);
                    if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
                    if (progressive.sampler) _activeSampler = progressive.sampler;
                    onFirstFrame?.();
                    // Register any additional dominant keys that share this API key
                    for (let i = 1; i < frameKeys.length; i++) {
                        await progressive.addFrame(frameKeys[i], fields);
                    }
                } else {
                    // Register all dominant keys that map to this API key
                    for (const frameKey of frameKeys) {
                        await progressive.addFrame(frameKey, fields);
                    }
                }
                onProgress?.(loaded, apiKeys.length);
            },
            src.entry,   // contains zarr_transport + variable_map flags
            {
                queryParams,
                apglGrid: grid,
            },
        );

        if (!progressive) {
            console.warn(`[NMAP] No data loaded for "${src.id}" — skipping layer build`);
            return;
        }

        console.info(`[NMAP] Streamed ${loaded}/${totalFrames} frames for "${src.id}/${productId}"`);
        _sourceUpdateState.push({
            srcId: src.id, addFrame: progressive.addFrame, removeFrame: progressive.removeFrame,
            controller: progressive.controller, isPointObs: false, isForecast, dataKeys,
            productSuite, cycleTime: src.cycleTime ?? null,
            srcEntry: src.entry, gridInfo,
            queryParams,
        });

    } else {
        // ────────────────────────────────────────────────────────────────────────────
        // ── Per-frame path for per-file forecast sources (e.g. ECMWF_HR) ──
        // These sources have separate .zarr files per forecast hour, so they
        // cannot use the streaming store endpoint and are fetched individually.
        // ────────────────────────────────────────────────────────────────────────────
        const fetchOneFrame = async ([frameMs, apiKey]) => {
            const frameKey = _dateToKey(new Date(frameMs));
            try {
                const result = await fetchAnalysisFieldsAuto(
                    src.id, dataKeys, apiKey, gridInfo, src.entry,
                    { queryParams, apglGrid: grid }
                );
                return { frameKey, fields: result.fields };
            } catch (err) {
                console.warn(`[NMAP] Failed to fetch frame ${frameKey} for "${src.id}":`, err.message);
                return { frameKey, fields: null };
            }
        };

        // Fetch the first successful frame
        let firstResult = null;
        let firstIndex = 0;
        for (let i = 0; i < frameEntries.length; i++) {
            const r = await fetchOneFrame(frameEntries[i]);
            if (r.fields) {
                firstResult = r;
                firstIndex = i;
                break;
            }
        }

        if (!firstResult) {
            console.warn(`[NMAP] No data loaded for "${src.id}" — skipping layer build`);
            return;
        }

        // Build progressive MultiPlotLayers from the first frame
        console.info(`[NMAP] First frame "${firstResult.frameKey}" arrived — building layers (namespace="${namespace}")`);
        const progressive = buildProgressiveMultiLayers(
            productSuite, firstResult.frameKey, firstResult.fields, grid, namespace
        );

        for (const ml of progressive.layers) {
            try { _map.addLayer(ml, 'coastline'); }
            catch (err) { console.error(`[NMAP] FAILED to add layer "${ml.id}":`, err); }
        }

        _activeMultiLayers.push(...progressive.layers);
        _layerControllers.push(progressive.controller);
        if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
        if (progressive.sampler) _activeSampler = progressive.sampler;
        onFirstFrame?.();
        let loaded = 1;
        onProgress?.(loaded, totalFrames);

        // Keep network requests rolling while preparing one frame at a time.
        const remaining = [
            ...frameEntries.slice(0, firstIndex),
            ...frameEntries.slice(firstIndex + 1),
        ];
        await runRollingFramePipeline(
            remaining,
            fetchOneFrame,
            async ({ frameKey, fields }) => {
                if (fields) {
                    await progressive.addFrame(frameKey, fields);
                    loaded++;
                }
                onProgress?.(loaded, totalFrames);
            },
        );

        console.info(`[NMAP] Loaded ${loaded}/${totalFrames} frames for "${src.id}/${productId}" (per-file)`);
        _sourceUpdateState.push({
            srcId: src.id, addFrame: progressive.addFrame, removeFrame: progressive.removeFrame,
            controller: progressive.controller, isPointObs: false, isForecast, dataKeys,
            productSuite, cycleTime: src.cycleTime ?? null,
            srcEntry: src.entry, gridInfo,
            queryParams,
        });
    }
}


// ═════════════════════════════════════════════════════════════════════════════
// GEOMETRY / ALERT POLYGON LOADING PIPELINE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Load alert polygon data (endpoint_type === 'geometry') for one source
 * across all frame times, then build MultiPlotLayers for looping.
 *
 * The `data_keys` on the product are VTEC phenomenon slugs (e.g. 'flash_flood',
 * 'tornado') or the sentinel '_all' to fetch all phenomena for the source's
 * significance level (Warnings / Watches / Advisories).
 *
 * Each frame fetches one GeoJSON FeatureCollection per slug via:
 *   GET /api/v1/geometries/{sourceId}/features?at=<ISO>&phen=<slug>
 * Slugs are fetched in parallel; all results are combined into a single
 * GeometryComponent PlotLayer by the product's make_layers().
 *
 * Unlike gridded sources, no time-matching against the catalog is performed:
 * the frame times from the dominant source are used directly as `at` values,
 * so the polygons shown always match the active frame's valid time.
 *
 * @param {object} src        - { uid, id, name, color, entry, cycleTime }
 * @param {Date[]} frameTimes - sorted oldest → newest
 */
async function _loadGeometrySource(src, frameTimes, { onFirstFrame, onProgress } = {}) {
    const productId = src.productKey || _pickDefaultProduct(src.id);
    if (!productId) {
        console.warn(`[NMAP] No products available for geometry source "${src.id}" — skipping`);
        return;
    }

    const productSuite = PRODUCT_SUITES[productId];
    const slugs        = productSuite.data_keys;   // e.g. ['flash_flood'] or ['_all']
    const queryParams  = _getSourceQueryParams(src, productSuite);
    const frameMode    = productSuite.frame_mode || (src.entry?.has_fhrs ? 'fhr' : 'valid_time');

    console.info(
        `[NMAP] Geometry source "${src.id}" → product "${productId}" (slugs: [${slugs.join(', ')}])`
    );

    const namespace   = src.uid || src.id;
    const totalFrames = frameTimes.length;

    // Fetch one frame: parallel requests for each slug, build data object.
    const fetchOneFrame = async (frameTime) => {
        const frameKey = _dateToKey(frameTime);
        try {
            const fetchOpts = {
                queryParams,
            };
            if (frameMode === 'cycle') {
                fetchOpts.cycle = _dateToCycleStr(frameTime);
            } else if (frameMode === 'fhr' && src.cycleTime instanceof Date) {
                fetchOpts.cycle = _dateToCycleStr(src.cycleTime);
                fetchOpts.fhr = Math.max(0, Math.round((frameTime.getTime() - src.cycleTime.getTime()) / 3_600_000));
            }

            const data = {};
            await Promise.all(slugs.map(async slug => {
                const phen = slug === '_all' ? undefined : slug;
                data[slug] = await DataClient.fetchGeometryFeatures(src.id, frameKey, {
                    phen,
                    ...fetchOpts,
                });
            }));
            return { frameKey, data };
        } catch (err) {
            console.warn(
                `[NMAP] Failed to fetch geometry frame ${frameKey} for "${src.id}":`,
                err.message
            );
            return { frameKey, data: null };
        }
    };

    // Find first successful frame to bootstrap the progressive layer build.
    let firstResult = null;
    let firstIndex  = 0;
    for (let i = 0; i < frameTimes.length; i++) {
        const r = await fetchOneFrame(frameTimes[i]);
        if (r.data) { firstResult = r; firstIndex = i; break; }
    }

    if (!firstResult) {
        console.warn(`[NMAP] No geometry data loaded for "${src.id}" — skipping layer build`);
        return;
    }

    // Geometry products pass null grid — make_layers() ignores the grid arg.
    console.info(
        `[NMAP] First geometry frame "${firstResult.frameKey}" — building layers (namespace="${namespace}")`
    );
    const progressive = buildProgressiveMultiLayers(
        productSuite, firstResult.frameKey, firstResult.data, null, namespace
    );

    for (const ml of progressive.layers) {
        try { _map.addLayer(ml, 'coastline'); }
        catch (err) { console.error(`[NMAP] FAILED to add geometry layer "${ml.id}":`, err); }
    }
    _activeMultiLayers.push(...progressive.layers);
    _layerControllers.push(progressive.controller);
    if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
    if (progressive.sampler) _activeSampler = progressive.sampler;
    onFirstFrame?.();
    let loaded = 1;
    let lastNonEmptyData = _geometryDataHasFeatures(firstResult.data)
        ? firstResult.data
        : null;
    onProgress?.(loaded, totalFrames);

    // Keep requests rolling while bounding decoded geometry waiting for preparation.
    const remaining = [
        ...frameTimes.slice(0, firstIndex),
        ...frameTimes.slice(firstIndex + 1),
    ];
    await runRollingFramePipeline(
        remaining,
        fetchOneFrame,
        async ({ frameKey, data }) => {
            if (data) {
                await progressive.addFrame(frameKey, data);
                if (_geometryDataHasFeatures(data)) lastNonEmptyData = data;
                loaded++;
            }
            onProgress?.(loaded, totalFrames);
        },
    );

    console.info(
        `[NMAP] Loaded ${loaded}/${totalFrames} geometry frames for "${src.id}/${productId}"`
    );
    _sourceUpdateState.push({
        srcId: src.id, addFrame: progressive.addFrame, removeFrame: progressive.removeFrame,
        controller: progressive.controller, isPointObs: false, isGeometry: true, isForecast: false, dataKeys: slugs,
        productSuite, cycleTime: null,
        queryParams,
        lastNonEmptyData,
    });
}

function _geometryDataHasFeatures(data) {
    if (!data || typeof data !== 'object') return false;
    return Object.values(data).some(value =>
        Array.isArray(value?.features) && value.features.length > 0
    );
}


// ═════════════════════════════════════════════════════════════════════════════
// POINT OBSERVATION LOADING PIPELINE
// =════════════════════════════════════════════════════════════════════════════

/**
 * Load point observation data (endpoint_type === 'point_obs') for one source
 * across all frame times, then build MultiPlotLayers for looping.
 *
 * Key differences from _loadGriddedSource:
 *   - No grid_info call: UnstructuredGrid is built per-frame from the lat/lon
 *     values embedded in the PointResponse, so moving sources (ships, lightning)
 *     update their point positions on every frame step.
 *   - One raw-range Protobuf request covers every overlapping frame window;
 *     frame selection and age calculation happen locally over the unique pool.
 *   - data_keys are forwarded to the backend `fields=` query param so only
 *     the properties the product's SPConfig references are transferred.
 *
 * @param {object} src        - { uid, id, name, color, entry, cycleTime }
 * @param {Date[]} frameTimes - sorted oldest → newest
 */
async function _loadPointObsSource(src, frameTimes, { onFirstFrame, onProgress } = {}) {
    const sourceStarted = performance.now();
    // ── Step A: Pick product + determine which fields to request ──
    const productId = src.productKey || _pickDefaultProduct(src.id);
    if (!productId) {
        console.warn(`[NMAP] No products available for source "${src.id}" — skipping`);
        return;
    }

    const productSuite = PRODUCT_SUITES[productId];
    // data_keys drive the backend `fields=` filter; only listed properties
    // are returned in each PointObs.variables map.
    const dataKeys = productSuite.data_keys;
    const queryParams = _getSourceQueryParams(src, productSuite);

    console.info(
        `[NMAP] Point source "${src.id}" → product "${productId}" (fields: [${dataKeys.join(', ')}])`
    );

    // ── Step B: Match frame times to available API keys ──
    const matchingStarted = performance.now();
    // Point range loading uses the displayed frame dates as window centers and
    // never dereferences matched API keys. This applies equally to dominant and
    // secondary point sources; empty local windows naturally represent missing
    // secondary data without a separate catalog/build_map round trip.
    const frameToKey = new Map(frameTimes.map(frameTime => [
        frameTime.getTime(),
        _dateToKey(frameTime),
    ]));
    const matchingFinished = performance.now();
    if (!frameToKey.size) {
        console.warn(`[NMAP] No matching times found for source "${src.id}" — skipping`);
        return;
    }

    const namespace    = src.uid || src.id;
    const frameEntries = [...frameToKey.entries()];   // [[ms, apiKey], ...]
    const totalFrames  = frameEntries.length;

    // ── Step C: Fetch one raw range and reconstruct frames locally ──
    // Point windows are centered on the displayed (dominant) frame time. The
    // matched source key only establishes that this source has data near the
    // frame; using it as the center can make window boundaries jitter between
    // frames and cause otherwise-current stations to flicker.
    const catalogPolicy = normalizePointPolicy(src.entry || {});
    const frameSpecs = frameEntries.map(([frameMs]) => ({
        frameKey: _dateToKey(new Date(frameMs)),
        centerMs: frameMs,
    }));
    const requiredRange = pointRangeForFrames(frameSpecs, catalogPolicy);

    let rangeResult;
    const rangeRequestStarted = performance.now();
    try {
        rangeResult = await DataClient.fetchDbPointRange(
            src.id,
            dataKeys,
            new Date(requiredRange.startMs),
            new Date(requiredRange.endMs),
            {
                queryParams,
                limit: productSuite.point_range_page_size ?? productSuite.point_range_limit,
                paginate: productSuite.point_range_paginate === true,
            },
        );
    } catch (err) {
        console.warn(`[NMAP] Failed to fetch point range for "${src.id}":`, err.message);
        return;
    }
    const rangeRequestFinished = performance.now();

    // Response metadata is authoritative. Catalog policy is used to calculate
    // the initial range before that response is available.
    const responsePolicy = normalizePointPolicy({
        ...src.entry,
        ...(rangeResult.meta || {}),
    });
    if (rangeResult.meta?.possibly_truncated === 'true') {
        console.warn(
            `[NMAP] Point range for "${src.id}" reached the API row limit; ` +
            'some loop frames may be incomplete.'
        );
    }

    if (productSuite.renderer === 'temporal-scatterometer') {
        const layerBuildStarted = performance.now();
        const progressive = buildTemporalScatterometerLayers(
            productSuite,
            rangeResult.obs_json,
            frameSpecs,
            responsePolicy,
            namespace,
        );
        for (const layer of progressive.layers) {
            try { _map.addLayer(layer, 'coastline'); }
            catch (err) { console.error(`[NMAP] FAILED to add layer "${layer.id}":`, err); }
        }
        _activeMultiLayers.push(...progressive.layers);
        _layerControllers.push(progressive.controller);
        if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
        onFirstFrame?.();
        onProgress?.(totalFrames, totalFrames);
        console.info(`[NMAP timing] Temporal point loop ${src.id}/${productId} prepared`, {
            matchingMs: +(matchingFinished - matchingStarted).toFixed(1),
            requestAndDecodeMs: +(rangeRequestFinished - rangeRequestStarted).toFixed(1),
            layerBuildMs: +(performance.now() - layerBuildStarted).toFixed(1),
            observations: rangeResult.obs_json.length,
            framesPrepared: totalFrames,
            gpuUploadsPerFrameStep: 0,
            sourceTotalMs: +(performance.now() - sourceStarted).toFixed(1),
        });
        _sourceUpdateState.push({
            srcId: src.id,
            addFrame: progressive.addFrame,
            removeFrame: progressive.removeFrame,
            controller: progressive.controller,
            isPointObs: true,
            isForecast: false,
            dataKeys,
            productSuite,
            cycleTime: null,
            queryParams,
        });
        return;
    }

    const reconstructionStarted = performance.now();
    const dataByFrame = buildPointFrames(
        rangeResult.obs_json,
        frameSpecs,
        responsePolicy,
    );
    const frameResults = frameSpecs.map(({ frameKey }) => ({
        frameKey,
        data: dataByFrame.get(frameKey),
    }));
    const reconstructionFinished = performance.now();

    // Find a non-empty frame to bootstrap the progressive layer build.
    let firstIndex = frameResults.findIndex(result => result.data?.obs_json?.length);
    if (firstIndex < 0) firstIndex = frameResults.findIndex(result => result.data);
    const firstResult = firstIndex >= 0 ? frameResults[firstIndex] : null;

    if (!firstResult) {
        console.warn(`[NMAP] No data loaded for "${src.id}" — skipping layer build`);
        return;
    }

    // Build progressive layers (null grid: point products build their own
    // UnstructuredGrid inside make_layers from the obs coords)
    console.info(
        `[NMAP] First point frame "${firstResult.frameKey}" — building layers (namespace="${namespace}")`
    );
    const frameBuildDurations = [];
    let frameBuildStarted = performance.now();
    const progressive = buildProgressiveMultiLayers(
        productSuite, firstResult.frameKey, firstResult.data, null, namespace
    );
    frameBuildDurations.push({ key: firstResult.frameKey, ms: performance.now() - frameBuildStarted });

    for (const ml of progressive.layers) {
        try { _map.addLayer(ml, 'coastline'); }
        catch (err) { console.error(`[NMAP] FAILED to add layer "${ml.id}":`, err); }
    }
    _activeMultiLayers.push(...progressive.layers);
    _layerControllers.push(progressive.controller);
    if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
    if (progressive.sampler) _activeSampler = progressive.sampler;
    onFirstFrame?.();
    let loaded = 1;
    onProgress?.(loaded, totalFrames);

    // All remaining frames are local views over the same decoded pool.
    const remaining = [
        ...frameResults.slice(0, firstIndex),
        ...frameResults.slice(firstIndex + 1),
    ];
    await runRollingFramePipeline(
        remaining,
        result => Promise.resolve(result),
        async ({ frameKey, data }) => {
            if (data) {
                frameBuildStarted = performance.now();
                await progressive.addFrame(frameKey, data);
                frameBuildDurations.push({ key: frameKey, ms: performance.now() - frameBuildStarted });
                loaded++;
            }
            onProgress?.(loaded, totalFrames);
        },
        // Point frames are already local, so there is no benefit to multiple
        // fetch slots; the pipeline is used here for its between-frame yield.
        { networkConcurrency: 1, maxBufferedItems: 1 },
    );

    console.info(`[NMAP] Loaded ${loaded}/${totalFrames} point frames for "${src.id}/${productId}"`);
    const frameBuildTotal = frameBuildDurations.reduce((sum, item) => sum + item.ms, 0);
    const slowestFrame = frameBuildDurations.reduce(
        (slowest, item) => (!slowest || item.ms > slowest.ms) ? item : slowest,
        null,
    );
    console.info(`[NMAP timing] Point loop ${src.id}/${productId} prepared`, {
        matchingMs: +(matchingFinished - matchingStarted).toFixed(1),
        requestAndDecodeMs: +(rangeRequestFinished - rangeRequestStarted).toFixed(1),
        frameReconstructionMs: +(reconstructionFinished - reconstructionStarted).toFixed(1),
        frameLayerBuildTotalMs: +frameBuildTotal.toFixed(1),
        averageFrameLayerBuildMs: +(frameBuildTotal / frameBuildDurations.length).toFixed(1),
        slowestFrame: slowestFrame && { key: slowestFrame.key, ms: +slowestFrame.ms.toFixed(1) },
        observations: rangeResult.obs_json.length,
        framesPrepared: frameBuildDurations.length,
        sourceTotalMs: +(performance.now() - sourceStarted).toFixed(1),
    });
    _sourceUpdateState.push({
        srcId: src.id, addFrame: progressive.addFrame, removeFrame: progressive.removeFrame,
        controller: progressive.controller, isPointObs: true, isForecast: false, dataKeys,
        productSuite, cycleTime: null,
        queryParams,
    });
}


// ═════════════════════════════════════════════════════════════════════════════
// PROFILE OBSERVATION LOADING PIPELINE
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Load profile observation data (endpoint_type === 'profile_obs') across all
 * frame times, then build MultiPlotLayers for looping.
 *
 * Uses the same progressive layer path as point_obs but fetches from
 * /api/v1/db-profiles/{sourceId} and forwards normalized obs_json payloads to
 * profile products.
 *
 * @param {object} src        - { uid, id, name, color, entry, cycleTime }
 * @param {Date[]} frameTimes - sorted oldest → newest
 */
async function _loadProfileObsSource(src, frameTimes, { onFirstFrame, onProgress } = {}) {
    const productId = src.productKey || _pickDefaultProduct(src.id);
    if (!productId) {
        console.warn(`[NMAP] No products available for profile source "${src.id}" — skipping`);
        return;
    }

    const productSuite = PRODUCT_SUITES[productId];
    const queryParams = _getSourceQueryParams(src, productSuite);

    console.info(`[NMAP] Profile source "${src.id}" → product "${productId}"`);

    const isDominant = src.id === (_currentLoadConfig?.dominantId);
    const frameToKey = isDominant
        ? await _matchAnalysisFrames(src, frameTimes, queryParams)
        : await _matchFramesViaApi(src, frameTimes, queryParams);
    if (!frameToKey.size) {
        console.warn(`[NMAP] No matching times found for profile source "${src.id}" — skipping`);
        return;
    }

    const namespace = src.uid || src.id;
    const frameEntries = [...frameToKey.entries()];
    const totalFrames = frameEntries.length;

    const fetchOneFrame = async ([frameMs, apiKey]) => {
        const frameKey = _dateToKey(new Date(frameMs));
        try {
            const { obs_json } = await DataClient.fetchDbProfiles(src.id, apiKey, {
                queryParams,
            });
            return { frameKey, data: { obs_json } };
        } catch (err) {
            console.warn(`[NMAP] Failed to fetch profile frame ${frameKey} for "${src.id}":`, err.message);
            return { frameKey, data: null };
        }
    };

    let firstResult = null;
    let firstIndex = 0;
    for (let i = 0; i < frameEntries.length; i++) {
        const r = await fetchOneFrame(frameEntries[i]);
        if (r.data) {
            firstResult = r;
            firstIndex = i;
            break;
        }
    }

    if (!firstResult) {
        console.warn(`[NMAP] No profile data loaded for "${src.id}" — skipping layer build`);
        return;
    }

    console.info(`[NMAP] First profile frame "${firstResult.frameKey}" — building layers (namespace="${namespace}")`);
    const progressive = buildProgressiveMultiLayers(
        productSuite, firstResult.frameKey, firstResult.data, null, namespace
    );

    for (const ml of progressive.layers) {
        try { _map.addLayer(ml, 'coastline'); }
        catch (err) { console.error(`[NMAP] FAILED to add layer "${ml.id}":`, err); }
    }
    _activeMultiLayers.push(...progressive.layers);
    _layerControllers.push(progressive.controller);
    if (progressive.colorbars?.length) _activeColorbars.push(...progressive.colorbars);
    if (progressive.sampler) _activeSampler = progressive.sampler;
    onFirstFrame?.();

    let loaded = 1;
    onProgress?.(loaded, totalFrames);

    const remaining = [
        ...frameEntries.slice(0, firstIndex),
        ...frameEntries.slice(firstIndex + 1),
    ];
    await runRollingFramePipeline(
        remaining,
        fetchOneFrame,
        async ({ frameKey, data }) => {
            if (data) {
                await progressive.addFrame(frameKey, data);
                loaded++;
            }
            onProgress?.(loaded, totalFrames);
        },
    );

    console.info(`[NMAP] Loaded ${loaded}/${totalFrames} profile frames for "${src.id}/${productId}"`);
    _sourceUpdateState.push({
        srcId: src.id, addFrame: progressive.addFrame, removeFrame: progressive.removeFrame,
        controller: progressive.controller, isPointObs: true, isProfileObs: true, isForecast: false, dataKeys: [],
        productSuite, cycleTime: null,
        queryParams,
    });
}


// ═════════════════════════════════════════════════════════════════════════════
// TIME MATCHING
// ═════════════════════════════════════════════════════════════════════════════
//
// The challenge: the LayerManager gives us frame times as Date objects,
// but the API expects specific key strings (like "20260227_0000" or
// "2025030218_f006").  Different sources have different key formats.
//
// Our approach:
//   1. Fetch the available times catalog for the source (with full metadata)
//   2. Parse the valid_time strings into Date objects
//   3. Use TimeMatcher to find the nearest available time for each frame
//   4. Return the matched API key string

/**
 * Match frame times to an analysis/observation source's available times.
 *
 * @param {object} src - Source config from LayerManager
 * @param {Date[]} frameTimes - Frame times to match
 * @returns {Promise<Map<number, string>>} Map from frame ms → API key string
 */
/**
 * Match frame times to a secondary source using the server-side build_map
 * endpoint.  This enforces the same 1-hour window as the timematch API so
 * secondary sources never show stale data when the dominant source advances
 * beyond the secondary archive.
 *
 * Falls back to client-side _matchAnalysisFrames if the API call fails.
 *
 * @param {object} src        - Source config from LayerManager
 * @param {Date[]} frameTimes - Frame times (dominant valid times) to match
 * @returns {Promise<Map<number, string>>} Map from frame ms → matched API key string
 */
async function _matchFramesViaApi(src, frameTimes, queryParams) {
    const dominantId = _currentLoadConfig?.dominantId;
    if (!dominantId || !frameTimes.length) {
        return _matchAnalysisFrames(src, frameTimes, queryParams);
    }

    const frameKeys = frameTimes.map(_dateToKey);
    try {
        const tmResult = await CatalogClient.buildTimemap(
            dominantId,
            [src.id],
            frameKeys,
            1.0,   // 1-hour window — matches the server-side default
        );
        const timemap = tmResult.map ?? {};
        const result  = new Map();
        for (const frameTime of frameTimes) {
            const frameKey    = _dateToKey(frameTime);
            const matchedKey  = timemap[frameKey]?.[src.id] ?? null;
            if (matchedKey) {
                result.set(frameTime.getTime(), matchedKey);
            }
        }
        console.info(
            `[NMAP] _matchFramesViaApi("${src.id}"): ${result.size}/${frameTimes.length} frames matched via build_map`
        );
        return result;
    } catch (err) {
        console.warn(
            `[NMAP] build_map failed for "${src.id}", falling back to client matching:`, err.message
        );
        return _matchAnalysisFrames(src, frameTimes, queryParams);
    }
}

async function _matchAnalysisFrames(src, frameTimes, queryParams) {
    const result = new Map();

    // Fetch available times with full metadata from the API
    const timeObjects = await CatalogClient.listTimesDetailed(src.id, {
        limit: 500,
        queryParams,
    });
    console.warn(`[NMAP] _matchAnalysisFrames("${src.id}"): got ${timeObjects.length} time objects from API`);
    if (timeObjects.length) {
        console.warn(`[NMAP]   first time:`, timeObjects[0]);
        console.warn(`[NMAP]   last time:`, timeObjects[timeObjects.length - 1]);
    }
    if (!timeObjects.length) {
        console.warn(`[NMAP] No available times for source "${src.id}"`);
        return result;
    }

    // Build a lookup table: millisecond timestamp → time object
    // (Like a Python dict: { date.timestamp() * 1000: time_obj })
    const timeByMs = new Map();
    const candidateDates = [];
    for (const t of timeObjects) {
        const date = new Date(t.valid_time);
        if (Number.isFinite(date.getTime())) {
            timeByMs.set(date.getTime(), t);
            candidateDates.push(date);
        }
    }

    // Use TimeMatcher to find the nearest available time for each frame.
    // 3-hour tolerance (in ms) allows matching across typical data gaps.
    const TOLERANCE_MS = 3 * 60 * 60 * 1000;

    for (const frameTime of frameTimes) {
        const match = window.TimeMatcher.findNearest(frameTime, candidateDates, {
            mode: 'nearest',
            toleranceMs: TOLERANCE_MS,
        });
        if (match.matched && match.matchedTime) {
            const timeObj = timeByMs.get(match.matchedTime.getTime());
            if (timeObj) {
                result.set(frameTime.getTime(), timeObj.key);
            }
        }
    }

    return result;
}

/**
 * Match frame times to a forecast source's cycle/fhr combinations.
 *
 * For forecast data, each frame's valid time = cycleTime + fhr * 3600000.
 * We fetch available forecast hours for the cycle and match accordingly.
 *
 * @param {object} src - Source config (must have src.cycleTime as Date)
 * @param {Date[]} frameTimes - Frame times to match
 * @returns {Promise<Map<number, string>>} Map from frame ms → API key string
 */
async function _matchForecastFrames(src, frameTimes, queryParams) {
    const result = new Map();
    const cycleStr = _dateToCycleStr(src.cycleTime);

    try {
        // Fetch available forecast hours: { fhrs: [0,1,2,...], keys: [...] }
        const fhrData = await CatalogClient.listFhrs(src.id, cycleStr, {
            queryParams,
        });

        // Build a map: validTime (ms) → API key
        const validTimeToKey = new Map();
        for (let i = 0; i < fhrData.fhrs.length; i++) {
            const validMs = src.cycleTime.getTime() + fhrData.fhrs[i] * 3_600_000;
            validTimeToKey.set(validMs, fhrData.keys[i]);
        }

        // Time-match with 1.5-hour tolerance for forecast data
        const candidateDates = [...validTimeToKey.keys()].map(ms => new Date(ms));
        const TOLERANCE_MS = 1.5 * 60 * 60 * 1000;

        for (const frameTime of frameTimes) {
            const match = window.TimeMatcher.findNearest(frameTime, candidateDates, {
                mode: 'nearest',
                toleranceMs: TOLERANCE_MS,
            });
            if (match.matched && match.matchedTime) {
                const key = validTimeToKey.get(match.matchedTime.getTime());
                if (key) result.set(frameTime.getTime(), key);
            }
        }
    } catch (err) {
        console.warn(
            `[NMAP] Failed to fetch fhrs for "${src.id}" cycle ${cycleStr}:`,
            err.message
        );
    }

    return result;
}


// ═════════════════════════════════════════════════════════════════════════════
// FRAME MANAGEMENT — stepping through timeline frames
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Set the current frame index and update everything.
 *
 * This is the function that makes looping work:
 *   1. Updates _currentFrameIdx
 *   2. Calls setKey() on every MultiPlotLayer controller
 *   3. autumnplot-gl swaps the GPU texture (no flicker!)
 *   4. Updates the frame time display
 *
 * @param {number} idx - Frame index (0 = oldest, length-1 = newest)
 */
function _setFrame(idx) {
    if (!_frameTimes.length) {
        _currentFrameIdx = -1;
        _updateFrameDisplay();
        return;
    }

    // Clamp to valid range
    _currentFrameIdx = Math.max(0, Math.min(_frameTimes.length - 1, idx));

    // Tell each source's MultiPlotLayer controller to switch to this frame
    const key = _frameKeys[_currentFrameIdx];
    const frameNumber = _currentFrameIdx + 1;
    const renderStarted = performance.now();
    console.warn(`[NMAP] _setFrame(${idx}) → idx=${_currentFrameIdx} key="${key}"`);
    console.warn(`[NMAP]   _layerControllers.length=${_layerControllers.length}`);
    console.warn(`[NMAP]   _activeMultiLayers.length=${_activeMultiLayers.length}`);
    for (const ctrl of _layerControllers) {
        // Only set the key if this controller has data for that frame.
        // (Some sources might be missing certain frames due to time matching.)
        console.warn(`[NMAP]   controller keys: [${ctrl.keys.join(', ')}]`);
        if (ctrl.keys.includes(key)) {
            ctrl.setKey(key);
            // Swap the active sampler to whichever frame is now displayed.
            // Geometry products (alerts) return a per-frame sampler closure.
            const s = ctrl.getSampler?.();
            if (s) _activeSampler = s;
            console.warn(`[NMAP]   → set key "${key}" on controller`);
        } else {
            // No data for this frame — hide the layer so the previous frame
            // doesn't linger on screen.  MultiPlotLayer.render() is a no-op
            // when field_key is null.
            ctrl.hide?.();
            console.warn(`[NMAP]   → key "${key}" NOT found in controller keys — hiding`);
        }
    }

    _updateFrameDisplay();
    _updateMapTitle(_frameTimes[_currentFrameIdx]);

    // MapLibre's render event marks completion of the next map render pass.
    // This measures UI-visible frame-switch latency (not a GPU timer query).
    _map.once('render', () => {
        const elapsed = performance.now() - renderStarted;
        console.info(`[NMAP timing] Frame ${frameNumber}/${_frameTimes.length} ${key} render event: ${elapsed.toFixed(1)} ms`);
        if (!_loopRenderTiming || _loopRenderTiming.seen.has(key)) return;
        _loopRenderTiming.seen.add(key);
        _loopRenderTiming.samples.push(elapsed);
        if (_loopRenderTiming.seen.size === _frameKeys.length) {
            const samples = _loopRenderTiming.samples;
            const total = samples.reduce((sum, value) => sum + value, 0);
            console.info('[NMAP timing] Full playback loop render summary', {
                frames: samples.length,
                elapsedWallMs: +(performance.now() - _loopRenderTiming.started).toFixed(1),
                renderLatencyTotalMs: +total.toFixed(1),
                averageRenderLatencyMs: +(total / samples.length).toFixed(1),
                minRenderLatencyMs: +Math.min(...samples).toFixed(1),
                maxRenderLatencyMs: +Math.max(...samples).toFixed(1),
            });
            _loopRenderTiming = null;
        }
    });
}

/**
 * Step forward or backward by `delta` frames, wrapping around at the ends.
 */
function _stepFrame(delta) {
    if (!_frameTimes.length) return;
    let next = _currentFrameIdx + delta;
    if (next < 0) next = _frameTimes.length - 1;         // wrap to end
    if (next >= _frameTimes.length) next = 0;             // wrap to start
    _setFrame(next);
}

/**
 * Update the frame time display in the toolbar.
 * Shows: "DD Mon YYYY HH:MM UTC [N/Total]"
 */
function _updateFrameDisplay() {
    if (!_frameTimeEl) return;
    const cur = (_currentFrameIdx >= 0 && _currentFrameIdx < _frameTimes.length)
        ? _frameTimes[_currentFrameIdx]
        : null;

    if (!cur) {
        _frameTimeEl.textContent = '--';
        return;
    }

    const pad = n => String(n).padStart(2, '0');
    const months = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];
    _frameTimeEl.textContent =
        `${pad(cur.getUTCDate())} ${months[cur.getUTCMonth()]} ${cur.getUTCFullYear()} ` +
        `${pad(cur.getUTCHours())}:${pad(cur.getUTCMinutes())} UTC ` +
        `[${_currentFrameIdx + 1}/${_frameTimes.length}]`;
}

/** Set the frame display to arbitrary text (e.g. "Loading...") */
function _setFrameDisplayText(text) {
    if (_frameTimeEl) _frameTimeEl.textContent = text;
}


// ─── Playback (looping) ──────────────────────────────────────────────────────

function _stopPlayback() {
    if (_playbackTimer) {
        clearInterval(_playbackTimer);
        _playbackTimer = null;
    }
    if (_loopEndTimeout) {
        clearTimeout(_loopEndTimeout);
        _loopEndTimeout = null;
    }
    _playbackMode = 'pause';
    _loopRenderTiming = null;
}

/**
 * Start or stop playback in the given mode.
 * Clicking the same mode again stops playback (toggle behavior).
 */
function _togglePlayback(mode) {
    if (!_frameTimes.length) return;

    // If asked to pause, stop any timer and return immediately. This prevents
    // accidentally starting a no-op interval when mode === 'pause'.
    if (mode === 'pause') {
        _stopPlayback();
        return;
    }

    // Clicking the same mode while playing → stop (also catches the end-of-loop pause)
    if (_playbackMode === mode && (_playbackTimer || _loopEndTimeout)) {
        _stopPlayback();
        return;
    }

    _stopPlayback();
    _playbackMode = mode;
    if (mode === 'rock') _rockDirection = 1;
    _loopRenderTiming = {
        started: performance.now(),
        seen: new Set(),
        samples: [],
    };

    // Named tick function so the end-of-loop pause can restart the same interval.
    const tick = () => {
        switch (_playbackMode) {
            case 'loop-fwd': {
                const next = _currentFrameIdx + 1;
                if (next >= _frameTimes.length) {
                    // Reached the last frame — hold for END_OF_LOOP_PAUSE_MS before wrapping.
                    clearInterval(_playbackTimer);
                    _playbackTimer = null;
                    _loopEndTimeout = setTimeout(() => {
                        _loopEndTimeout = null;
                        if (_playbackMode !== 'loop-fwd') return;
                        _setFrame(0);
                        _playbackTimer = setInterval(tick, PLAY_INTERVAL_MS);
                    }, END_OF_LOOP_PAUSE_MS);
                } else {
                    _setFrame(next);
                }
                break;
            }
            case 'loop-back': {
                const next = _currentFrameIdx - 1;
                if (next < 0) {
                    // Reached the first frame — hold for END_OF_LOOP_PAUSE_MS before wrapping.
                    clearInterval(_playbackTimer);
                    _playbackTimer = null;
                    _loopEndTimeout = setTimeout(() => {
                        _loopEndTimeout = null;
                        if (_playbackMode !== 'loop-back') return;
                        _setFrame(_frameTimes.length - 1);
                        _playbackTimer = setInterval(tick, PLAY_INTERVAL_MS);
                    }, END_OF_LOOP_PAUSE_MS);
                } else {
                    _setFrame(next);
                }
                break;
            }
            case 'rock': {
                if (_frameTimes.length <= 1) { _setFrame(0); break; }
                let next = _currentFrameIdx + _rockDirection;
                if (next >= _frameTimes.length) {
                    _rockDirection = -1;
                    next = _frameTimes.length - 2;
                } else if (next < 0) {
                    _rockDirection = 1;
                    next = 1;
                }
                _setFrame(next);
                break;
            }
        }
    };

    _playbackTimer = setInterval(tick, PLAY_INTERVAL_MS);
}


// ═════════════════════════════════════════════════════════════════════════════
// MAP LAYER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

/** Remove all active layers from the map and reset tracking state. */
function _clearActiveLayers() {
    _stopPlayback();

    // Remove each MultiPlotLayer from MapLibre
    for (const ml of _activeMultiLayers) {
        try {
            if (_map.getLayer(ml.id)) _map.removeLayer(ml.id);
        } catch (e) { /* best-effort cleanup */ }
    }

    _activeMultiLayers = [];
    _layerControllers  = [];
    _activeColorbars   = [];
    _activeSampler     = null;
    if (_samplerPopupEl) _samplerPopupEl.classList.add('hidden');
    _frameTimes        = [];
    _frameKeys         = [];
    _currentFrameIdx   = -1;
    _loopRenderTiming  = null;

    // Hide the title panel (keep it in the DOM for reuse on next load)
    if (_titleEl) {
        _titleEl.style.display = 'none';
        _titleEl.innerHTML = '';
    }

    _updateFrameDisplay();
}

/** Render colorbar SVGs in the bottom panel. */
function _renderColorbars() {
    if (!_colorbarContainer || !_colorbarPanel) return;
    _colorbarContainer.innerHTML = '';

    if (_activeColorbars.length) {
        _activeColorbars.forEach(cb => _colorbarContainer.appendChild(cb));
        _colorbarPanel.classList.remove('hidden');
    } else {
        _colorbarPanel.classList.add('hidden');
    }
}

/**
 * Ensure the map-title panel element exists inside the map container.
 *
 * Uses CSS `position: absolute` relative to `#map` so the panel is always
 * locked to the bottom-center of the visible map viewport.  It does NOT
 * move when the user pans or zooms — unlike a MapLibre Marker.
 *
 * Called once when the first frame of a new load session is ready.
 */
function _createTitleEl() {
    if (_titleEl) {
        // Already attached from a previous load — just make sure it's visible.
        return;
    }
    const el = document.createElement('div');
    el.id = 'map-title-panel';
    el.style.display = 'none';
    // Append inside the MapLibre container so it is clipped by the map bounds
    // and sits at `position: absolute` bottom-center via CSS.
    _map.getContainer().appendChild(el);
    _titleEl = el;
}

/**
 * Rebuild the stacked title lines for the given valid time and push them
 * into the title marker element.
 *
 * One title line is produced per active source (in load order).  Products
 * without a `title` template fall back to an auto-generated line using the
 * product's `label` plus the appropriate time prefix.
 *
 * @param {Date|undefined} validTime - The current frame's valid time.
 */
function _updateMapTitle(validTime) {
    if (!_titleEl) return;

    if (!validTime || !Number.isFinite(validTime?.getTime())) {
        _titleEl.style.display = 'none';
        return;
    }

    const lines = [];
    for (const state of _sourceUpdateState) {
        const suite = state.productSuite;
        if (!suite) continue;

        // Resolve template: explicit > auto-generate from label
        let template = suite.title ?? null;
        if (!template) {
            const label = suite.label ?? '';
            if (state.isForecast && state.cycleTime) {
                template = `{cycle_YYYY}-{cycle_MM}-{cycle_DD}  {cycle_HH}z  {source}  F{fhr3}  ${label}`;
            } else {
                template = `{valid_YYYY}-{valid_MM}-{valid_DD}  {valid_HH}{valid_mm} UTC  {source}  ${label}`;
            }
        }

        // Compute forecast hour from valid–cycle delta (rounded to nearest hour)
        let fhr = null;
        if (state.isForecast && state.cycleTime) {
            fhr = Math.round((validTime.getTime() - state.cycleTime.getTime()) / 3_600_000);
        }

        const line = resolveTitle(template, {
            validTime,
            cycleTime: state.cycleTime ?? null,
            fhr,
            sourceId: state.srcId,
        });

        if (line) lines.push(line);
    }

    if (lines.length === 0) {
        _titleEl.style.display = 'none';
    } else {
        _titleEl.style.display = '';
        _titleEl.innerHTML = lines
            .map(l => `<div class="map-title-line">${_escHtml(l)}</div>`)
            .join('');
    }
}

/** Set up mouse-move readout showing lat/lon + sampled data values. */
function _setupReadout() {
    if (_mousemoveHandler) {
        _map.off('mousemove', _mousemoveHandler);
        _mousemoveHandler = null;
    }

    _mousemoveHandler = (ev) => {
        const coord = ev.lngLat.wrap();
        const lat = coord.lat.toFixed(2);
        const lon = coord.lng.toFixed(2);
        let text = `${lat}°N ${lon}°E`;

        // Collect results from every active controller that has a sampler for
        // the current key.  Also fall back to the legacy _activeSampler for
        // products that don't yet expose getSampler().
        /** @type {Array<{key: string, val: *}>} */
        const hits = [];

        for (const ctrl of _layerControllers) {
            const sampler = ctrl.getSampler?.();
            if (!sampler) continue;
            try {
                const result = sampler(coord.lng, coord.lat, { zoom: _map.getZoom() });
                if (result) {
                    for (const [k, v] of Object.entries(result)) hits.push({ key: k, val: v });
                }
            } catch (_) { /* can fail at map edges */ }
        }

        // Legacy fallback — samplers from non-progressive paths
        if (hits.length === 0 && _activeSampler) {
            try {
                const result = _activeSampler(coord.lng, coord.lat, { zoom: _map.getZoom() });
                if (result) {
                    for (const [k, v] of Object.entries(result)) hits.push({ key: k, val: v });
                }
            } catch (_) { /* ignore */ }
        }

        if (hits.length) {
            const parts = hits.map(({ key, val }) =>
                Array.isArray(val)
                    ? `${key}: ${val[0].toFixed(0)}/${val[1].toFixed(0)}`
                    : typeof val === 'string'
                        ? `${key}: ${val}`
                        : `${key}: ${val.toFixed(1)}`
            );
            text += ` | ${parts.join(', ')}`;
        }

        if (_readoutEl) _readoutEl.textContent = text;

        // ── Cursor popup ─────────────────────────────────────────────────────
        if (_samplerEnabled && _samplerPopupEl) {
            if (hits.length) {
                // Build rows: one per sampler key-value pair
                _samplerPopupEl.innerHTML = hits.map(({ key, val }) => {
                    let display;
                    if (Array.isArray(val)) {
                        display = `${val[0].toFixed(0)} / ${val[1].toFixed(0)}`;
                    } else if (typeof val === 'string') {
                        display = val;
                    } else {
                        display = val.toFixed(1);
                    }
                    return `<div class="sp-row"><span class="sp-key">${key}:</span><span class="sp-val">${display}</span></div>`;
                }).join('');

                // Position the popup at the raw pixel position of the mouse
                const px = ev.originalEvent;
                _samplerPopupEl.style.left = `${px.clientX}px`;
                _samplerPopupEl.style.top  = `${px.clientY}px`;
                _samplerPopupEl.classList.remove('hidden');
            } else {
                _samplerPopupEl.classList.add('hidden');
            }
        }
    };

    // Hide popup when mouse leaves the map
    _map.on('mouseout', () => {
        if (_samplerPopupEl) _samplerPopupEl.classList.add('hidden');
    });

    _map.on('mousemove', _mousemoveHandler);
}

/**
 * Start listening for SSE new-data events and wire them to frame appending.
 *
 * Connects to /api/v1/events/data (EventSource, text/event-stream).
 * When a "new_data" event arrives for the dominant source we fetch the new
 * frame, time-match secondaries via the build_map API, append all frames,
 * then drop the oldest to keep the frame count constant.
 */
function _startAutoUpdate() {
    if (_autoUpdateSse) return;  // already running
    _autoUpdateActive = true;

    const es = new EventSource('/api/v1/events/data');
    _autoUpdateSse = es;

    es.addEventListener('connected', () => {
        console.warn('[NMAP] Auto-update SSE connected');
    });

    es.addEventListener('new_data', (ev) => {
        let payload;
        try { payload = JSON.parse(ev.data); } catch (err) { console.warn('[NMAP] SSE parse error:', err); return; }
        console.warn('[NMAP] SSE new_data received:', payload);
        _handleNewDataEvent(payload);
    });

    es.addEventListener('message', (ev) => {
        // Fallback: some proxies strip the event: line, routing named events as 'message'
        console.warn('[NMAP] SSE message (unnamed event):', ev.data);
    });

    es.addEventListener('heartbeat', () => {
        console.warn('[NMAP] SSE heartbeat');
    });

    es.onerror = (err) => {
        console.warn('[NMAP] Auto-update SSE error — will reconnect automatically', err);
        // EventSource reconnects automatically; no manual action needed
    };

    console.info('[NMAP] Auto-update started (SSE)');
}

/** Stop the SSE connection and disable auto-update. */
function _stopAutoUpdate() {
    _autoUpdateActive = false;
    if (_autoUpdateSse) {
        _autoUpdateSse.close();
        _autoUpdateSse = null;
    }
    console.info('[NMAP] Auto-update stopped');
}

/**
 * Called for every SSE "new_data" event.
 * Only acts when the event is for the currently dominant source.
 */
function _handleNewDataEvent(payload) {
    console.warn('[NMAP] SSE _handleNewDataEvent: active=', _autoUpdateActive,
        '| configDominant=', _currentLoadConfig?.dominantId,
        '| payloadSource=', payload?.source_id,
        '| stateEntries=', _sourceUpdateState.length);
    if (!_currentLoadConfig) { console.warn('[NMAP] Auto-update blocked: no load config'); return; }
    if (payload.source_id !== _currentLoadConfig.dominantId) {
        console.warn(`[NMAP] Auto-update blocked: source_id mismatch — got "${payload.source_id}", dominant is "${_currentLoadConfig.dominantId}"`);
        return;
    }
    if (!_autoUpdateActive) { console.warn('[NMAP] Auto-update blocked: not active'); return; }

    _applyNewDominantFrame(payload).catch(err => {
        console.error('[NMAP] Auto-update error:', err);
    });
}

/**
 * Fetch and append a new dominant-source frame (plus time-matched secondary frames),
 * then drop the oldest frame to keep the total frame count constant.
 *
 * @param {{ source_id: string, key: string, valid_time: string }} payload  SSE event data
 */
async function _applyNewDominantFrame({ source_id, key, valid_time }) {
    // ── Guard: dedup in-flight requests for the same key ──
    if (_autoUpdatePending.has(key)) return;

    // ── Guard: parse the new valid time ──
    const newDate = new Date(valid_time);
    if (!Number.isFinite(newDate.getTime())) {
        console.warn('[NMAP] Auto-update: invalid valid_time in SSE payload', valid_time);
        return;
    }

    // ── Guard: we need a dominant progressive state to append to ──
    const dominantState = _sourceUpdateState.find(
        s => s.srcId === source_id && !s.isForecast
    );
    if (!dominantState) return;

    // ── Guard: don't add a key we already display ──
    if (_frameKeys.includes(key)) return;

    _autoUpdatePending.add(key);
    console.info(`[NMAP] Auto-update: ingesting new dominant frame ${key} (${source_id})`);

    try {
        // ── 1. Fetch the new dominant-source frame ──
        let dominantFields;
        try {
            const result = await fetchAnalysisFieldsAuto(
                source_id, dominantState.dataKeys, key,
                dominantState.gridInfo, dominantState.srcEntry,
                { queryParams: dominantState.queryParams }
            );
            dominantFields = result.fields;
        } catch (err) {
            console.warn(`[NMAP] Auto-update: failed to fetch ${source_id} key=${key}:`, err.message);
            return;
        }

        // ── 2. Time-match secondary sources via the build_map API ──
        const secondaryStates = _sourceUpdateState.filter(s => s.srcId !== source_id);
        let timemap = null;
        if (secondaryStates.length > 0) {
            try {
                const tmResult = await CatalogClient.buildTimemap(
                    source_id,
                    secondaryStates.map(s => s.srcId),
                    [key],
                    3
                );
                timemap = tmResult.map;
            } catch (err) {
                console.warn('[NMAP] Auto-update: build_map failed:', err.message);
            }
        }

        // ── 3. Append the new dominant frame (using the SSE key as canonical key) ──
        dominantState.addFrame(key, dominantFields);

        // ── 4. Append new secondary frames ──
        for (const secState of secondaryStates) {
            // Skip if this canonical key is already registered in the secondary controller
            if (secState.controller.keys.includes(key)) continue;

            // Geometry sources (alerts, watches, etc.) are fetched directly at the
            // dominant frame's valid time — they don't go through the gridded endpoint.
            if (secState.isGeometry) {
                try {
                    const frameMode = secState.productSuite?.frame_mode || 'valid_time';
                    const data = {};
                    await Promise.all(secState.dataKeys.map(async slug => {
                        const phen = slug === '_all' ? undefined : slug;
                        const fetchOpts = {
                            phen,
                            queryParams: secState.queryParams,
                        };
                        if (frameMode === 'cycle') {
                            fetchOpts.cycle = _dateToCycleStr(newDate);
                        } else if (frameMode === 'fhr' && secState.cycleTime instanceof Date) {
                            fetchOpts.cycle = _dateToCycleStr(secState.cycleTime);
                            fetchOpts.fhr = Math.max(0, Math.round((newDate.getTime() - secState.cycleTime.getTime()) / 3_600_000));
                        }
                        data[slug] = await DataClient.fetchGeometryFeatures(secState.srcId, key, fetchOpts);
                    }));
                    if (_geometryDataHasFeatures(data)) {
                        secState.lastNonEmptyData = data;
                        secState.addFrame(key, data);
                    } else if (
                        secState.srcId === 'FAA_ASDI' &&
                        secState.lastNonEmptyData
                    ) {
                        console.warn(
                            `[NMAP] FAA_ASDI returned no tracks for ${key}; ` +
                            'carrying forward the last valid frame'
                        );
                        secState.addFrame(key, secState.lastNonEmptyData);
                    } else {
                        secState.addFrame(key, data);
                    }
                } catch (err) {
                    console.warn(
                        `[NMAP] Auto-update: failed to fetch geometry ${secState.srcId} key=${key}:`,
                        err.message
                    );
                    if (
                        secState.srcId === 'FAA_ASDI' &&
                        secState.lastNonEmptyData
                    ) {
                        console.warn(
                            `[NMAP] Carrying forward the last FAA_ASDI frame for ${key}`
                        );
                        secState.addFrame(key, secState.lastNonEmptyData);
                    }
                }
                continue;
            }

            const matchedApiKey = timemap?.[key]?.[secState.srcId];
            if (!matchedApiKey) {
                console.warn(
                    `[NMAP] Auto-update: no time match for secondary ${secState.srcId} ` +
                    `at dominant key=${key}`
                );
                continue;
            }

            try {
                // Profile sources are also observation sources, but they use a
                // different endpoint and request signature than ordinary
                // point observations. Test the more specific type first.
                if (secState.isProfileObs) {
                    const { obs_json } = await DataClient.fetchDbProfiles(
                        secState.srcId, matchedApiKey,
                        { queryParams: secState.queryParams }
                    );
                    secState.addFrame(key, { obs_json });
                } else if (secState.isPointObs) {
                    const { obs_json } = await DataClient.fetchDbPoints(
                        secState.srcId, secState.dataKeys, matchedApiKey,
                        { queryParams: secState.queryParams }
                    );
                    secState.addFrame(key, { obs_json });
                } else {
                    const secResult = await fetchAnalysisFieldsAuto(
                        secState.srcId, secState.dataKeys, matchedApiKey,
                        secState.gridInfo, secState.srcEntry,
                        { queryParams: secState.queryParams }
                    );
                    secState.addFrame(key, secResult.fields);
                }
            } catch (err) {
                console.warn(
                    `[NMAP] Auto-update: failed to fetch secondary ${secState.srcId} key=${matchedApiKey}:`,
                    err.message
                );
            }
        }

        // ── 5. Maintain frame count — drop the oldest frame and free its memory ──
        const targetCount = _currentLoadConfig.numFrames;
        while (_frameTimes.length >= targetCount) {
            const oldestKey = _frameKeys.shift();
            _frameTimes.shift();

            // Free the field data held inside every MultiPlotLayer for this key
            for (const state of _sourceUpdateState) {
                state.removeFrame?.(oldestKey);
            }

            // Adjust current frame index to account for the removed oldest frame
            if (_currentFrameIdx > 0) _currentFrameIdx--;
        }

        // ── 6. Insert new frame at the correct chronological position ──
        // Sorted insertion (oldest → newest) guards against out-of-order SSE
        // completions when multiple async fetches race in parallel.
        let insertIdx = _frameTimes.length; // default: append at end
        for (let i = 0; i < _frameTimes.length; i++) {
            if (newDate < _frameTimes[i]) {
                insertIdx = i;
                break;
            }
        }

        const wasAtNewest = (_currentFrameIdx === _frameTimes.length - 1);
        _frameTimes.splice(insertIdx, 0, newDate);
        _frameKeys.splice(insertIdx, 0, key);

        // If we inserted before (or at) the current frame, shift the index
        // so the same frame stays displayed rather than jumping to the wrong one.
        if (insertIdx <= _currentFrameIdx) {
            _currentFrameIdx++;
        }

        // Advance to the new frame only if the user was already on the newest
        // frame AND the new frame landed at the end (is the new newest).
        if (wasAtNewest && insertIdx === _frameTimes.length - 1) {
            _setFrame(_frameTimes.length - 1);
        } else {
            _updateFrameDisplay();
        }

        console.info(
            `[NMAP] Auto-update complete: loop now ${_frameTimes.length} frames, ` +
            `newest=${key}`
        );

    } finally {
        _autoUpdatePending.delete(key);
    }
}


// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Build a mapping: sourceId → { groupName → [product, ...] }
 *
 * Python equivalent:
 *     from collections import defaultdict
 *     result = defaultdict(lambda: defaultdict(list))
 *     for prod_id, prod in PRODUCT_SUITES.items():
 *         for src_id in prod['available_for']:
 *             result[src_id][prod['group']].append(prod)
 */
function _buildGroupedProducts(sources) {
    const result = {};
    for (const src of sources) {
        result[src.source_id] = {};
    }
    for (const [prodId, prod] of Object.entries(PRODUCT_SUITES)) {
        if (!Array.isArray(prod.available_for)) continue;
        for (const srcId of prod.available_for) {
            if (!result[srcId]) continue;
            const group = prod.group || 'misc';
            if (!result[srcId][group]) result[srcId][group] = [];
            result[srcId][group].push({ id: prodId, label: prod.label, group, ...prod });
        }
    }
    return result;
}

/**
 * Pick a default product for a source.
 *
 * Preference: basic group → raster group → any group.
 * Returns the product ID string, or null if nothing is available.
 *
 * TODO: Replace this with a product picker UI in the LayerManager dialog
 * so the user can choose which product to display for each source.
 */
function _pickDefaultProduct(sourceId) {
    const grouped = getState().grouped_products;
    if (!grouped?.[sourceId]) return null;
    const groups = grouped[sourceId];

    if (groups.basic?.length)  return groups.basic[0].id;
    if (groups.raster?.length) return groups.raster[0].id;

    for (const prods of Object.values(groups)) {
        if (prods.length) return prods[0].id;
    }
    return null;
}

function _getSourceQueryParams(src, productSuite) {
    const productDefaults =
        productSuite?.default_query_params &&
        typeof productSuite.default_query_params === 'object' &&
        !Array.isArray(productSuite.default_query_params)
            ? productSuite.default_query_params
            : null;

    const sourceParams =
        src?.queryParams &&
        typeof src.queryParams === 'object' &&
        !Array.isArray(src.queryParams)
            ? src.queryParams
            : null;

    const merged = {
        ...(productDefaults || {}),
        ...(sourceParams || {}),
    };

    return Object.keys(merged).length ? merged : undefined;
}

/**
 * Convert a Date to the key format: "YYYYMMDD_HHMM"
 *
 * This matches the backend's _parse_key() which handles both
 * "YYYYMMDD_HHMM" and "YYYYMMDDHH" formats.
 */
function _dateToKey(dt) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
        `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}_` +
        `${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}`
    );
}

/**
 * Convert a Date to cycle string format: "YYYYMMDDHH"
 */
function _dateToCycleStr(dt) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
        `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
        `${p(dt.getUTCHours())}`
    );
}


// ═════════════════════════════════════════════════════════════════════════════
// DEBUGGING — expose frame state on window for console access
// ═════════════════════════════════════════════════════════════════════════════

window.NmapFrameState = {
    getTimes:        () => _frameTimes.slice(),
    getCurrentIndex: () => _currentFrameIdx,
    getCurrentTime:  () => {
        return (_currentFrameIdx >= 0 && _currentFrameIdx < _frameTimes.length)
            ? new Date(_frameTimes[_currentFrameIdx].getTime())
            : null;
    },
    setCurrentIndex: (idx) => _setFrame(+idx || 0),
};
