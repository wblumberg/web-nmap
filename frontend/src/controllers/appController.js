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
import { PRODUCT_SUITES, PRODUCT_GROUPS } from '../domain/dataProducts/productIndex.js';
import { makeApglGrid }   from '../domain/gridFactory.js';
import { buildMultiLayers } from '../domain/layerBuilder.js';
import { getState, setState } from '../app/store.js';
import { LayerManager }    from '../views/panels/productManager.js';
import { ProductGen }      from '../views/panels/productGenView.js';

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
let _activeSampler     = null;  // function(lon, lat) → { varName: value }
let _mousemoveHandler  = null;  // current map mousemove handler

// ── Frame timeline ──
let _frameTimes      = [];      // Date[], sorted oldest → newest
let _frameKeys       = [];      // string[], parallel to _frameTimes
let _currentFrameIdx = -1;      // index into _frameTimes / _frameKeys

// ── Playback state ──
let _playbackTimer   = null;
let _playbackMode    = 'pause'; // 'pause' | 'loop-fwd' | 'loop-back' | 'rock'
let _rockDirection   = 1;       // +1 = forward, -1 = backward
const PLAY_INTERVAL_MS = 900;   // ms between frames during playback

// ── Cached DOM elements ──
let _frameTimeEl       = null;
let _colorbarPanel     = null;
let _colorbarContainer = null;
let _readoutEl         = null;


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
    // loaded from a known URL.  We ship it in public/ so Vite serves it at '/'.
    apgl.initAutumnPlot({ wasm_base_url: '/' });

    // Cache DOM elements so we don't re-query the DOM on every frame step
    _frameTimeEl       = document.querySelector('#frame-time-value');
    _colorbarPanel     = document.querySelector('#colorbar-panel');
    _colorbarContainer = document.querySelector('#colorbar');
    _readoutEl         = document.querySelector('#readout');

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
        projection: 'globe',
    });
    setState({ map: _map });

    // ── Step 5: Wire everything after the map's GL context is ready ──
    //
    // MapLibre fires 'load' once tiles are loaded and the GL context is
    // initialized. We must wait for this before adding any layers.
    _map.on('load', () => {
        console.info('%c[NMAP]%c Map loaded — ready for layers',
            'color:#55d46a;font-weight:bold', 'color:inherit');
        ProductGen.init(_map);
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

    // ── Auto-Update (reload data periodically) ──
    let autoTimer = null;
    wire('#btn-autoupdate', () => {
        const btn = document.querySelector('#btn-autoupdate');
        if (autoTimer) {
            clearInterval(autoTimer);
            autoTimer = null;
            btn.classList.remove('active');
            btn.title = 'Auto-Update (off)';
        } else {
            autoTimer = setInterval(() => _refreshCurrentView(), 60_000);
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

    // ── Template button (placeholder for future functionality) ──
    wire('#btn-template', () => { /* TODO: implement restore/template system */ });
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
    console.group(
        '%c[NMAP]%c Loading data — %d source(s), %d frame(s), dominant=%s',
        'color:#55d46a;font-weight:bold', 'color:inherit',
        sources.length, frames.length, dominantId
    );

    // ── 1. Clear existing layers from the map ──
    _clearActiveLayers();

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
        // Each source goes through the full pipeline:
        //   product → grid → time-match → fetch data → build layers → add to map
        for (const src of sources) {
            try {
                await _loadAndBuildSource(src, sortedFrames);
            } catch (err) {
                console.error(`[NMAP] Failed to load source "${src.id}":`, err);
            }
        }

        // ── 5. Display colorbars ──
        _renderColorbars();

        // ── 6. Set up mouse readout (lat/lon + sampled values) ──
        _setupReadout();

        // ── 7. Jump to the newest frame ──
        _setFrame(_frameTimes.length - 1);

        console.info('[NMAP] Data load complete — %d MultiPlotLayer(s) active',
            _activeMultiLayers.length);

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
 * Load data for one source across all frame times, then build MultiPlotLayers.
 *
 * This is the core of the data pipeline.  In Python pseudocode:
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
async function _loadAndBuildSource(src, frameTimes) {

    // ── Step A: Pick a product for this source ──
    //
    // Each data source (GFS, RAP, MESOANALYSIS_GRID) can render many products
    // (2m Temperature, 500mb Heights, CAPE, etc.).  The product determines:
    //   - What variables to fetch from the API (data_keys)
    //   - How to visualize them (make_layers function)
    //
    // For now we auto-pick the first available product.
    // TODO: Add a product picker dropdown per source in the LayerManager UI.
    const productId = _pickDefaultProduct(src.id);
    if (!productId) {
        console.warn(`[NMAP] No products available for source "${src.id}" — skipping`);
        return;
    }

    const productSuite = PRODUCT_SUITES[productId];
    const dataKeys = productSuite.data_keys;  // e.g. ['t2m'] or ['hght_500mb', 'ugrd_500mb', 'vgrd_500mb']

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

    // ── Step D: Match frame times to available API keys ──
    //
    // The LayerManager gives us Date objects for each frame.  We need the
    // exact string keys that the API expects.  We fetch available times
    // from the catalog and use TimeMatcher to find the best match.
    let frameToKey;   // Map<number(ms), string(apiKey)>
    if (isForecast && src.cycleTime) {
        frameToKey = await _matchForecastFrames(src, frameTimes);
    } else {
        frameToKey = await _matchAnalysisFrames(src, frameTimes);
    }

    console.warn('[NMAP] frameToKey size =', frameToKey.size, '| entries:', [...frameToKey.entries()].slice(0, 5).map(([ms, k]) => `${new Date(ms).toISOString()} → ${k}`));

    if (!frameToKey.size) {
        console.warn(`[NMAP] No matching times found for source "${src.id}" — skipping`);
        return;
    }

    // ── Step E: Fetch field data for each matched frame ──
    //
    // This is the "expensive" step — we're downloading the actual values.
    // We batch requests (4 at a time) to avoid overwhelming the server.
    //
    // The result is dataByKey: { frameKey: { varName: Float32Array, ... } }
    // which is exactly what buildMultiLayers/make_layers expects.
    const dataByKey = {};
    const orderedKeys = [];
    const BATCH_SIZE = 4;
    const frameEntries = [...frameToKey.entries()];  // [[ms, apiKey], ...]

    for (let i = 0; i < frameEntries.length; i += BATCH_SIZE) {
        const batch = frameEntries.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async ([frameMs, apiKey]) => {
                // Use the standard frame key (YYYYMMDD_HHMM) for MultiPlotLayer indexing
                const frameKey = _dateToKey(new Date(frameMs));
                try {
                    let result;
                    if (isForecast && src.cycleTime) {
                        // Forecast: calculate fhr from the difference between
                        // frame time and cycle time, then use the forecast endpoint
                        const fhr = Math.round(
                            (frameMs - src.cycleTime.getTime()) / 3_600_000
                        );
                        const cycleStr = _dateToCycleStr(src.cycleTime);
                        result = await DataClient.fetchForecastFields(
                            src.id, dataKeys, cycleStr, fhr
                        );
                    } else {
                        // Analysis/obs: use the matched apiKey directly
                        result = await DataClient.fetchAnalysisFields(
                            src.id, dataKeys, apiKey
                        );
                    }
                    return { frameKey, fields: result.fields };

                } catch (err) {
                    console.warn(
                        `[NMAP] Failed to fetch frame ${frameKey} for "${src.id}":`,
                        err.message
                    );
                    return { frameKey, fields: null };
                }
            })
        );

        // Collect successful results
        for (const { frameKey, fields } of results) {
            if (fields) {
                dataByKey[frameKey] = fields;
                orderedKeys.push(frameKey);
                // ── Debug: inspect returned field data ──
                for (const [varName, arr] of Object.entries(fields)) {
                    const f32 = arr instanceof Float32Array ? arr : null;
                    const len = f32 ? f32.length : (arr?.length ?? 'N/A');
                    const nanCount = f32 ? f32.reduce((c, v) => c + (isNaN(v) ? 1 : 0), 0) : '?';
                    const zeroCount = f32 ? f32.reduce((c, v) => c + (v === 0 ? 1 : 0), 0) : '?';
                    const min = f32 ? f32.reduce((m, v) => (isNaN(v) ? m : Math.min(m, v)), Infinity) : '?';
                    const max = f32 ? f32.reduce((m, v) => (isNaN(v) ? m : Math.max(m, v)), -Infinity) : '?';
                    console.warn(`[NMAP] Field "${varName}" frame=${frameKey}: ` +
                        `type=${arr?.constructor?.name} len=${len} ` +
                        `NaN=${nanCount} zeros=${zeroCount} min=${min} max=${max}`);
                }
            } else {
                console.warn(`[NMAP][DEBUG] Frame ${frameKey} returned null fields`);
            }
        }
    }

    if (!orderedKeys.length) {
        console.warn(`[NMAP] No data loaded for "${src.id}" — skipping layer build`);
        return;
    }

    console.info(
        `[NMAP] Loaded ${orderedKeys.length}/${frameTimes.length} frames for "${src.id}"`
    );

    // ── Step F: Build MultiPlotLayers ──
    //
    // buildMultiLayers() from layerBuilder.js does the magic:
    //   1. Calls productSuite.make_layers(data, grid) for each frame
    //   2. Wraps the resulting PlotLayers in MultiPlotLayers
    //   3. Returns a controller with setKey() for frame stepping
    //
    // The MultiPlotLayer is the key to flicker-free looping:
    //   - All frames are pre-loaded as GPU textures
    //   - setKey() just switches which texture is displayed
    //   - No layer add/remove needed!
    const namespace = src.uid || src.id;
    console.warn(`[NMAP] Building MultiPlotLayers: namespace="${namespace}" keys=[${orderedKeys.join(', ')}]`);
    console.warn(`[NMAP] dataByKey has ${Object.keys(dataByKey).length} entries, grid =`, grid);

    let result;
    try {
        result = buildMultiLayers(
            productSuite,
            dataByKey,
            grid,
            orderedKeys,
            namespace
        );
    } catch (err) {
        console.error(`[NMAP] buildMultiLayers THREW:`, err);
        throw err;
    }

    // ── Step G: Add MultiPlotLayers to the MapLibre map ──
    console.warn(`[NMAP] buildMultiLayers returned: ${result.layers.length} layer(s), ` +
        `${result.colorbars?.length ?? 0} colorbar(s), sampler=${!!result.sampler}`);
    for (const ml of result.layers) {
        console.warn(`[NMAP] Adding MultiPlotLayer to map: id="${ml.id}"`, ml);
        try {
            _map.addLayer(ml, 'coastline');
            console.warn(`[NMAP] Successfully added layer "${ml.id}" to map`);
        } catch (err) {
            console.error(`[NMAP] FAILED to add layer "${ml.id}" to map:`, err);
        }
    }

    // Track everything for cleanup and frame stepping
    _activeMultiLayers.push(...result.layers);
    _layerControllers.push(result.controller);
    if (result.colorbars?.length) _activeColorbars.push(...result.colorbars);
    if (result.sampler) _activeSampler = result.sampler;

    console.info(
        `[NMAP] Built ${result.layers.length} MultiPlotLayer(s) for "${src.id}/${productId}"`
    );
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
async function _matchAnalysisFrames(src, frameTimes) {
    const result = new Map();

    // Fetch available times with full metadata from the API
    const timeObjects = await CatalogClient.listTimesDetailed(src.id, { limit: 500 });
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
async function _matchForecastFrames(src, frameTimes) {
    const result = new Map();
    const cycleStr = _dateToCycleStr(src.cycleTime);

    try {
        // Fetch available forecast hours: { fhrs: [0,1,2,...], keys: [...] }
        const fhrData = await CatalogClient.listFhrs(src.id, cycleStr);

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
    console.warn(`[NMAP] _setFrame(${idx}) → idx=${_currentFrameIdx} key="${key}"`);
    console.warn(`[NMAP]   _layerControllers.length=${_layerControllers.length}`);
    console.warn(`[NMAP]   _activeMultiLayers.length=${_activeMultiLayers.length}`);
    for (const ctrl of _layerControllers) {
        // Only set the key if this controller has data for that frame.
        // (Some sources might be missing certain frames due to time matching.)
        console.warn(`[NMAP]   controller keys: [${ctrl.keys.join(', ')}]`);
        if (ctrl.keys.includes(key)) {
            ctrl.setKey(key);
            console.warn(`[NMAP]   → set key "${key}" on controller`);
        } else {
            console.warn(`[NMAP]   → key "${key}" NOT found in controller keys`);
        }
    }

    _updateFrameDisplay();
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
    _playbackMode = 'pause';
}

/**
 * Start or stop playback in the given mode.
 * Clicking the same mode again stops playback (toggle behavior).
 */
function _togglePlayback(mode) {
    if (!_frameTimes.length) return;

    // Clicking the same mode while playing → stop
    if (_playbackMode === mode && _playbackTimer) {
        _stopPlayback();
        return;
    }

    _stopPlayback();
    _playbackMode = mode;
    if (mode === 'rock') _rockDirection = 1;

    _playbackTimer = setInterval(() => {
        switch (_playbackMode) {
            case 'loop-fwd':
                _stepFrame(+1);
                break;
            case 'loop-back':
                _stepFrame(-1);
                break;
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
    }, PLAY_INTERVAL_MS);
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
    _frameTimes        = [];
    _frameKeys         = [];
    _currentFrameIdx   = -1;
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

/** Set up mouse-move readout showing lat/lon + sampled data values. */
function _setupReadout() {
    if (_mousemoveHandler) {
        _map.off('mousemove', _mousemoveHandler);
        _mousemoveHandler = null;
    }

    _mousemoveHandler = (ev) => {
        const coord = ev.lngLat.wrap();
        let text = `${coord.lat.toFixed(2)}°N ${coord.lng.toFixed(2)}°E`;

        if (_activeSampler) {
            try {
                const sample = _activeSampler(coord.lng, coord.lat);
                if (sample) {
                    const parts = Object.entries(sample).map(([name, val]) =>
                        Array.isArray(val)
                            ? `${name}: ${val[0].toFixed(0)}/${val[1].toFixed(0)}`
                            : `${name}: ${val.toFixed(1)}`
                    );
                    text += ` | ${parts.join(', ')}`;
                }
            } catch (e) { /* sampling can fail at map edges */ }
        }

        if (_readoutEl) _readoutEl.textContent = text;
    };

    _map.on('mousemove', _mousemoveHandler);
}

/**
 * Placeholder for auto-update refresh.
 * TODO: Re-fetch data for the current configuration and rebuild layers.
 */
function _refreshCurrentView() {
    console.info('[NMAP] Auto-update tick (full refresh not yet implemented)');
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
