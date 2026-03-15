/* 
TODO: Make an "ERROR" button that will allow the user to view messages from the Javascript console referring to errors in plotting data, etc.  These messages should also be informative.

TODO: Figure out how the "restore" file capability will work for the generation of various maps from gridded data.  This will allow the user to save a configuration of the map (e.g., layers, colorbars, etc.) and restore it later.

Questions:
  - How should I go about organizing the various restore files?  I do like the way SPC has been doing it with categories (basic, moisture, instability, lift, shear, precip, winter, fire, composite, overlays, etc.)
  - One file, one restore file.

TODO: Figure out how to create and organize "restore" files for different ways of visualizing observed data (upper air and surface).  These files should provide different ways to visualize the data by changing up how different station plots look?  What about the local storm reports, etc.?

TODO: Figure out how to specify or list the different colormaps that can be used to plot the satellite and radar data.

TODO: Create the method of binning upper air and surface observations.

TODO: Test the time matching of the various datasets to make sure that the data is being plotted correctly and that the time matching is working as expected.  This will require some test cases with known data and known times.

TODO: Figure out what parts of this system are offloaded to the server and what parts are the client's responsiblity.

TODO: Include a settings menu that allows the user to change the settings of NMAP.
TODO: Include a slider that will change the animation speed.

TODO: Implement the Automated Devorak Technique for Cyclone Intensity Estimates.
TODO: Implement the cloud top height algorithm from NMAP2.


*/
// Make a synthetic 500mb height, wind, and wind speed field for testing purposes.  The height field is a simple cosine wave with a gradient, the wind field is a simple cosine wave with a gradient, and the wind speed field is the magnitude of the wind field.  The color map is defined for the wind speed range.


import * as apgl from "autumnplot-gl";
import { ProductGen } from "./productgen.js";
import { LayerManager } from "./layermanager.js";
import * as CatalogClient from "./catalog/CatalogClient.js";
import { PRODUCT_SUITES } from "./products/productIndex.js";

// Example: prove it runs
console.log("APGL loaded:", apgl);

// ---------------------------------------------------------------------------------------------
// On Load of the page, load the catalog, create the map, and populate the view selection menu.
// This is the initialization section for the page or the main() in a way.
// ---------------------------------------------------------------------------------------------
window.addEventListener('load', async () => {
    // 1. Fetch sources from API
    let sources = [];
    try {
        sources = await CatalogClient.listSources();
    } catch (err) {
        console.error("Failed to fetch sources from API:", err);
    }

    // 2. Build a mapping: source_id -> [products]
    // PRODUCT_SUITES: {product_id: { available_for: [source_id, ...], group, ... }}
    const sourceToProducts = {};
    for (const src of sources) {
        sourceToProducts[src.source_id] = [];
    }
    for (const [prodId, prod] of Object.entries(PRODUCT_SUITES)) {
        if (Array.isArray(prod.available_for)) {
            for (const srcId of prod.available_for) {
                if (sourceToProducts[srcId]) {
                    sourceToProducts[srcId].push({
                        id: prodId,
                        label: prod.label,
                        group: prod.group,
                        ...prod
                    });
                }
            }
        }
    }

    // 3. Group products by type for each source
    // Example: { source_id: { group: [products...] } }
    const groupedProductsBySource = {};
    for (const [srcId, products] of Object.entries(sourceToProducts)) {
        const byGroup = {};
        for (const prod of products) {
            if (!byGroup[prod.group]) byGroup[prod.group] = [];
            byGroup[prod.group].push(prod);
        }
        groupedProductsBySource[srcId] = byGroup;
    }

    // 4. (For UI) You can now use groupedProductsBySource to populate a loader dialog or menu
    // Example usage: groupedProductsBySource['RAP']['basic'] gives all 'basic' products for RAP
    window.NMAP_GROUPED_PRODUCTS = groupedProductsBySource;
    window.NMAP_SOURCES = sources;

    // Log the discovered sources and grouped products for developer inspection
    console.info('%c[NMAP]%c Data Sources loaded from API:', 'color:#55d46a;font-weight:bold', 'color:inherit', sources);
    console.info('%c[NMAP]%c Grouped products by source:', 'color:#55d46a;font-weight:bold', 'color:inherit', groupedProductsBySource);
    
    // Load the datasets available through the API (analogous to GEMPAK's datatype.tbl),
    // 1.) Access the data catalog using the API endpoint /api/sources
    // 2.) Load in all of the products and their metadata from the products/ folder.  This will be used to show
    // the user what products are available for what data sources.

    // then build the views map from catalog entries that have a registered makeLayers function.

    // Populate the view selection menu with the available views.  The menu will be updated with new layers and colorbars when the 
    const menu = document.querySelector('#view-select');  
    /*
    // user selects a different view from the menu.
    menu.innerHTML = Object.entries(views).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
    */
   // Define views at the top so it's available everywhere
    const views = {
        default: {
            name: "Default",
            maxZoom: 7,
            makeLayers: async () => ({ layers: [], colorbar: [], sampler: undefined })
        }
    };

    // Initialize menu and ensure it has a default option before any code uses it
    if (menu && !menu.querySelector('option')) {
        menu.innerHTML = '<option value="default">Default</option>';
    }
    if (menu) menu.value = "default";
    if (!menu.querySelector('option')) {
        menu.innerHTML = '<option value="default">Default</option>';
    }
    menu.value = "default";
    // http://localhost:5173/static/tiles/5/7/11.pbf

    //Set up the MapLibre GL map with a custom style and initial view settings.  The map will be updated with new layers and colorbars when the user selects a different view from the menu.
    const map = new maplibregl.Map({
        container: 'map',
        style: '/styles/style.json',
        center: [-97.5, 38.5],
        zoom: 4,
        maxZoom: 7,
        projection: 'globe',
    });

    // Keep track of the current layers and mousemove handler so they can be removed when a new view is selected
    let current_layers = [];
    let current_mousemove_handler = null;

    // ------------------------------------------------------------------
    // Frame-time controller (dominant-source timeline playback scaffold)
    // ------------------------------------------------------------------
    const frameTimeValueEl = document.querySelector('#frame-time-value');
    const FRAME_PLAY_INTERVAL_MS = 900;
    let frameTimes = [];            // ascending (oldest -> newest)
    let currentFrameIdx = -1;       // index into frameTimes
    let playbackTimer = null;
    let playbackMode = 'pause';     // 'pause' | 'loop-fwd' | 'loop-back' | 'rock'
    let rockDirection = 1;          // +1 forward, -1 backward

    // Format the Frame DateTime
    function _fmtFrameUTC(dt) {
        if (!(dt instanceof Date)) return '--';
        const pad = n => String(n).padStart(2, '0');
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
        return `${pad(dt.getUTCDate())} ${mon} ${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())} UTC`;
    }

    // update the frame-time display in the UI based on the current frame index and the list of frame times
    function _updateFrameDisplay() {
        const cur = (currentFrameIdx >= 0 && currentFrameIdx < frameTimes.length) ? frameTimes[currentFrameIdx] : null;
        const idxTxt = (cur && frameTimes.length) ? ` [${currentFrameIdx + 1}/${frameTimes.length}]` : '';
        frameTimeValueEl.textContent = cur ? `${_fmtFrameUTC(cur)}${idxTxt}` : '--';
    }

    // set the current frame index and update the display.  If the index is out of bounds, it will be clamped to the valid range.
    function _setCurrentFrameIdx(idx) {
        if (!frameTimes.length) {
            currentFrameIdx = -1;
            _updateFrameDisplay();
            return;
        }
        currentFrameIdx = Math.max(0, Math.min(frameTimes.length - 1, idx));
        _updateFrameDisplay();
        // Debug: log timeline and current index for playback verification
        try { console.debug('%c[FRAMES]%c currentIdx=%d / total=%d currentTime=%s', 'color:#4a9eff;font-weight:bold', 'color:inherit', currentFrameIdx, frameTimes.length, frameTimes[currentFrameIdx] ? frameTimes[currentFrameIdx].toISOString() : 'null'); } catch (e) {}
        // Refresh dynamic layers when the current frame changes so subscripts
        // that produce per-frame PlotLayers are applied immediately.
        try { updateMap(); } catch (e) { /* ignore timing races during startup */ }
    }

    // stop any ongoing playback and clear the playback timer
    function _stopPlayback() {
        if (playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = null;
        }
        playbackMode = 'pause';
    }
    
    // step the current frame index by delta, wrapping around if necessary.  If delta is negative and the current frame index is 0, it will wrap to the last frame.
    function _step(delta) {
        if (delta < 0 && currentFrameIdx === 0) {
            _setCurrentFrameIdx(frameTimes.length - 1);
            return;
        }
        if (!frameTimes.length) return;
        _setCurrentFrameIdx(currentFrameIdx + delta >= frameTimes.length ? 0 : currentFrameIdx + delta);
    }

    // step the current frame index forward by 1, wrapping around to 0 if necessary
    function _tickLoopForward() {
        if (!frameTimes.length) return;
        const next = currentFrameIdx + 1;
        _setCurrentFrameIdx(next >= frameTimes.length ? 0 : next);
    }

    // step the current frame index backward by 1, wrapping around to the last frame if necessary
    function _tickLoopBackward() {
        if (!frameTimes.length) return;
        const next = currentFrameIdx - 1;
        _setCurrentFrameIdx(next < 0 ? frameTimes.length - 1 : next);
    }

    // step the current frame index forward or backward by 1, reversing direction when the end or beginning of the frame times is reached
    function _tickRock() {
        if (!frameTimes.length) return;
        if (frameTimes.length === 1) {
            _setCurrentFrameIdx(0);
            return;
        }
        let next = currentFrameIdx + rockDirection;
        if (next >= frameTimes.length) {
            rockDirection = -1;
            next = frameTimes.length - 2;
        } else if (next < 0) {
            rockDirection = 1;
            next = 1;
        }
        _setCurrentFrameIdx(next);
    }

    // start playback in the specified mode ('loop-fwd', 'loop-back', or 'rock').  If the same mode is already active, it will stop playback.  If a different mode is active, it will switch to the new mode.
    function _startPlayback(mode) {
        if (!frameTimes.length) return;
        if (playbackMode === mode && playbackTimer) {
            _stopPlayback();
            return;
        }
        _stopPlayback();
        playbackMode = mode;
        if (mode === 'rock') rockDirection = 1;
        playbackTimer = setInterval(() => {
            if (playbackMode === 'loop-fwd') _tickLoopForward();
            else if (playbackMode === 'loop-back') _tickLoopBackward();
            else if (playbackMode === 'rock') _tickRock();
        }, FRAME_PLAY_INTERVAL_MS);
    }

    // set the list of frame times from the dominant source, normalizing them to Date objects and sorting them in ascending order.  The current frame index will be set to the last frame (newest) by default.
    function _setFrameTimesFromDominant(framesNewestToOldest) {
        _stopPlayback();
        const normalized = (Array.isArray(framesNewestToOldest) ? framesNewestToOldest : [])
            .map(t => t instanceof Date ? new Date(t.getTime()) : new Date(t))
            .filter(d => Number.isFinite(d.getTime()));
        normalized.sort((a, b) => a.getTime() - b.getTime()); // oldest -> newest
        frameTimes = normalized;
        // Default to latest frame when a new timeline is applied
        _setCurrentFrameIdx(frameTimes.length ? frameTimes.length - 1 : -1);
    }

    // Expose central frame-time state for future loader integration.
    window.NmapFrameState = {
        getTimes: () => frameTimes.slice(),
        getCurrentIndex: () => currentFrameIdx,
        getCurrentTime: () => (currentFrameIdx >= 0 && currentFrameIdx < frameTimes.length) ? new Date(frameTimes[currentFrameIdx].getTime()) : null,
        setCurrentIndex: (idx) => _setCurrentFrameIdx(+idx || 0),
    };

    // ------------------------------------------------------------------
    // Map update function
    // ------------------------------------------------------------------
    // Right now, this function gets called every time we step forward a frame or back a frame
    // We need this function to use Tim's lovely MultiPlotLayer functionality to create a smooth
    // transition between frames.  Upon the load of the data, we need to generate the MultiPlotLayers
    // and add/delete the field whenever new data comes in that needs to be added to the loop.
    // TODO: Update the updateMap function to use the MultiPlotLayer
    async function updateMap() {
        const view = views[menu.value];
        console.debug('%c[NMAP]%c updateMap() → view="%s"', 'color:#55d46a;font-weight:bold', 'color:inherit', menu.value);
        map.setMaxZoom(view.maxZoom);

        // If a subscript is registered for this view and we have timeline
        // information, prefer the subscript so it can produce per-frame layers.
        let layers, colorbar, sampler;
        if (window.SubscriptRegistry && SubscriptRegistry.has(menu.value) && frameTimes.length) {
            const currentTime = window.NmapFrameState.getCurrentTime();
            const obj = await SubscriptRegistry.getLayersForFrame(menu.value, currentTime, {
                declarativeRasterRenderer: null
            });
            if (obj && obj.layers) {
                layers = obj.layers;
                colorbar = obj.colorbar;
                sampler = obj.sampler;
            }
        }
        if (!layers) {
            const res = await view.makeLayers();
            layers = res.layers; colorbar = res.colorbar; sampler = res.sampler;
        }

        // Add new layers before removing old ones where possible to avoid
        // a brief blank state (flicker) during the swap. If a new layer id
        // already exists on the map, remove that existing layer first to
        // prevent addLayer collisions.
        const newIds = (layers || []).map(l => l && l.id).filter(Boolean);
        for (const id of newIds) {
            if (map.getLayer(id)) {
                try { map.removeLayer(id); } catch (e) { /* best-effort */ }
            }
        }
        // If AutumnPlot-GL exposes MultiLayerPlot, prefer a single multi-layer
        // wrapper per view so AutumnPlot can composite internally and avoid
        // visible flicker. Otherwise fall back to adding each PlotLayer.
        let usedMulti = false;
        try {
            if (window.apgl && typeof apgl.MultiLayerPlot === 'function' && Array.isArray(layers) && layers.length) {
                const mlKey = `${menu.value}-ml`;
                window._apglMultiLayerMap = window._apglMultiLayerMap || {};
                let ml = window._apglMultiLayerMap[mlKey];
                if (ml) {
                    // Update existing multilayer instance if supported.
                    if (typeof ml.setLayers === 'function') {
                        ml.setLayers(layers);
                    } else {
                        // Not updatable — remove and recreate.
                        try { if (map.getLayer(ml.id)) map.removeLayer(ml.id); } catch (e) {}
                        ml = new apgl.MultiLayerPlot(mlKey, layers);
                        map.addLayer(ml);
                        window._apglMultiLayerMap[mlKey] = ml;
                    }
                } else {
                    // Create and register new MultiLayerPlot
                    ml = new apgl.MultiLayerPlot(mlKey, layers);
                    map.addLayer(ml);
                    window._apglMultiLayerMap[mlKey] = ml;
                }
                // Mark we used multilayer rendering and ensure current_layers
                // contains the single multilayer entry so later cleanup knows
                // what to remove.
                current_layers = [{ id: ml.id }];
                usedMulti = true;
            }
        } catch (err) {
            console.warn('updateMap: MultiLayerPlot integration failed', err && err.message);
            usedMulti = false;
        }

        if (!usedMulti) {
            for (const lyr of (layers || [])) {
                try { map.addLayer(lyr); } catch (err) { console.warn('updateMap: failed to add layer', lyr && lyr.id, err && err.message); }
            }
        }
        // Remove old layers that weren't re-used by the new set.
        const keep = new Set(newIds);
        for (const old of current_layers || []) {
            if (!old || !old.id) continue;
            if (keep.has(old.id)) continue;
            try { if (map.getLayer(old.id)) map.removeLayer(old.id); } catch (e) { /* ignore */ }
        }

        // Setup colorbar panel in the bottom part of the page.  If there are multiple colorbars, they will be stacked according to AutumnPlot-GL
        const colorbar_panel = document.querySelector('#colorbar-panel');
        const colorbar_container = document.querySelector('#colorbar');
        colorbar_container.innerHTML = '';

        // If there are colorbars, add them to the colorbar container and show the colorbar panel.  If there are no colorbars, hide the colorbar panel.
        if (colorbar && colorbar.length > 0) {
            colorbar.forEach(cb => colorbar_container.appendChild(cb));
            colorbar_panel.classList.remove('hidden');
        } else {
            colorbar_panel.classList.add('hidden');
        }

        current_layers = layers;

        // Readout from mousemove events to display coordinates, geographical locations (e.g., lat/lon, counties, asos, etc.) similar to NMAP2's lower right hand corner thingy and sampled data values
        const readout = document.querySelector('#readout');

        // Remove the previous mousemove handler if it exists, and set up a new one that samples data values at the mouse location and displays them in the readout.  If no sampler is provided, just display the lat/lon coordinates.
        if (current_mousemove_handler) {
            map.off('mousemove', current_mousemove_handler);
            current_mousemove_handler = null;
        }
        
        // TODO: Include other options for the readout, such as displaying the coordinates in different formats (e.g., DMS, UTM, etc.) and displaying additional information (e.g., elevation, county, country, state, time, etc.) and displaying the readout in a tooltip or popup instead of the readout.
        if (sampler !== undefined) {
            // If a sampler is provided, use it to sample data values at the mouse location and display them in the readout

            // TODO: provide options to display the sampled data values in different formats (e.g., raw, formatted, etc.) and to display additional information (e.g., units, descriptions, etc.) and to display the sampled data values in a tooltip or popup instead of the readout

            current_mousemove_handler = (ev) => {
                const coord = ev.lngLat.wrap();
                readout.innerHTML = `${coord.lat.toFixed(2)}°N ${coord.lng.toFixed(2)}°E`;
                const sample = sampler(coord.lng, coord.lat);
                if (sample) {
                    const str = Object.entries(sample)
                        .map(([sn, s]) => Array.isArray(s) ? `${sn}: ${s[0].toFixed(0)}/${s[1].toFixed(0)}` : `${sn}: ${s.toFixed(1)}`)
                        .join(', ');
                    readout.innerHTML += ` | ${str}`;
                }
            };
        } else {
            // If no sampler is provided, just display the lat/lon coordinates

            current_mousemove_handler = (ev) => {
                const coord = ev.lngLat.wrap();
                readout.innerHTML = `${coord.lat.toFixed(2)}°N ${coord.lng.toFixed(2)}°E`;
            };
        }
        map.on('mousemove', current_mousemove_handler);
    }

    // Initial map update when the page loads, and also when the user selects a different view from the menu
    map.on('load', () => {
        console.info('%c[NMAP]%c Map loaded — MapLibre ready', 'color:#55d46a;font-weight:bold', 'color:inherit');
        updateMap();
        ProductGen.init(map);
    });
    menu.addEventListener('change', updateMap);

    // --- Toolbar buttons ---

    // Playback controls (timeline scaffold only; data loading by frame is wired later)
    document.querySelector('#btn-goto-first').addEventListener('click', () => {
        _stopPlayback();
        _setCurrentFrameIdx(0);
    });
    document.querySelector('#btn-goto-last').addEventListener('click', () => {
        _stopPlayback();
        _setCurrentFrameIdx(frameTimes.length - 1);
    });
    document.querySelector('#btn-step-back').addEventListener('click', () => {
        _stopPlayback();
        _step(-1);
    });
    document.querySelector('#btn-step-fwd').addEventListener('click', () => {
        _stopPlayback();
        _step(+1);
    });
    document.querySelector('#btn-loop-back').addEventListener('click', () => _startPlayback('loop-back'));
    document.querySelector('#btn-loop-fwd').addEventListener('click', () => _startPlayback('loop-fwd'));
    document.querySelector('#btn-rock').addEventListener('click', () => _startPlayback('rock'));

    // Keyboard controls for timeline playback (spacebar toggles pause/play, left/right arrows step backward/forward, up/down arrows toggle loop forward/back)
    document.addEventListener('keydown', (ev) => {
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
        if (ev.code === 'Space') {
            ev.preventDefault();
            if (playbackMode === 'pause') _startPlayback('loop-fwd');
            else _stopPlayback();
        } else if (ev.code === 'Comma') {
            ev.preventDefault();
            _stopPlayback();
            
            _step(-1);
        } else if (ev.code === 'Period') {
            ev.preventDefault();
            _stopPlayback();
            _step(+1);
        } else if (ev.code === 'KeyL') {
            ev.preventDefault();    
            _startPlayback('loop-fwd');
        } else if (ev.code === 'KeyK') {
            ev.preventDefault();
            _startPlayback('loop-back');
        }
    });

    _updateFrameDisplay();

    /* -------------------------------------------------------------------------
    /  This section of the code connects the toolbar buttons for different functionalities
    /  to their respective listeners and configuration.
    / -------------------------------------------------------------------------*/

    // Initialize the Layer Manager (which internally initialises DataSelector).
    // "Load Data" opens the Layer Manager so the user can add / remove sources,
    // set the dominant source, choose frame count / skip, then hit Apply.
    LayerManager.init();
    document.querySelector('#btn-load').addEventListener('click', () => {
        LayerManager.open(({ sources, dominantId, numFrames, frameSkip, frames }) => {
            // For now, render the dominant source (or first source) using the
            // existing single-view pipeline.  Multi-layer simultaneous rendering
            // can be wired here once the plotter supports stacked PlotLayers.
            const activeId = dominantId || (sources.length ? sources[0].id : null);
            if (!activeId) return;
            // Log the received config
            console.groupCollapsed('%c[NMAP]%c LayerManager applied — loading %d frame(s) of "%s"',
                'color:#55d46a;font-weight:bold', 'color:inherit', frames.length, activeId);
            console.info('  Sources (%d):', sources.length,
                sources.map(s => `${s.id}${s.cycleTime ? ' @'+s.cycleTime.toISOString().slice(0,13)+'Z' : ''}`));
            console.info('  Dominant:', activeId);
            console.info('  numFrames:', numFrames, '  frameSkip:', frameSkip);
            if (frames.length) {
                console.info('  Time range:', frames[frames.length-1].toISOString(), '→', frames[0].toISOString(),
                    `(${((frames[0]-frames[frames.length-1])/3600000).toFixed(1)}h span)`);
            }
            console.groupEnd();

            // Centralize the active timeline to dominant-source frame times.
            _setFrameTimesFromDominant(frames);

            const opt = menu.querySelector(`option[value="${activeId}"]`);
            if (opt) {
                menu.value = activeId;
                updateMap();
            } else {
                console.warn(`LayerManager: id "${activeId}" not in view-select menu`);
            }
        });
    });

    // Freeze Map Location: lock/unlock pan and zoom interactions
    // This is so the user can do other things without having to worry
    // about accidentally moving the map around.
    let locationFrozen = false;
    const freezeBtn = document.querySelector('#btn-freeze');
    freezeBtn.addEventListener('click', () => {
        locationFrozen = !locationFrozen;
        freezeBtn.classList.toggle('active', locationFrozen);
        freezeBtn.title = locationFrozen ? 'Unfreeze Map Location' : 'Freeze Map Location';
        if (locationFrozen) {
            map.dragPan.disable();
            map.scrollZoom.disable();
            map.boxZoom.disable();
            map.doubleClickZoom.disable();
            map.touchZoomRotate.disable();
            map.keyboard.disable();
        } else {
            map.dragPan.enable();
            map.scrollZoom.enable();
            map.boxZoom.enable();
            map.doubleClickZoom.enable();
            map.touchZoomRotate.enable();
            map.keyboard.enable();
        }
    });

    // Auto-Update: reload data on a fixed interval (60 seconds)
    const AUTO_UPDATE_INTERVAL_MS = 60000;
    let autoUpdateTimer = null;
    const autoUpdateBtn = document.querySelector('#btn-autoupdate');
    autoUpdateBtn.addEventListener('click', () => {
        if (autoUpdateTimer) {
            clearInterval(autoUpdateTimer);
            autoUpdateTimer = null;
            autoUpdateBtn.classList.remove('active');
            autoUpdateBtn.title = 'Auto-Update (off)';
        } else {
            autoUpdateTimer = setInterval(updateMap, AUTO_UPDATE_INTERVAL_MS);
            autoUpdateBtn.classList.add('active');
            autoUpdateBtn.title = 'Auto-Update (on)';
        }
    });

    // Connect the Product Generation Button to the panel
    const productBtn = document.querySelector('#btn-product');
    productBtn.addEventListener('click', () => {
        const nowOpen = ProductGen.toggle();
        productBtn.classList.toggle('active', nowOpen);
    });

    // Template: placeholder for future functionality
    document.querySelector('#btn-template').addEventListener('click', () => {
        // TODO: implement
    });
});

