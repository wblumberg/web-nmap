/**
 * main.js — Application entry point for web-nmap
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * This file is deliberately thin.  All initialization, wiring, and runtime
 * logic lives in controllers/appController.js.
 *
 * Why separate?
 *   - main.js is the file referenced by index.html's <script type="module">
 *   - appController.js is the orchestrator that connects:
 *       catalogClient  → discovers available data sources
 *       dataClient     → fetches actual field values for visualization
 *       productIndex   → product visualization configs (like GEMPAK restore files)
 *       gridFactory    → converts API grid info → autumnplot-gl grids
 *       layerBuilder   → creates MultiPlotLayers for flicker-free looping
 *       TimeMatcher    → matches times across different data sources
 *       LayerManager   → UI dialog for source/frame selection
 *       ProductGen     → UI panel for drawing products on the map
 *
 * The full flow (triggered by appController.init()):
 *   1. Fetch catalog → group products by source
 *   2. Create MapLibre map → wire toolbar + keyboard
 *   3. User clicks "Load Data" → LayerManager opens
 *   4. User applies → for each source:
 *        fetch times → time-match → fetch data → buildMultiLayers → add to map
 *   5. Frame controls step through MultiPlotLayers (no flicker!)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TODOs (preserved from original prototype):
 *   - ERROR button: show JS console errors in a user-friendly panel
 *   - Restore files: save/load map configurations (like GEMPAK mod_res.tbl)
 *   - Colormap selection: let users pick colormaps for satellite/radar
 *   - Observation binning: aggregate upper air / surface obs
 *   - Settings menu: animation speed, coordinate format, etc.
 *   - Auto Dvorak Technique for cyclone intensity estimates
 *   - Cloud top height algorithm from NMAP2
 */

import { init } from './controllers/appController.js';

window.addEventListener('load', () => {
    init().catch(err => {
        console.error('%c[NMAP]%c Fatal initialization error:',
            'color:#ff4a4a;font-weight:bold', 'color:inherit', err);
    });
});

