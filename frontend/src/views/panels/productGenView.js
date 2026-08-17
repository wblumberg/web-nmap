import {
    FORECAST_SUITE_DEFINITIONS,
    getForecastSuite,
    getForecastProduct,
    getForecastLevel,
} from '../../config/forecastSuites.js';
import {validateForecastProducts} from '../../domain/forecastValidation.js';
import {GEMPAK_SYMBOLS} from '../../config/gempakSymbols.generated.js';

/* productgen.js — Product Generation module for web-nmap
 *
 * Floating panel for drawing meteorological map products.
 *
 * Product kinds:
 *   'contour'  — closed polygon (threat areas, probability outlines, ROI)
 *   'front'    — open polyline with meteorological front pip symbology
 *   'text'     — point annotation (includes H / L pressure symbols)
 * 
 * // TODO: Add support for 'symbol' products (point symbols, wind barbs, etc.)
 * // TODO: Add support for arrows, etc.
 * // FIXME: Fix the front pip placement algorithm to handle the size of the pips better (currently they do not scale with the map zoom level, and the spacing is fixed in km, which can lead to overlapping pips at high zoom levels).
 * // TODO: Add support for limiting contour levels to a set of predefined values (e.g. 0.1, 0.2, 0.3, …) for probability contours.  For example, if the user wants to replicate SPC-type probabilities, they should be able to do so with the correct colors.  Perhaps we could do product templates.
 *
 * Public API:
 *   ProductGen.init(map)  — call once inside the MapLibre 'load' callback
 *   ProductGen.open()     — show the panel
 *   ProductGen.close()    — hide the panel and cancel any active drawing
 *   ProductGen.toggle()   — show/hide; returns true if now open
 */

// this is exporting a singleton object with methods and state for the ProductGen panel
export const ProductGen = (() => {
    'use strict';

    // ── Contour (polygon) source / layer IDs ──────────────────────────
    const SRC_CONTOUR    = 'pg-contour';
    const LYR_CTR_FILL   = 'pg-contour-fill';
    const LYR_CTR_PATTERN = 'pg-contour-pattern';
    const LYR_CTR_LINE   = 'pg-contour-line';
    const LYR_CTR_LABEL  = 'pg-contour-label';

    // ── County-alert selection layers (existing basemap vector source) ──
    const SRC_COUNTY_ALERTS    = 'pg-county-alerts';
    const LYR_COUNTY_SELECTED = 'pg-county-selected';
    const LYR_COUNTY_OUTLINE  = 'pg-county-selected-outline';

    // ── Front source / layer IDs ───────────────────────────────────────
    const SRC_FRONTS     = 'pg-fronts';
    const LYR_FRONT_PIP  = 'pg-front-pip';
    const LYR_FRONT_PIP_OUTLINE = 'pg-front-pip-outline';
    const LYR_FRONT_DECOR_LINE = 'pg-front-decoration-line';
    const LYR_FRONT_DECOR_DOT = 'pg-front-decoration-dot';
    const LYR_ITCZ_LINE = 'pg-itcz-line';
    const LYR_ITCZ_LINK = 'pg-itcz-cross-link';
    const LYR_FRONT_LINE = 'pg-front-line';
    const LYR_FRONT_DASHED_LINE = 'pg-front-dashed-line';
    const LYR_ISOCHRONE_LABEL = 'pg-isochrone-label';
    const LYR_VECTOR_LABEL = 'pg-vector-label';

    // ── Text / symbol source / layer IDs ──────────────────────────────
    const SRC_SYMBOLS    = 'pg-symbols';
    const LYR_SYMBOL     = 'pg-symbol-text';
    const LYR_BOXED_TEXT = 'pg-symbol-boxed-text';
    const LYR_PRESSURE_LABEL = 'pg-symbol-pressure-label';
    const LYR_HURRICANE_SYMBOL = 'pg-symbol-hurricane';
    const LYR_GEMPAK_SYMBOL = 'pg-symbol-gempak';
    const HURRICANE_SYMBOL_ID = 'gempak-spsym26';
    const GEMPAK_SDF_PIXEL_RATIO = 4;
    const GEMPAK_SDF_VERSION = 6;

    // ── Measurement / extrapolation source and layers ────────────────
    const SRC_GUIDES = 'pg-guides';
    const LYR_GUIDE_LINE = 'pg-guide-line';
    const LYR_GUIDE_PROJECTION = 'pg-guide-projection';
    const LYR_GUIDE_POINT = 'pg-guide-point';
    const LYR_GUIDE_LABEL = 'pg-guide-label';

    // ── Draft source / layer IDs ───────────────────────────────────────
    const SRC_DRAFT      = 'pg-draft';
    const LYR_DRAFT      = 'pg-draft-line';
    const LYR_VERTS      = 'pg-draft-verts';

    // ── Edit-mode source / layer IDs ───────────────────────────────────
    const SRC_EDIT       = 'pg-edit';
    const LYR_EDIT_LINE  = 'pg-edit-line';
    const LYR_EDIT_VERTS = 'pg-edit-verts';
    const LYR_EDIT_HIT   = 'pg-edit-vertex-hit-area';
    const SRC_EDIT_MID   = 'pg-edit-mid';    // midpoint insert handles
    const LYR_EDIT_MID   = 'pg-edit-mid-verts';

    // ── Front pip sizing (km units) ────────────────────────────────────
    const PIP_SPACING_KM   = 150;   // km between pip centres along front
    const PIP_COLD_BASE_KM = 28;    // half-base of cold front triangle
    const PIP_COLD_HT_KM   = 48;    // height of cold front triangle
    const PIP_WARM_R_KM    = 38;    // radius of warm front semicircle
    const PIP_DRY_R_KM     = 30;
    // NCEP dryline scallops are effectively contiguous: centre spacing equals
    // the semicircle diameter so adjacent arc endpoints meet.
    const PIP_DRY_SPACING_KM = PIP_DRY_R_KM * 2;
    // Squall cycle at baseline zoom:
    // 66 km dash, 24 km gap, dot, 30 km gap, dot, 24 km gap, repeat.
    // A small placement unit lets the dash grow without consuming either gap.
    const SQUALL_PATTERN_UNIT_KM = 3;
    const SQUALL_DASH_HALF_KM = 33;
    const STREAMLINE_ARROW_SPACING_KM = 280;
    const STREAMLINE_ARROW_LENGTH_KM = 32;
    const VECTOR_ARROW_LENGTH_KM = 44;
    const RIDGE_ZIG_SPACING_KM = 34;
    const RIDGE_ZIG_AMPLITUDE_KM = 16;
    const ITCZ_HALF_WIDTH_KM = 18;
    const ITCZ_HATCH_SPACING_KM = 70;
    const ITCZ_HATCH_SKEW_KM = 14;
    const KM_PER_DEGREE_LAT = 111.2;
    const FRONT_SMOOTHING_PASSES = 3;

    // ── Per-front-type defaults ────────────────────────────────────────
    const FRONT_CFG = {
        'cold':       { color: '#3388ff', pipMode: 'cold'  },
        'warm':       { color: '#ff3333', pipMode: 'warm'  },
        'stationary': { color: '#884488', pipMode: 'stat'  },
        'occluded':   { color: '#9922cc', pipMode: 'occ'   },
        'dryline':    { color: '#b05000', pipMode: 'dry'   },
        'squall':     { color: '#ff3333', pipMode: 'squall'},
        'trough':     { color: '#cc8800', pipMode: 'none'  },
        'streamline': { color: '#55bbff', pipMode: 'streamline', label: 'Streamline' },
        'ridge':      { color: '#ff9900', pipMode: 'ridge', label: 'Zigzag Ridge' },
        'isochrone':  { color: '#cc66ff', pipMode: 'isochrone', label: 'Isochrone' },
        'vector':     { color: '#ffffff', pipMode: 'vector', label: 'Vector' },
        'itcz':       { color: '#ff3333', pipMode: 'itcz', label: 'ITCZ' },
    };

    let _map     = null;
    let _panel   = null;
    let _isOpen  = false;
    let _getCurrentFrameTime = () => null;
    let _lastFrontGeometryScale = null;
    const _gempakImagePromises = new Map();

    // Drawing tool state
    let _activeTool  = null;   // 'contour'|'front-cold'|…|'H'|'L'|'text'|null
    let _drawing     = false;
    let _draftCoords = [];     // [[lng,lat], …]
    let _mouseCoord  = null;
    let _draftObservations = [];
    let _curExtrapInterval = 30;
    let _curExtrapSteps = 6;

    // Products store — each element has: id, kind, name, visible, …kind-specific fields
    let _products = [];
    let _nextId   = 1;

    // Undo / redo stacks (JSON snapshots of _products)
    let _undoStack = [];
    let _redoStack = [];
    const MAX_UNDO = 30;

    // Edit-mode state
    let _editProduct = null;
    let _editCoords  = [];
    let _dragVertIdx = -1;
    let _overEditVertex = false;
    let _draggingText = false;
    let _draggedProductId = null;

    // Named map-layer event handlers (needed for .off() cleanup)
    const _onEditVertEnter = () => {
        _overEditVertex = true;
        if (_dragVertIdx < 0) _map.getCanvas().style.cursor = 'move';
    };
    const _onEditVertLeave = () => {
        _overEditVertex = false;
        if (_dragVertIdx < 0) _map.getCanvas().style.cursor = '';
    };
    const _onEditMidEnter  = () => { _map.getCanvas().style.cursor = 'copy'; };
    const _onEditMidLeave  = () => { if (_dragVertIdx < 0) _map.getCanvas().style.cursor = ''; };

    // Active style defaults (for the next product to be created)
    let _curColor    = '#ffff00';
    let _curWidth    = 2;
    let _curType     = 'General';
    let _curPattern  = 'solid';
    let _curPatternDensity = 3;
    let _curPatternWidth = 1.5;
    let _curText     = 'Label';
    let _curFontSize = 20;
    let _curPressure = '';
    let _curTextBoxed = false;
    let _curTextBackground = '#101020';
    let _curGempakSymbolId = GEMPAK_SYMBOLS[0]?.id || '';
    let _curAlertSignificance = 'Warning';
    let _curAlertHazard = 'Severe Thunderstorm';
    let _curAlertNumber = '';
    let _activeForecastSuiteId = 'free';
    let _activeForecastProductId = null;
    let _activeForecastLevelId = null;
    let _activeCountyProduct = null;
    let _countyFeaturesByFips = new Map();
    let _countySpatialGrid = new Map();
    const COUNTY_GRID_DEGREES = 2;

    // ------------------------------------------------------------------
    // Tiny scoped logger
    // ------------------------------------------------------------------
    const PG = {
        tag: '%c[PG]%c',
        css: ['color:#bf4aff;font-weight:bold', 'color:inherit'],
        info (msg, ...a) { console.info( this.tag+' '+msg, ...this.css, ...a); },
        debug(msg, ...a) { console.debug(this.tag+' '+msg, ...this.css, ...a); },
    };

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    function init(map, options = {}) {
        _map = map;
        _getCurrentFrameTime = typeof options.getCurrentFrameTime === 'function'
            ? options.getCurrentFrameTime : () => null;
        _buildDOM();
        _addMapLayers();
        _loadCountyReference();
        _lastFrontGeometryScale = `${_frontGeometryScale()}:${_itczGeometryScale()}`;
        _map.on('zoomend', () => {
            const scale = `${_frontGeometryScale()}:${_itczGeometryScale()}`;
            if (scale === _lastFrontGeometryScale) return;
            _lastFrontGeometryScale = scale;
            _updateFrontLayer();
        });
        PG.info('ProductGen initialised');

        // Keyboard shortcuts for undo/redo, cancel, delete last vertex
        document.addEventListener('keydown', (e) => {
            // Undo / Redo
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); _undo(); return; }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); _redo(); return; }
            if (e.key === 'Escape') {
                if (_drawing) _cancelDraft();
                else if (_editProduct) _exitEditMode();
                else if (_activeTool === 'county-alert') _enterTool(null);
                return;
            }
            if (!_drawing) return;
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (_draftCoords.length) {
                    _draftCoords.pop();
                    if (_draftObservations.length > _draftCoords.length) _draftObservations.pop();
                    _updateDraftLayer();
                }
            }
        });
    }

    // Open the ProductGen panel (show it and enable drawing tools)
    function open() {
        if (_panel) _panel.style.display = 'flex';
        _isOpen = true;
        PG.debug('Panel opened');
    }

    // Close the ProductGen panel (hide it and cancel any active drawing)
    function close() {
        _cancelDraft();
        _enterTool(null);
        if (_panel) _panel.style.display = 'none';
        _isOpen = false;
        PG.debug('Panel closed');
    }

    // Toggle the ProductGen panel open/closed; returns true if now open
    function toggle() {
        _isOpen ? close() : open();
        return _isOpen;
    }

    // ------------------------------------------------------------------
    // DOM construction
    // ------------------------------------------------------------------
    function _buildDOM() {
        _panel = document.createElement('div');
        _panel.id = 'pg-panel';
        _panel.style.display = 'none';
        _panel.innerHTML = `
<div id="pg-titlebar">
  <span id="pg-title">&#9998; PRODUCT GEN</span>
  <div class="pg-tb-btns">
    <button class="pg-hdr-btn" id="pg-undo" title="Undo (Ctrl+Z)" disabled>&#8617;</button>
    <button class="pg-hdr-btn" id="pg-redo" title="Redo (Ctrl+Y)" disabled>&#8618;</button>
    <button class="pg-hdr-btn" id="pg-validate-btn" title="Validate forecast suite geometry">&#10003;</button>
    <button class="pg-hdr-btn" id="pg-import-btn" title="Import Product Generation GeoJSON">&#8679;</button>
    <button class="pg-hdr-btn" id="pg-export-btn" title="Export products as GeoJSON">&#8681;</button>
    <input id="pg-import-file" type="file" accept=".geojson,.json,application/geo+json,application/json" hidden />
    <button id="pg-close" title="Close">&#10005;</button>
  </div>
</div>

<div id="pg-controls-scroll">
<details class="pg-tool-section">
<summary>FORECAST SUITE <span class="pg-sect-note">prototype</span></summary>
<div id="pg-forecast-suite-controls">
  <div class="pg-style-row">
    <label class="pg-lbl" for="pg-forecast-suite">Suite</label>
    <select id="pg-forecast-suite">
      <option value="free">Free Drawing</option>
    </select>
  </div>
  <div class="pg-style-row pg-forecast-config-row" id="pg-row-forecast-product">
    <label class="pg-lbl" for="pg-forecast-product">Product</label>
    <select id="pg-forecast-product"></select>
  </div>
  <div class="pg-style-row pg-forecast-config-row" id="pg-row-forecast-level">
    <label class="pg-lbl" for="pg-forecast-level">Level</label>
    <select id="pg-forecast-level"></select>
  </div>
  <div id="pg-forecast-validation" class="pg-forecast-validation pg-validation-empty" role="status">
    Validity: draw a suite contour to check
  </div>
</div>
</details>

<details class="pg-tool-section" open>
<summary>AREAS &amp; ALERTS <span class="pg-sect-note">spatial forecast products</span></summary>
<div class="pg-tool-group pg-tool-group-areas">
  <button class="pg-tool-btn" id="pg-tool-contour" data-tool="contour" title="Closed Contour — click vertices, dbl-click to close">
    <svg width="40" height="18" viewBox="0 0 40 18" fill="none" stroke="currentColor" stroke-width="1.6">
      <ellipse cx="20" cy="9" rx="16" ry="6"/>
      <ellipse cx="20" cy="9" rx="8" ry="3"/>
    </svg>
    <span>Contour</span>
  </button>
  <button class="pg-tool-btn" id="pg-tool-county-alert" data-tool="county-alert" title="County Alert — click counties to add or remove them">
    <span style="font-size:16px;line-height:1.1">▦</span>
    <span>County Alert</span>
  </button>
</div>
</details>

<details class="pg-tool-section" open>
<summary>FRONTS &amp; LINES <span class="pg-sect-note">symbols follow draw direction</span></summary>
<div class="pg-tool-group pg-tool-group-fronts">
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-cold" data-tool="front-cold" title="Cold Front">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#3388ff" stroke-width="2"/>
      <polygon points="7,9 16,9 11.5,17" fill="#3388ff"/>
      <polygon points="26,9 35,9 30.5,17" fill="#3388ff"/>
    </svg>
    <span style="color:#3388ff">Cold</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-warm" data-tool="front-warm" title="Warm Front">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#ff3333" stroke-width="2"/>
      <path d="M 3,9 A 8,8 0 0 0 19,9" fill="#ff3333"/>
      <path d="M 23,9 A 8,8 0 0 0 39,9" fill="#ff3333"/>
    </svg>
    <span style="color:#ff3333">Warm</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-stationary" data-tool="front-stationary" title="Stationary Front — cold triangles right, warm bumps left">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#884488" stroke-width="2"/>
      <polygon points="5,9 17,9 11,2" fill="#3388ff"/>
      <path d="M 25,9 Q 32,17 39,9 Z" fill="#ff3333"/>
    </svg>
    <span style="color:#884488">Stat</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-occluded" data-tool="front-occluded" title="Occluded Front">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#9922cc" stroke-width="2"/>
      <polygon points="7,9 16,9 11.5,17" fill="#9922cc"/>
      <path d="M 23,9 A 8,8 0 0 0 39,9" fill="#9922cc"/>
    </svg>
    <span style="color:#9922cc">Occ</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-dryline" data-tool="front-dryline" title="Dry Line">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#b05000" stroke-width="2"/>
      <path d="M 3,9 A 8,8 0 0 1 19,9" fill="none" stroke="#b05000" stroke-width="2"/>
      <path d="M 23,9 A 8,8 0 0 1 39,9" fill="none" stroke="#b05000" stroke-width="2"/>
    </svg>
    <span style="color:#b05000">Dry</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-trough" data-tool="front-trough" title="Trough (dashed, no pips)">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#cc8800" stroke-width="2" stroke-dasharray="5 4"/>
    </svg>
    <span style="color:#cc8800">Trgh</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-squall" data-tool="front-squall" title="Squall Line — repeating short line, dot, dot pattern">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="1" y1="9" x2="14" y2="9" stroke="#ff3333" stroke-width="2"/>
      <circle cx="22" cy="9" r="1.7" fill="#ff3333"/><circle cx="29" cy="9" r="1.7" fill="#ff3333"/>
      <line x1="37" y1="9" x2="44" y2="9" stroke="#ff3333" stroke-width="2"/>
    </svg>
    <span style="color:#ff3333">Squall</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-streamline" data-tool="front-streamline" title="Streamline — arrows point in drawing direction">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#55bbff" stroke-width="2">
      <path d="M1 12 C12 2 28 16 43 6"/>
      <path d="M30 9 L38 8 L35 15"/>
    </svg>
    <span style="color:#55bbff">Stream</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-ridge" data-tool="front-ridge" title="Zigzag Ridge Line">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#ff9900" stroke-width="2">
      <path d="M1 13 L7 5 L13 13 L19 5 L25 13 L31 5 L37 13 L43 5"/>
    </svg>
    <span style="color:#ff9900">Ridge</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-isochrone" data-tool="front-isochrone" title="Isochrone — line connecting equal forecast arrival times">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#cc66ff" stroke-width="2">
      <path d="M1 11 C11 3 29 3 43 11" stroke-dasharray="5 3"/>
      <text x="17" y="17" fill="#cc66ff" stroke="none" font-size="7">T+</text>
    </svg>
    <span style="color:#cc66ff">Isochrone</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-vector" data-tool="front-vector" title="Curved vector — place control points and double-click the arrow tip">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#dddddd" stroke-width="2">
      <path d="M2 14 L39 4 M39 4 L31 3 M39 4 L34 11"/>
    </svg>
    <span>Vector</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-itcz" data-tool="front-itcz" title="Intertropical Convergence Zone boundary">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#ff3333" stroke-width="1.6">
      <path d="M1 7 C12 1 31 13 43 7"/>
      <path d="M1 11 C12 5 31 17 43 11"/>
      <path d="M5 6 L10 11 M13 5 L18 12 M22 7 L27 14 M31 8 L36 13"/>
    </svg>
    <span style="color:#ff3333">ITCZ</span>
  </button>
</div>
</details>

<details class="pg-tool-section">
<summary>MEASURE &amp; EXTRAPOLATE</summary>
<div class="pg-tool-group">
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-distance" data-tool="distance" title="Measure geodesic distance and bearing between two points">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#66e0ff" stroke-width="2">
      <path d="M4 14 L40 4"/><circle cx="4" cy="14" r="2" fill="#66e0ff"/><circle cx="40" cy="4" r="2" fill="#66e0ff"/>
    </svg>
    <span style="color:#66e0ff">Distance</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-extrapolate" data-tool="extrapolate" title="Track two positions on different dominant frames and extrapolate their motion">
    <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="#66ff99" stroke-width="2">
      <circle cx="5" cy="14" r="2" fill="#66ff99"/><circle cx="17" cy="10" r="2" fill="#66ff99"/>
      <path d="M5 14 L17 10 L39 3" stroke-dasharray="4 3"/><path d="M39 3 L32 2 M39 3 L35 9"/>
    </svg>
    <span style="color:#66ff99">Extrap</span>
  </button>
</div>
</details>

<details class="pg-tool-section">
<summary>SYMBOLS &amp; TEXT</summary>
<div class="pg-tool-group">
  <button class="pg-tool-btn pg-sym-btn" id="pg-tool-H" data-tool="H" title="High Pressure Center — single click to place">
    <span style="font-size:17px;font-weight:bold;color:#4488ff;line-height:1.1">H</span>
    <span>High</span>
  </button>
  <button class="pg-tool-btn pg-sym-btn" id="pg-tool-L" data-tool="L" title="Low Pressure Center — single click to place">
    <span style="font-size:17px;font-weight:bold;color:#ff4444;line-height:1.1">L</span>
    <span>Low</span>
  </button>
  <button class="pg-tool-btn" id="pg-tool-text" data-tool="text" title="Text Annotation — single click to place">
    <span style="font-size:13px;font-weight:bold;line-height:1.1">ABC</span>
    <span>Text</span>
  </button>
  <button class="pg-tool-btn pg-sym-btn" id="pg-tool-hurricane" data-tool="hurricane" title="Hurricane / tropical cyclone center — single click to place">
    <span style="font-size:19px;line-height:1.1;color:#ff55aa">🌀</span>
    <span>Hurricane</span>
  </button>
</div>
<details class="pg-symbol-library">
  <summary>NAWIPS symbol library</summary>
  <div class="pg-symbol-picker">
    <div id="pg-gempak-palette"></div>
  </div>
</details>
</details>

<section class="pg-style-section-static">
<div class="pg-section-lbl">STYLE</div>
<div id="pg-style-section">
  <div class="pg-style-row" id="pg-row-ctype">
    <label class="pg-lbl">Type</label>
    <select id="pg-type">
      <option value="General">General</option>
      <option value="Category">Category</option>
      <option value="Probability">Probability</option>
      <option value="Amount">Amount</option>
      <option value="Region of Interest">Region of Interest</option>
      <option value="Threat Area">Threat Area</option>
      <option value="Advisory">Advisory</option>
      <option value="Custom">Custom</option>
    </select>
  </div>
  <div class="pg-style-row" id="pg-row-pattern">
    <label class="pg-lbl">Fill</label>
    <select id="pg-pattern">
      <option value="solid">Solid</option>
      <option value="hatch">Hatch</option>
      <option value="crosshatch">Crosshatch</option>
      <option value="dots">Dots</option>
      <option value="stars">Stars</option>
      <option value="checker">Checker</option>
      <option value="dashes">Dashes</option>
    </select>
  </div>
  <div class="pg-style-row" id="pg-row-pattern-density">
    <label class="pg-lbl">Density</label>
    <input type="number" id="pg-pattern-density" min="0.25" max="5" step="0.25" value="3" title="Lower values are sparser; higher values are denser" />
  </div>
  <div class="pg-style-row" id="pg-row-pattern-width">
    <label class="pg-lbl">Pattern Width</label>
    <input type="number" id="pg-pattern-width" min="0.5" max="6" step="0.25" value="1.5" title="Width of hatch and dash marks in pixels" />
  </div>
  <div class="pg-style-row" id="pg-row-text">
    <label class="pg-lbl">Text</label>
    <input type="text" id="pg-text-content" value="Label" placeholder="Annotation\u2026" />
  </div>
  <div class="pg-style-row" id="pg-row-pressure">
    <label class="pg-lbl">Pressure</label>
    <input type="number" id="pg-pressure-value" min="850" max="1100" step="1" placeholder="Optional" title="Optional center pressure in hPa (mb)" />
    <span class="pg-unit">hPa</span>
  </div>
  <div class="pg-style-row" id="pg-row-text-box">
    <label class="pg-lbl" for="pg-text-boxed">Text Box</label>
    <input type="checkbox" id="pg-text-boxed" />
  </div>
  <div class="pg-style-row" id="pg-row-text-background">
    <label class="pg-lbl" for="pg-text-background">Background</label>
    <input type="color" id="pg-text-background" value="#101020" />
  </div>
  <div class="pg-style-row" id="pg-row-extrap-interval">
    <label class="pg-lbl">Interval</label>
    <input type="number" id="pg-extrap-interval" min="1" max="360" step="1" value="30" />
    <span class="pg-unit">min</span>
  </div>
  <div class="pg-style-row" id="pg-row-extrap-steps">
    <label class="pg-lbl">Steps</label>
    <input type="number" id="pg-extrap-steps" min="1" max="24" step="1" value="6" />
  </div>
  <div class="pg-style-row" id="pg-row-alert-significance">
    <label class="pg-lbl">Alert</label>
    <select id="pg-alert-significance">
      <option value="Warning">Warning</option>
      <option value="Watch">Watch</option>
      <option value="Advisory">Advisory</option>
    </select>
  </div>
  <div class="pg-style-row" id="pg-row-alert-hazard">
    <label class="pg-lbl">Hazard</label>
    <select id="pg-alert-hazard">
      <option value="Tornado">Tornado</option>
      <option value="Severe Thunderstorm">Severe Thunderstorm</option>
      <option value="Flash Flood">Flash Flood</option>
      <option value="Flood">Flood</option>
      <option value="Winter Storm">Winter Storm</option>
      <option value="High Wind">High Wind</option>
      <option value="Fire Weather">Fire Weather</option>
      <option value="Custom">Custom</option>
    </select>
  </div>
  <div class="pg-style-row" id="pg-row-alert-number">
    <label class="pg-lbl">Number</label>
    <input type="number" id="pg-alert-number" min="1" max="9999" step="1" placeholder="Optional" title="Watch or warning identification number" />
  </div>
  <div class="pg-style-row" id="pg-row-color">
    <label class="pg-lbl">Color</label>
    <input type="color" id="pg-color" value="#ffff00" />
    <label class="pg-lbl" style="margin-left:8px" id="pg-lbl-size">Width</label>
    <input type="number" id="pg-width" min="1" max="40" value="2" />
  </div>
</div>
</section>
</div>

<div id="pg-products-hdr">
  <span>PRODUCTS <span class="pg-stack-note">drag to reorder</span></span>
  <button class="pg-sm-btn" id="pg-clear-all" title="Remove all products">Clear All</button>
</div>
<ul id="pg-product-list">
  <li class="pg-no-products">No products drawn.</li>
</ul>
<div id="pg-hint"></div>
`;
        document.body.appendChild(_panel);

        _initializeForecastSuiteControls();
        _initializeGempakSymbolPicker();

        // Close
        _panel.querySelector('#pg-close').addEventListener('click', close);

        // All tool buttons — toggle on/off
        _panel.querySelectorAll('.pg-tool-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tool = btn.dataset.tool;
                _enterTool(_activeTool === tool ? null : tool);
            });
        });

        // Color picker for contour, front, and text
        _panel.querySelector('#pg-color').addEventListener('input', (e) => {
            _curColor = e.target.value;
            if (_editProduct) {
                if (_editProduct.kind === 'contour') { _editProduct.color = _curColor; _updateContourLayer(); }
                else if (_editProduct.kind === 'front')  { _editProduct.color = _curColor; _updateFrontLayer();   }
                else if (_editProduct.kind === 'text')   { _editProduct.color = _curColor; _updateSymbolLayer();  }
            }
        });

        // Contour type dropdown (General, Probability, ROI, Threat Area, Advisory, Custom)
        _panel.querySelector('#pg-type').addEventListener('change', (e) => {
            _curType = e.target.value;
            if (_editProduct && _editProduct.kind === 'contour') {
                _editProduct.type = _curType;
                _renderProductList();
            }
        });

        // Contour fill pattern. Pattern images are generated locally and keyed
        // by both pattern and color so every contour can have its own styling.
        _panel.querySelector('#pg-pattern').addEventListener('change', (e) => {
            _curPattern = e.target.value;
            if (_editProduct && _editProduct.kind === 'contour') {
                _editProduct.fillPattern = _curPattern;
                _updateContourLayer();
                _renderProductList();
            }
            _updateStylePanel();
        });
        _panel.querySelector('#pg-pattern-density').addEventListener('input', (e) => {
            _curPatternDensity = Math.max(0.25, Math.min(5, +e.target.value || 3));
            e.target.value = _curPatternDensity;
            if (_editProduct && _editProduct.kind === 'contour') {
                _editProduct.patternDensity = _curPatternDensity;
                _updateContourLayer();
                _renderProductList();
            }
        });
        _panel.querySelector('#pg-pattern-width').addEventListener('input', (e) => {
            _curPatternWidth = Math.max(0.5, Math.min(6, +e.target.value || 1.5));
            e.target.value = _curPatternWidth;
            if (_editProduct && _editProduct.kind === 'contour') {
                _editProduct.patternWidth = _curPatternWidth;
                _updateContourLayer();
                _renderProductList();
            }
        });
        _panel.querySelector('#pg-alert-significance').addEventListener('change', (e) => {
            _curAlertSignificance = e.target.value;
            if (_activeCountyProduct) {
                _activeCountyProduct.significance = _curAlertSignificance;
                _activeCountyProduct.color = _countyAlertColor(_curAlertSignificance);
                _activeCountyProduct.name = _countyAlertName(_activeCountyProduct);
                _updateCountyAlertLayers();
                _renderProductList();
            }
        });
        _panel.querySelector('#pg-alert-hazard').addEventListener('change', (e) => {
            _curAlertHazard = e.target.value;
            if (_activeCountyProduct) {
                _activeCountyProduct.hazard = _curAlertHazard;
                _activeCountyProduct.name = _countyAlertName(_activeCountyProduct);
                _renderProductList();
            }
        });
        _panel.querySelector('#pg-alert-number').addEventListener('input', (e) => {
            _curAlertNumber = e.target.value === '' ? '' : String(Math.max(1, Math.round(+e.target.value || 1)));
            if (_activeCountyProduct) {
                _activeCountyProduct.alertNumber = _curAlertNumber;
                _activeCountyProduct.name = _countyAlertName(_activeCountyProduct);
                _renderProductList();
            }
        });

        // Width / font-size
        _panel.querySelector('#pg-width').addEventListener('input', (e) => {
            _curWidth = Math.max(1, Math.min(40, +e.target.value || 2));
            if (_editProduct) {
                if (_editProduct.kind === 'contour') { _editProduct.width = _curWidth; _updateContourLayer(); }
                else if (_editProduct.kind === 'front') { _editProduct.width = _curWidth; _updateFrontLayer(); }
                else if (_editProduct.kind === 'text')  { _editProduct.fontSize = _curWidth; _updateSymbolLayer(); }
            }
        });

        // Annotation text
        _panel.querySelector('#pg-text-content').addEventListener('input', (e) => {
            _curText = e.target.value;
            if (_editProduct && _editProduct.kind === 'text') {
                _editProduct.text = _curText;
                _updateSymbolLayer();
            } else if (_editProduct?.kind === 'front' &&
                (_editProduct.frontType === 'isochrone' || _editProduct.frontType === 'vector')) {
                _editProduct.label = _curText;
                _updateFrontLayer();
            }
        });

        _panel.querySelector('#pg-text-boxed').addEventListener('change', (e) => {
            _curTextBoxed = e.target.checked;
            if (_editProduct?.kind === 'text' && _editProduct.subKind === 'text') {
                _editProduct.boxed = _curTextBoxed;
                _updateSymbolLayer();
            }
            _updateStylePanel();
        });
        _panel.querySelector('#pg-text-background').addEventListener('input', (e) => {
            _curTextBackground = e.target.value;
            if (_editProduct?.kind === 'text' && _editProduct.subKind === 'text') {
                _editProduct.backgroundColor = _curTextBackground;
                _updateSymbolLayer();
            }
        });
        _panel.querySelector('#pg-extrap-interval').addEventListener('input', (e) => {
            _curExtrapInterval = Math.max(1, Math.min(360, Math.round(+e.target.value || 30)));
            e.target.value = _curExtrapInterval;
        });
        _panel.querySelector('#pg-extrap-steps').addEventListener('input', (e) => {
            _curExtrapSteps = Math.max(1, Math.min(24, Math.round(+e.target.value || 6)));
            e.target.value = _curExtrapSteps;
        });

        // Optional pressure value for high/low centers.
        _panel.querySelector('#pg-pressure-value').addEventListener('input', (e) => {
            _curPressure = _normalizedPressure(e.target.value);
            if (_editProduct?.kind === 'text' && (_editProduct.subKind === 'H' || _editProduct.subKind === 'L')) {
                _editProduct.pressure = _curPressure;
                _updateSymbolLayer();
                _renderProductList();
            }
        });

        // Undo / redo
        _panel.querySelector('#pg-undo').addEventListener('click', _undo);
        _panel.querySelector('#pg-redo').addEventListener('click', _redo);

        _panel.querySelector('#pg-validate-btn').addEventListener('click', () => {
            const issues = validateForecastProducts(_products);
            _updateForecastValidationStatus(issues, true);
            _renderProductList();
        });

        // Export to GeoJSON
        _panel.querySelector('#pg-export-btn').addEventListener('click', _exportGeoJSON);
        const importFile = _panel.querySelector('#pg-import-file');
        _panel.querySelector('#pg-import-btn').addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', async () => {
            const file = importFile.files?.[0];
            importFile.value = '';
            if (!file) return;
            try {
                await _importGeoJSON(file);
            } catch (error) {
                window.alert(`Unable to import products: ${error.message}`);
            }
        });

        // Clear all
        _panel.querySelector('#pg-clear-all').addEventListener('click', () => {
            _saveUndo();
            if (_activeTool === 'county-alert') _enterTool(null);
            _products = [];
            _exitEditMode();
            _renderProductList();
            _updateAllLayers();
        });

        _updateStylePanel();
    }

    function _initializeForecastSuiteControls() {
        const suiteSelect = _panel.querySelector('#pg-forecast-suite');
        Object.values(FORECAST_SUITE_DEFINITIONS).forEach(suite => {
            const option = document.createElement('option');
            option.value = suite.id;
            option.textContent = suite.label;
            suiteSelect.appendChild(option);
        });

        suiteSelect.addEventListener('change', () => {
            _activeForecastSuiteId = suiteSelect.value;
            _activeForecastProductId = null;
            _activeForecastLevelId = null;
            _refreshForecastProductOptions();
        });
        _panel.querySelector('#pg-forecast-product').addEventListener('change', (event) => {
            _activeForecastProductId = event.target.value;
            _activeForecastLevelId = null;
            _refreshForecastLevelOptions();
        });
        _panel.querySelector('#pg-forecast-level').addEventListener('change', (event) => {
            _activeForecastLevelId = event.target.value;
            _applyForecastLevelDefaults();
        });
        _refreshForecastProductOptions();
    }

    function _refreshForecastProductOptions() {
        const productRow = _panel.querySelector('#pg-row-forecast-product');
        const levelRow = _panel.querySelector('#pg-row-forecast-level');
        const productSelect = _panel.querySelector('#pg-forecast-product');
        const suite = getForecastSuite(_activeForecastSuiteId);
        const configured = Boolean(suite);
        productRow.style.display = configured ? '' : 'none';
        levelRow.style.display = configured ? '' : 'none';
        productSelect.innerHTML = '';
        if (!suite) return;

        suite.products.forEach(product => {
            const option = document.createElement('option');
            option.value = product.id;
            option.textContent = product.label;
            productSelect.appendChild(option);
        });
        _activeForecastProductId = suite.products.some(product => product.id === _activeForecastProductId)
            ? _activeForecastProductId : suite.products[0]?.id || null;
        productSelect.value = _activeForecastProductId || '';
        _refreshForecastLevelOptions();
    }

    function _refreshForecastLevelOptions() {
        const levelSelect = _panel.querySelector('#pg-forecast-level');
        const product = getForecastProduct(_activeForecastSuiteId, _activeForecastProductId);
        levelSelect.innerHTML = '';
        if (!product) return;

        (product.levels || []).forEach(level => {
            const option = document.createElement('option');
            option.value = level.id;
            option.textContent = level.label;
            levelSelect.appendChild(option);
        });
        (product.overlays || []).forEach(level => {
            const option = document.createElement('option');
            option.value = level.id;
            option.textContent = `${level.label} (overlay)`;
            levelSelect.appendChild(option);
        });
        const allLevels = [...(product.levels || []), ...(product.overlays || [])];
        _activeForecastLevelId = allLevels.some(level => level.id === _activeForecastLevelId)
            ? _activeForecastLevelId : allLevels[0]?.id || null;
        levelSelect.value = _activeForecastLevelId || '';
        _applyForecastLevelDefaults();
    }

    function _configuredContourContext() {
        const suite = getForecastSuite(_activeForecastSuiteId);
        const product = getForecastProduct(_activeForecastSuiteId, _activeForecastProductId);
        const level = getForecastLevel(_activeForecastSuiteId, _activeForecastProductId, _activeForecastLevelId);
        return suite && product && level ? {suite, product, level} : null;
    }

    function _forecastTypeLabel(product, level) {
        if (level.role === 'overlay') return 'Significant';
        if (product.valueType === 'probability') return 'Probability';
        if (product.valueType === 'amount') return 'Amount';
        if (product.valueType === 'category') return 'Category';
        return 'General';
    }

    function _applyForecastLevelDefaults() {
        const context = _configuredContourContext();
        if (!context) return;
        const {product, level} = context;
        _curType = _forecastTypeLabel(product, level);
        _curColor = level.color || '#ffff00';
        _curWidth = level.width || 2;
        _curPattern = level.pattern || 'solid';
        _curPatternDensity = level.patternDensity || 3;
        _curPatternWidth = level.patternWidth || 1.5;

        _panel.querySelector('#pg-type').value = _curType;
        _panel.querySelector('#pg-color').value = _curColor;
        _panel.querySelector('#pg-width').value = _curWidth;
        _panel.querySelector('#pg-pattern').value = _curPattern;
        _panel.querySelector('#pg-pattern-density').value = _curPatternDensity;
        _panel.querySelector('#pg-pattern-width').value = _curPatternWidth;
        _updateStylePanel();
    }

    // ------------------------------------------------------------------
    // Style panel: show/hide rows based on active tool
    // ------------------------------------------------------------------
    function _updateStylePanel() {
        if (!_panel) return;
        const isFront   = _activeTool && _activeTool.startsWith('front-');
        const isContour = _activeTool === 'contour';
        const isText    = _activeTool === 'text';
        const noTool    = !_activeTool;
        const isPressureTool = _activeTool === 'H' || _activeTool === 'L';
        const editingPressureCenter = noTool && _editProduct?.kind === 'text' &&
            (_editProduct.subKind === 'H' || _editProduct.subKind === 'L');
        const editingFreeText = noTool && _editProduct?.kind === 'text' && _editProduct.subKind === 'text';
        const isGempak  = _activeTool === 'gempak-symbol';
        const isHL      = isPressureTool || editingPressureCenter || _activeTool === 'hurricane';
        const isCountyAlert = _activeTool === 'county-alert';
        const isExtrapolate = _activeTool === 'extrapolate';

        // "Type" row only for contour tool
        const showContourStyle = isContour || (noTool && _editProduct?.kind === 'contour');
        const showPatternOptions = showContourStyle && _curPattern !== 'solid';
        _panel.querySelector('#pg-row-ctype').style.display = showContourStyle ? '' : 'none';
        _panel.querySelector('#pg-row-pattern').style.display = showContourStyle ? '' : 'none';
        _panel.querySelector('#pg-row-pattern-density').style.display = showPatternOptions ? '' : 'none';
        _panel.querySelector('#pg-row-pattern-width').style.display = showPatternOptions ? '' : 'none';
        _panel.querySelector('#pg-row-alert-significance').style.display = isCountyAlert ? '' : 'none';
        _panel.querySelector('#pg-row-alert-hazard').style.display = isCountyAlert ? '' : 'none';
        _panel.querySelector('#pg-row-alert-number').style.display = isCountyAlert ? '' : 'none';
        // "Text" row only for text tool (or editing a text product)
        const isLabeledLine = _activeTool === 'front-isochrone' || _activeTool === 'front-vector' ||
            (noTool && _editProduct?.kind === 'front' &&
                (_editProduct.frontType === 'isochrone' || _editProduct.frontType === 'vector'));
        _panel.querySelector('#pg-row-text').style.display = (isText || editingFreeText || isLabeledLine) ? '' : 'none';
        _panel.querySelector('#pg-row-text-box').style.display = (isText || editingFreeText) ? '' : 'none';
        _panel.querySelector('#pg-row-text-background').style.display =
            (isText || editingFreeText) && _curTextBoxed ? '' : 'none';
        _panel.querySelector('#pg-row-extrap-interval').style.display = isExtrapolate ? '' : 'none';
        _panel.querySelector('#pg-row-extrap-steps').style.display = isExtrapolate ? '' : 'none';
        _panel.querySelector('#pg-row-pressure').style.display = (isPressureTool || editingPressureCenter) ? '' : 'none';
        // "Color+Width" row always, but hidden for H/L (auto-coloured)
        _panel.querySelector('#pg-row-color').style.display = (isHL || isCountyAlert) ? 'none' : '';
        // Label for width vs. size
        const sizeLabel = _panel.querySelector('#pg-lbl-size');
        if (sizeLabel) sizeLabel.textContent = (isText || isGempak || (noTool && _editProduct?.kind === 'text')) ? 'Size' : 'Width';
    }

    function _gempakSymbol(symbolId) {
        return GEMPAK_SYMBOLS.find(symbol => symbol.id === symbolId) || null;
    }

    function _decodeGempakMask(symbol, scale = 1) {
        const bytes = Uint8Array.from(atob(symbol.bits), char => char.charCodeAt(0));
        const width = symbol.width * scale;
        const height = symbol.height * scale;
        const pixels = new Uint8ClampedArray(width * height * 4);
        const rowBytes = Math.ceil(symbol.width / 8);
        for (let y = 0; y < symbol.height; y++) {
            for (let x = 0; x < symbol.width; x++) {
                if (!(bytes[y * rowBytes + Math.floor(x / 8)] & (1 << (x % 8)))) continue;
                for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
                    const offset = ((y * scale + sy) * width + x * scale + sx) * 4;
                    pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 255;
                }
            }
        }
        return {width, height, data: pixels};
    }

    // Convert the one-bit legacy mask to a signed-distance field. MapLibre can
    // then interpolate the edge smoothly at any icon-size and apply color/halo.
    function _decodeGempakSdf(symbol, scale = 4) {
        const source = _decodeGempakMask(symbol, 1);
        const inside = (x, y) => x >= 0 && y >= 0 && x < symbol.width && y < symbol.height &&
            source.data[(y * symbol.width + x) * 4 + 3] > 0;
        const boundaries = [];
        for (let y = 0; y < symbol.height; y++) for (let x = 0; x < symbol.width; x++) {
            const value = inside(x, y);
            if (inside(x - 1, y) !== value || inside(x + 1, y) !== value ||
                inside(x, y - 1) !== value || inside(x, y + 1) !== value) boundaries.push([x + 0.5, y + 0.5]);
        }
        const width = symbol.width * scale;
        const height = symbol.height * scale;
        const pixels = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const sx = (x + 0.5) / scale;
            const sy = (y + 0.5) / scale;
            let distance2 = 64;
            boundaries.forEach(([bx, by]) => { distance2 = Math.min(distance2, (sx - bx) ** 2 + (sy - by) ** 2); });
            const signedDistance = Math.sqrt(distance2) * (inside(Math.floor(sx), Math.floor(sy)) ? 1 : -1);
            const alpha = Math.max(0, Math.min(255, Math.round(128 + signedDistance * 32)));
            const offset = (y * width + x) * 4;
            pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 255;
            pixels[offset + 3] = alpha;
        }
        return {width, height, data: pixels};
    }

    function _drawGempakPreview(canvas, symbol) {
        const ctx = canvas.getContext('2d');
        const image = _decodeGempakMask(symbol, 3);
        const scratch = document.createElement('canvas');
        scratch.width = image.width; scratch.height = image.height;
        scratch.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.filter = 'blur(0.55px)';
        ctx.drawImage(scratch, 3, 3, canvas.width - 6, canvas.height - 6);
        ctx.filter = 'none';
    }

    function _gempakImageId(symbolId) {
        return `${symbolId}-sdf-v${GEMPAK_SDF_VERSION}`;
    }

    function _ensureGempakImage(symbolId) {
        const symbol = _gempakSymbol(symbolId);
        if (!_map || !symbol) return '';
        const imageId = _gempakImageId(symbol.id);
        if (_map.hasImage(imageId) || _gempakImagePromises.has(imageId)) return imageId;

        const sdfUrl = `/assets/gempak-symbols/sdf/${symbol.code}.png?v=${GEMPAK_SDF_VERSION}`;
        const load = _map.loadImage(sdfUrl)
            .then(result => result.data || result)
            .catch(error => {
                console.warn(`[PG] SDF symbol fallback for ${symbol.code}:`, error);
                return _decodeGempakSdf(symbol, GEMPAK_SDF_PIXEL_RATIO);
            })
            .then(image => {
                if (_map && !_map.hasImage(imageId)) {
                    _map.addImage(imageId, image, {
                        pixelRatio: GEMPAK_SDF_PIXEL_RATIO,
                        sdf: true,
                    });
                }
            })
            .finally(() => {
                _gempakImagePromises.delete(imageId);
                _updateSymbolLayer();
            });
        _gempakImagePromises.set(imageId, load);
        return imageId;
    }

    function _initializeGempakSymbolPicker() {
        const palette = _panel.querySelector('#pg-gempak-palette');
        const groups = new Map();
        GEMPAK_SYMBOLS.forEach(symbol => {
            if (!groups.has(symbol.group)) groups.set(symbol.group, []);
            groups.get(symbol.group).push(symbol);
        });
        groups.forEach((symbols, label) => {
            const section = document.createElement('details');
            section.className = 'pg-symbol-family';
            if (label === 'Special Symbols' || label === 'Combination Weather') section.open = true;
            const summary = document.createElement('summary');
            summary.textContent = `${label} (${symbols.length})`;
            const grid = document.createElement('div');
            grid.className = 'pg-symbol-grid';
            symbols.forEach(symbol => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'pg-symbol-tile';
                button.dataset.symbolId = symbol.id;
                button.title = `${symbol.label} · ${symbol.code}`;
                button.setAttribute('aria-label', `Place ${symbol.label}`);
                const preview = document.createElement('img');
                preview.src = symbol.svg;
                preview.alt = '';
                preview.loading = 'lazy';
                preview.decoding = 'async';
                preview.addEventListener('error', () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 38;
                    _drawGempakPreview(canvas, symbol);
                    preview.replaceWith(canvas);
                }, {once: true});
                button.appendChild(preview);
                button.addEventListener('click', () => {
                    _curGempakSymbolId = symbol.id;
                    _panel.querySelectorAll('.pg-symbol-tile.active').forEach(tile => tile.classList.remove('active'));
                    button.classList.add('active');
                    _enterTool('gempak-symbol');
                });
                grid.appendChild(button);
            });
            section.append(summary, grid);
            palette.appendChild(section);
        });
    }

    // ------------------------------------------------------------------
    // Undo / Redo
    // ------------------------------------------------------------------
    function _saveUndo() {
        _undoStack.push(JSON.stringify(_products));
        if (_undoStack.length > MAX_UNDO) _undoStack.shift();
        _redoStack = [];
        _updateUndoRedoBtns();
    }

    function _undo() {
        if (!_undoStack.length) return;
        if (_activeTool === 'county-alert') _enterTool(null);
        _exitEditMode();
        _redoStack.push(JSON.stringify(_products));
        _products = JSON.parse(_undoStack.pop());
        _renderProductList();
        _updateAllLayers();
        _updateUndoRedoBtns();
        PG.debug(`Undo → ${_products.length} product(s)`);
    }

    function _redo() {
        if (!_redoStack.length) return;
        if (_activeTool === 'county-alert') _enterTool(null);
        _exitEditMode();
        _undoStack.push(JSON.stringify(_products));
        _products = JSON.parse(_redoStack.pop());
        _renderProductList();
        _updateAllLayers();
        _updateUndoRedoBtns();
        PG.debug(`Redo → ${_products.length} product(s)`);
    }

    function _updateUndoRedoBtns() {
        if (!_panel) return;
        _panel.querySelector('#pg-undo').disabled = _undoStack.length === 0;
        _panel.querySelector('#pg-redo').disabled = _redoStack.length === 0;
    }

    // ------------------------------------------------------------------
    // Tool activation / deactivation
    // ------------------------------------------------------------------
    function _enterTool(toolName) {
        if (_editProduct) _exitEditMode();
        if (_activeTool) {
            _cancelDraft();
            _map.off('click',     _onMapClick);
            _map.off('mousemove', _onMapMouseMove);
            _map.off('dblclick',  _onMapDblClick);
            _map.off('contextmenu', _onCountyRightClick);
            _map.doubleClickZoom.enable();
            _map.getCanvas().style.cursor = '';
            _panel.querySelector(`#pg-tool-${_activeTool}`)?.classList.remove('active');
            if (_activeTool === 'gempak-symbol') {
                _panel.querySelectorAll('.pg-symbol-tile.active').forEach(tile => tile.classList.remove('active'));
            }
        }

        if (toolName !== 'county-alert') {
            _activeCountyProduct = null;
            _hideCountyHover();
        }

        _activeTool = toolName;

        if (toolName) {
            _map.on('click',     _onMapClick);
            _map.on('mousemove', _onMapMouseMove);
            _map.on('dblclick',  _onMapDblClick);
            if (toolName === 'county-alert') _map.on('contextmenu', _onCountyRightClick);
            _map.doubleClickZoom.disable();
            _map.getCanvas().style.cursor = 'crosshair';
            _panel.querySelector(`#pg-tool-${toolName}`)?.classList.add('active');
            if (toolName === 'gempak-symbol') {
                _panel.querySelector(`.pg-symbol-tile[data-symbol-id="${_curGempakSymbolId}"]`)?.classList.add('active');
            }

            // Set sensible style defaults per tool
            if (toolName === 'front-cold')       { _curColor = '#3388ff'; _curWidth = 2.5; }
            else if (toolName === 'front-warm')  { _curColor = '#ff3333'; _curWidth = 2.5; }
            else if (toolName === 'front-stationary') { _curColor = '#884488'; _curWidth = 2.5; }
            else if (toolName === 'front-occluded')   { _curColor = '#9922cc'; _curWidth = 2.5; }
            else if (toolName === 'front-dryline')    { _curColor = '#b05000'; _curWidth = 2.5; }
            else if (toolName === 'front-trough')     { _curColor = '#cc8800'; _curWidth = 2.5; }
            else if (toolName === 'front-squall')     { _curColor = '#ff3333'; _curWidth = 2.5; }
            else if (toolName === 'front-streamline') { _curColor = '#55bbff'; _curWidth = 2.5; }
            else if (toolName === 'front-ridge')      { _curColor = '#ff9900'; _curWidth = 2.5; }
            else if (toolName === 'front-isochrone')  {
                _curColor = '#cc66ff'; _curWidth = 2.5;
                if (!_curText.trim()) _curText = 'T+1h';
                _panel.querySelector('#pg-text-content').value = _curText;
            }
            else if (toolName === 'front-vector')     {
                _curColor = '#ffffff'; _curWidth = 2.5; _curText = '';
                _panel.querySelector('#pg-text-content').value = '';
            }
            else if (toolName === 'front-itcz')       { _curColor = '#ff3333'; _curWidth = 2.5; }
            else if (toolName === 'distance')         { _curColor = '#66e0ff'; _curWidth = 2; }
            else if (toolName === 'extrapolate') {
                _curColor = '#66ff99'; _curWidth = 2;
                _panel.querySelector('#pg-extrap-interval').value = _curExtrapInterval;
                _panel.querySelector('#pg-extrap-steps').value = _curExtrapSteps;
            }
            else if (toolName === 'H') { _curColor = '#4488ff'; _curWidth = 20; }
            else if (toolName === 'L') { _curColor = '#ff4444'; _curWidth = 20; }
            else if (toolName === 'hurricane') { _curColor = '#ff55aa'; _curWidth = 28; }
            else if (toolName === 'gempak-symbol') { _curColor = '#ffffff'; _curWidth = 28; }
            else if (toolName === 'text') { _curWidth = 18; }
            else if (toolName === 'county-alert') {
                _curColor = _countyAlertColor(_curAlertSignificance);
                _panel.querySelector('#pg-alert-significance').value = _curAlertSignificance;
                _panel.querySelector('#pg-alert-hazard').value = _curAlertHazard;
                _panel.querySelector('#pg-alert-number').value = _curAlertNumber;
            }

            // Sync style controls to new defaults
            _panel.querySelector('#pg-color').value = _curColor;
            _panel.querySelector('#pg-width').value = _curWidth;
            if (toolName === 'contour') {
                _panel.querySelector('#pg-pattern').value = _curPattern;
                _panel.querySelector('#pg-pattern-density').value = _curPatternDensity;
                _panel.querySelector('#pg-pattern-width').value = _curPatternWidth;
            }

            const isFront = toolName.startsWith('front-');
            // Set the hint text for the active tool to help the user understand how to draw it
            if (toolName === 'distance') {
                _setHint('Click the start and end points to measure distance and bearing');
            } else if (toolName === 'extrapolate') {
                _setHint('Click the tracked feature on the current frame\nStep forward one or more dominant frames\nClick its new position');
            } else if (toolName === 'front-vector') {
                _setHint('Click to shape the curved vector\nDbl-click to place the arrow tip\nBackspace to undo  Esc to cancel');
            } else if (toolName === 'contour' || isFront) {
                _setHint('Click to place vertices\nDbl-click to finish\nBackspace to undo\xa0\xa0Esc to cancel');
            } else if (toolName === 'county-alert') {
                _setHint('Left-click counties to add or toggle them\nRight-click removes a county\nClick the tool again when finished');
            } else {
                _setHint('Click on the map to place');
            }
        } else {
            _setHint('');
        }

        _updateStylePanel();
    }

    // ------------------------------------------------------------------
    // Map event handlers
    // ------------------------------------------------------------------
    function _onMapClick(e) {
        const tool = _activeTool;
        if (!tool) return;

        if (_editProduct) return; // ignore clicks while editing a product

        // Handle drawing tools: contour and fronts are multi-vertex
        if (tool === 'distance') {
            _drawing = true;
            _draftCoords.push([e.lngLat.lng, e.lngLat.lat]);
            _updateDraftLayer();
            if (_draftCoords.length === 2) _finishDistance();
        } else if (tool === 'extrapolate') {
            const frameTime = _getCurrentFrameTime();
            if (!(frameTime instanceof Date) || !Number.isFinite(frameTime.getTime())) {
                _setHint('Load a dominant timeline before recording extrapolation positions');
                return;
            }
            if (_draftObservations.length && frameTime.getTime() === _draftObservations[0].timeMs) {
                _setHint('Step to a different dominant frame, then click the tracked feature again');
                return;
            }
            _drawing = true;
            const coord = [e.lngLat.lng, e.lngLat.lat];
            _draftCoords.push(coord);
            _draftObservations.push({coord, timeMs: frameTime.getTime()});
            _updateDraftLayer();
            if (_draftObservations.length === 2) _finishExtrapolation();
            else _setHint(`First position: ${_formatUtc(frameTime)}\nStep frames, then click the new position`);
        } else if (tool === 'contour' || tool.startsWith('front-')) {
            _drawing = true;
            _draftCoords.push([e.lngLat.lng, e.lngLat.lat]);
            _updateDraftLayer();
        } else if (tool === 'county-alert') {
            _toggleCountyAtPoint(e.lngLat);
        // Handle single click of the  H/L/text
        } else if (tool === 'H' || tool === 'L') {
            _placeText(
                e.lngLat.lng, e.lngLat.lat, tool, tool,
                tool === 'H' ? '#4488ff' : '#ff4444', 22, _curPressure
            );
        } else if (tool === 'hurricane') {
            _placeText(e.lngLat.lng, e.lngLat.lat, 'hurricane', '🌀', '#ff55aa', 28);
        } else if (tool === 'gempak-symbol') {
            const symbol = _gempakSymbol(_curGempakSymbolId);
            if (symbol) _placeText(e.lngLat.lng, e.lngLat.lat, 'gempak', '', _curColor, _curWidth || 28, '', symbol.id);
        } else if (tool === 'text') {
            const txt = _panel.querySelector('#pg-text-content').value.trim() || 'Label';
            _placeText(e.lngLat.lng, e.lngLat.lat, 'text', txt, _curColor, _curWidth || 18);
        }
    }

    function _countyAlertColor(significance) {
        if (significance === 'Watch') return '#ffff00';
        if (significance === 'Advisory') return '#00bfff';
        return '#ff3333';
    }

    function _countyAlertName(product) {
        const number = product.alertNumber ? ` #${product.alertNumber}` : ` #${product.id}`;
        return `${product.hazard} ${product.significance}${number}`;
    }

    function _pointInRing(lng, lat, ring) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i];
            const [xj, yj] = ring[j];
            if (((yi > lat) !== (yj > lat)) &&
                (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    function _pointInCounty(lng, lat, feature) {
        const polygons = feature.geometry.type === 'Polygon'
            ? [feature.geometry.coordinates] : feature.geometry.coordinates;
        return polygons.some(polygon =>
            polygon.length && _pointInRing(lng, lat, polygon[0]) &&
            !polygon.slice(1).some(hole => _pointInRing(lng, lat, hole)));
    }

    function _countyGridKey(lng, lat) {
        return `${Math.floor((lng + 180) / COUNTY_GRID_DEGREES)}:${Math.floor((lat + 90) / COUNTY_GRID_DEGREES)}`;
    }

    function _findCountyAt(lng, lat) {
        const candidates = _countySpatialGrid.get(_countyGridKey(lng, lat)) || [];
        return candidates.find(({bbox, feature}) =>
            lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3] &&
            _pointInCounty(lng, lat, feature))?.feature || null;
    }

    function _toggleCountyAtPoint(lngLat) {
        const feature = _findCountyAt(lngLat.lng, lngLat.lat);
        if (!feature) return _setHint('County reference data are still loading, or no county was found here.');

        const county = {
            fips: String(feature.properties.FIPS).padStart(5, '0'),
            name: feature.properties.COUNTYNAME || feature.properties.NAME || 'Unknown County',
            state: feature.properties.STATE || '',
            cwa: feature.properties.CWA || '',
            geometry: feature.geometry,
        };

        if (_activeCountyProduct === null) {
            _saveUndo();
            _activeCountyProduct = {
                id: _nextId++, kind: 'county-alert', name: '', visible: true,
                significance: _curAlertSignificance, hazard: _curAlertHazard,
                alertNumber: _curAlertNumber,
                color: _countyAlertColor(_curAlertSignificance), counties: [],
            };
            _activeCountyProduct.name = _countyAlertName(_activeCountyProduct);
            _products.unshift(_activeCountyProduct);
        }

        const existing = _activeCountyProduct.counties.findIndex(item => item.fips === county.fips);
        if (existing >= 0) _activeCountyProduct.counties.splice(existing, 1);
        else _activeCountyProduct.counties.push(county);

        _updateCountyAlertLayers();
        _renderProductList();
        _setHint(`${_activeCountyProduct.counties.length} counties selected\nLeft-click toggles; right-click removes`);
    }

    // Handler for keeping track of the mouse position while drawing.
    function _onMapMouseMove(e) {
        if (_activeTool === 'county-alert') {
            _onCountyHover(e);
            return;
        }
        if (!_drawing) return;
        _mouseCoord = [e.lngLat.lng, e.lngLat.lat];
        _updateDraftLayer();
    }

    // Handler for when the user double-clicks on the map while drawing a contour or front. This finalizes the draft and creates the product.
    function _onMapDblClick(e) {
        if (!_drawing) return;
        e.preventDefault();
        if (_draftCoords.length > 1) _draftCoords.pop(); // remove ghost vertex from 2nd click

        // If the active tool is a contour or front, finish the draft and create the product
        if (_activeTool === 'contour') {
            _finishContour();
        } else if (_activeTool.startsWith('front-')) {
            _finishFront();
        }
    }

    // ------------------------------------------------------------------
    // Draft helpers
    // ------------------------------------------------------------------
    function _cancelDraft() {
        _drawing     = false;
        _draftCoords = [];
        _mouseCoord  = null;
        _draftObservations = [];
        _updateDraftLayer();
        if (_activeTool) {
            const isFront = _activeTool.startsWith('front-');
            if (_activeTool === 'contour' || isFront) {
                _setHint('Click to place vertices\nDbl-click to finish\nBackspace to undo\xa0\xa0Esc to cancel');
            }
        }
    }

    // ------------------------------------------------------------------
    // Product creation and finishing
    // ------------------------------------------------------------------

    // Finishing a contour: close the polygon, save it to the products list, and reset the draft state.

    // BUG: If a contour is a probability contour, we should make sure that it does not overlap with other probability contours for the same event type.  If they do, we should warn the user and ask if they want to continue.
    function _finishContour() {
        if (_draftCoords.length < 3) { _cancelDraft(); return; }
        _saveUndo();
        const closed = [..._draftCoords, _draftCoords[0]];
        const forecastContext = _configuredContourContext();
        const p = {
            id:    _nextId++,
            kind:  'contour',
            type:  _curType,
            name:  '',
            visible: true,
            coords: closed,
            color: _curColor,
            width: _curWidth,
            fillPattern: _curPattern,
            patternDensity: _curPatternDensity,
            patternWidth: _curPatternWidth,
            label: forecastContext?.level.label || '',
            suiteId: forecastContext?.suite.id || null,
            suiteVersion: forecastContext?.suite.version || null,
            forecastProductId: forecastContext?.product.id || null,
            forecastProductLabel: forecastContext?.product.label || null,
            levelId: forecastContext?.level.id || null,
            levelLabel: forecastContext?.level.label || null,
            value: forecastContext?.level.value ?? null,
            units: forecastContext?.product.units || null,
            forecastRole: forecastContext?.level.role || 'level',
        };
        p.name = forecastContext
            ? `${forecastContext.product.label} — ${forecastContext.level.label}`
            : `${p.type} #${p.id}`;
        _products.unshift(p);
        PG.info(`Contour created → id=${p.id} "${p.name}" vertices=${_draftCoords.length} | total: ${_products.length}`);
        _drawing = false; _draftCoords = []; _mouseCoord = null;
        _updateDraftLayer();
        _updateContourLayer();
        _renderProductList();
        _setHint('Click to place vertices\nDbl-click to finish\nBackspace to undo\xa0\xa0Esc to cancel');
    }

    // Finishing a front: save the open polyline to the products list, and reset the draft state.
    // Maybe later we can add a check to make sure that the front is not self-intersecting, but for now we will just let the user create any shape they want.
    function _finishFront() {
        if (_draftCoords.length < 2) { _cancelDraft(); return; }
        _saveUndo();
        const frontType = _activeTool.replace('front-', '');
        const cfg = FRONT_CFG[frontType] || {};
        const p = {
            id:        _nextId++,
            kind:      'front',
            frontType,
            name:      '',
            visible:   true,
            coords:    [..._draftCoords],
            color:     cfg.color || _curColor,
            width:     _curWidth,
            pipSide:   'right',
            label:     frontType === 'isochrone'
                ? (_panel.querySelector('#pg-text-content').value.trim() || 'T+1h')
                : frontType === 'vector' ? _panel.querySelector('#pg-text-content').value.trim() : '',
        };
        p.name = frontType === 'isochrone'
            ? `${cfg.label} — ${p.label} #${p.id}`
            : `${cfg.label || `${frontType.charAt(0).toUpperCase() + frontType.slice(1)} Front`} #${p.id}`;
        _products.unshift(p);
        PG.info(`Front created → id=${p.id} "${p.name}" type=${frontType} vertices=${p.coords.length} | total: ${_products.length}`);
        _drawing = false; _draftCoords = []; _mouseCoord = null;
        _updateDraftLayer();
        _updateFrontLayer();
        _renderProductList();
        _setHint('Click to place vertices\nDbl-click to finish\nBackspace to undo\xa0\xa0Esc to cancel');
    }

    const EARTH_RADIUS_KM = 6371.0088;
    const KM_PER_NAUTICAL_MILE = 1.852;
    const _radians = degrees => degrees * Math.PI / 180;
    const _degrees = radians => radians * 180 / Math.PI;

    function _geodesicMotion(from, to) {
        const lat1 = _radians(from[1]);
        const lat2 = _radians(to[1]);
        const deltaLat = lat2 - lat1;
        const deltaLng = _radians(to[0] - from[0]);
        const a = Math.sin(deltaLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
        const distanceKm = EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const y = Math.sin(deltaLng) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
        const bearing = (_degrees(Math.atan2(y, x)) + 360) % 360;
        return {distanceKm, distanceNm: distanceKm / KM_PER_NAUTICAL_MILE, bearing};
    }

    function _destinationPoint(origin, bearingDegrees, distanceKm) {
        const angular = distanceKm / EARTH_RADIUS_KM;
        const bearing = _radians(bearingDegrees);
        const lat1 = _radians(origin[1]);
        const lng1 = _radians(origin[0]);
        const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) +
            Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
        const lng2 = lng1 + Math.atan2(
            Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
            Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
        return [((_degrees(lng2) + 540) % 360) - 180, _degrees(lat2)];
    }

    function _formatUtc(value) {
        const date = value instanceof Date ? value : new Date(value);
        return Number.isFinite(date.getTime())
            ? date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown time';
    }

    function _finishDistance() {
        if (_draftCoords.length !== 2) return;
        _saveUndo();
        const motion = _geodesicMotion(_draftCoords[0], _draftCoords[1]);
        const p = {
            id: _nextId++, kind: 'measurement', measureType: 'distance', name: '', visible: true,
            coords: _draftCoords.map(coord => [...coord]), color: _curColor, width: _curWidth,
            distanceKm: motion.distanceKm, distanceNm: motion.distanceNm, bearing: motion.bearing,
        };
        p.name = `Distance ${motion.distanceNm.toFixed(1)} nmi · ${Math.round(motion.bearing).toString().padStart(3, '0')}°`;
        _products.unshift(p);
        _drawing = false; _draftCoords = []; _draftObservations = []; _mouseCoord = null;
        _updateDraftLayer(); _updateGuideLayer(); _renderProductList();
        _setHint('Click the start and end points to measure distance and bearing');
    }

    function _finishExtrapolation() {
        if (_draftObservations.length !== 2) return;
        const [first, second] = _draftObservations;
        const elapsedHours = (second.timeMs - first.timeMs) / 3_600_000;
        if (!(elapsedHours > 0)) {
            _draftObservations.pop();
            _draftCoords.pop();
            _updateDraftLayer();
            _setHint('The second observation must be on a later dominant frame');
            return;
        }
        _saveUndo();
        const motion = _geodesicMotion(first.coord, second.coord);
        const speedKt = motion.distanceNm / elapsedHours;
        const projected = Array.from({length: _curExtrapSteps}, (_, index) => {
            const minutes = (index + 1) * _curExtrapInterval;
            return {
                coord: _destinationPoint(second.coord, motion.bearing,
                    speedKt * (minutes / 60) * KM_PER_NAUTICAL_MILE),
                minutes, timeMs: second.timeMs + minutes * 60_000,
            };
        });
        const p = {
            id: _nextId++, kind: 'measurement', measureType: 'extrapolation', name: '', visible: true,
            coords: [first.coord, second.coord], observations: [first, second], projected,
            intervalMinutes: _curExtrapInterval, steps: _curExtrapSteps,
            distanceKm: motion.distanceKm, distanceNm: motion.distanceNm,
            bearing: motion.bearing, speedKt, elapsedMinutes: elapsedHours * 60,
            color: _curColor, width: _curWidth,
        };
        p.name = `Motion ${speedKt.toFixed(1)} kt · ${Math.round(motion.bearing).toString().padStart(3, '0')}°`;
        _products.unshift(p);
        _drawing = false; _draftCoords = []; _draftObservations = []; _mouseCoord = null;
        _updateDraftLayer(); _updateGuideLayer(); _renderProductList();
        _setHint('Click a feature on one frame, step forward, then click its new position');
    }

    // Place a text product (H, L, or free text) at the given coordinates with the specified color and font size. This is called when the user clicks on the map while the H/L/text tool is active.
    function _normalizedPressure(value) {
        if (value === '' || value == null) return '';
        const pressure = Number(value);
        if (!Number.isFinite(pressure)) return '';
        return Math.max(850, Math.min(1100, Math.round(pressure))).toString();
    }

    function _placeText(lng, lat, kind, text, color, fontSize, pressure = '', symbolId = '') {
        _saveUndo();
        const p = {
            id:       _nextId++,
            kind:     'text',
            subKind:  kind,
            name:     `${kind === 'H' || kind === 'L' ? kind + ' center' : kind === 'hurricane' ? 'Hurricane center' : kind === 'gempak' ? (_gempakSymbol(symbolId)?.label || 'NAWIPS symbol') : 'Text'} #${_nextId - 1}`,
            visible:  true,
            lng, lat,
            text,
            color,
            fontSize: fontSize || 18,
            pressure: kind === 'H' || kind === 'L' ? _normalizedPressure(pressure) : '',
            symbolId: kind === 'gempak' ? symbolId : '',
            boxed: kind === 'text' && _curTextBoxed,
            backgroundColor: kind === 'text' ? _curTextBackground : '',
        };
        _products.unshift(p);
        PG.info(`Text placed → id=${p.id} text="${text}" at [${lng.toFixed(3)}, ${lat.toFixed(3)}] | total: ${_products.length}`);
        _updateSymbolLayer();
        _renderProductList();
    }

    // --------------------------------------------------------------------------------------------------------
    // Enter the edit mode for the given product. This will allow the user to drag vertices, add new vertices, and delete vertices. The product's coordinates are copied to a separate array for editing, and the original product is not modified until the user exits edit mode.
    // --------------------------------------------------------------------------------------------------------
    function _enterEditMode(product) {
        _exitEditMode();
        _editProduct = product;
        const isOpen = product.kind === 'front';  // fronts are open polylines, contours are closed
        const raw = product.coords || [];
        // Deep copy for editing; do NOT update product.coords during edit
        if (isOpen) {
            _editCoords = raw.map(c => [...c]);
        } else {
            const isClosed = raw.length > 1 &&
                raw[0][0] === raw[raw.length - 1][0] &&
                raw[0][1] === raw[raw.length - 1][1];
            _editCoords = (isClosed ? raw.slice(0, -1) : raw).map(c => [...c]);
        }
        PG.info(`Edit mode entered → id=${product.id} kind=${product.kind} name="${product.name}" vertices=${_editCoords.length}`);
        // Sync style controls to this product
        if (product.kind !== 'text') {
            _panel.querySelector('#pg-color').value = product.color;
            _panel.querySelector('#pg-width').value = product.width;
            _curColor = product.color;
            _curWidth = product.width;
        }
        if (product.kind === 'contour') {
            _panel.querySelector('#pg-type').value = product.type || 'General';
            _curType = product.type || 'General';
            _curPattern = product.fillPattern || 'solid';
            _curPatternDensity = product.patternDensity || 3;
            _curPatternWidth = product.patternWidth || 1.5;
            _panel.querySelector('#pg-pattern').value = _curPattern;
            _panel.querySelector('#pg-pattern-density').value = _curPatternDensity;
            _panel.querySelector('#pg-pattern-width').value = _curPatternWidth;
        }
        if (product.kind === 'text') {
            _panel.querySelector('#pg-text-content').value = product.text || '';
            _curText = product.text || '';
            _curFontSize = product.fontSize || 18;
            _panel.querySelector('#pg-color').value = product.color;
            _curColor = product.color;
            _panel.querySelector('#pg-width').value = product.fontSize || 18;
            _curPressure = _normalizedPressure(product.pressure);
            _panel.querySelector('#pg-pressure-value').value = _curPressure;
            _curTextBoxed = Boolean(product.boxed);
            _curTextBackground = product.backgroundColor || '#101020';
            _panel.querySelector('#pg-text-boxed').checked = _curTextBoxed;
            _panel.querySelector('#pg-text-background').value = _curTextBackground;
        } else if (product.kind === 'front' &&
            (product.frontType === 'isochrone' || product.frontType === 'vector')) {
            _curText = product.label || (product.frontType === 'isochrone' ? 'T+1h' : '');
            _panel.querySelector('#pg-text-content').value = _curText;
        }
        _updateStylePanel();
        if (product.kind === 'text') {
            _renderProductList();
            _setHint(product.subKind === 'H' || product.subKind === 'L'
                ? 'Drag the symbol to relocate it\nEdit the optional pressure value below'
                : 'Drag the annotation to relocate it\nEdit text and style below');
            [LYR_SYMBOL, LYR_BOXED_TEXT, LYR_PRESSURE_LABEL, LYR_HURRICANE_SYMBOL, LYR_GEMPAK_SYMBOL]
                .forEach(layerId => {
                    _map.on('mousedown', layerId, _onEditTextMouseDown);
                    _map.on('mouseenter', layerId, _onEditTextEnter);
                    _map.on('mouseleave', layerId, _onEditTextLeave);
                });
            _map.on('mousemove', _onEditTextDrag);
            _map.on('mouseup', _onEditTextMouseUp);
            return;
        }
        _map.doubleClickZoom.disable();
        _updateEditLayer();
        _renderProductList();
        _setHint('Drag vertex to move\nClick \u2295 midpoint to add vertex\nRight-click or Alt-click vertex to delete\nEsc to finish');
        _map.on('mousedown',   LYR_EDIT_HIT, _onEditVertMouseDown);
        _map.on('click',       LYR_EDIT_HIT, _onEditVertClick);
        _map.on('mouseenter',  LYR_EDIT_HIT, _onEditVertEnter);
        _map.on('mouseleave',  LYR_EDIT_HIT, _onEditVertLeave);
        _map.on('contextmenu', LYR_EDIT_HIT, _onEditVertContextMenu);
        _map.on('click',       LYR_EDIT_MID,   _onEditMidClick);
        _map.on('mouseenter',  LYR_EDIT_MID,   _onEditMidEnter);
        _map.on('mouseleave',  LYR_EDIT_MID,   _onEditMidLeave);
        // Keep these listeners for the whole edit session. Re-registering
        // them after each drag was unreliable while the edit GeoJSON source
        // was also being replaced on every pointer move.
        _map.on('mousemove', _onEditVertDrag);
        _map.on('mouseup',   _onEditVertMouseUp);
    }

    // ------------------------------------------------------------------
    // Exit the edit mode
    // ------------------------------------------------------------------
    function _exitEditMode() {
        if (!_editProduct) return;
        PG.debug(`Edit mode exited → id=${_editProduct.id} name="${_editProduct.name}"`);
        // Commit edits back to product
        if (_editProduct.kind === 'front') {
            _editProduct.coords = [..._editCoords];
        } else if (_editProduct.kind === 'contour') {
            _editProduct.coords = [..._editCoords, _editCoords[0]];
        }
        _map.off('mousedown',  LYR_EDIT_HIT, _onEditVertMouseDown);
        _map.off('click',      LYR_EDIT_HIT, _onEditVertClick);
        _map.off('mouseenter', LYR_EDIT_HIT, _onEditVertEnter);
        _map.off('mouseleave', LYR_EDIT_HIT, _onEditVertLeave);
        _map.off('contextmenu',LYR_EDIT_HIT, _onEditVertContextMenu);
        _map.off('click',      LYR_EDIT_MID,   _onEditMidClick);
        _map.off('mouseenter', LYR_EDIT_MID,   _onEditMidEnter);
        _map.off('mouseleave', LYR_EDIT_MID,   _onEditMidLeave);
        _map.off('mousemove',  _onEditVertDrag);
        _map.off('mouseup',    _onEditVertMouseUp);
        [LYR_SYMBOL, LYR_BOXED_TEXT, LYR_PRESSURE_LABEL, LYR_HURRICANE_SYMBOL, LYR_GEMPAK_SYMBOL]
            .forEach(layerId => {
                _map.off('mousedown', layerId, _onEditTextMouseDown);
                _map.off('mouseenter', layerId, _onEditTextEnter);
                _map.off('mouseleave', layerId, _onEditTextLeave);
            });
        _map.off('mousemove', _onEditTextDrag);
        _map.off('mouseup', _onEditTextMouseUp);
        _draggingText = false;
        _map.dragPan.enable();
        _map.doubleClickZoom.enable();
        _map.getCanvas().style.cursor = '';
        _editProduct = null;
        _editCoords  = [];
        _dragVertIdx = -1;
        _overEditVertex = false;
        if (_map.getSource(SRC_EDIT))     _map.getSource(SRC_EDIT).setData(_emptyFC());
        if (_map.getSource(SRC_EDIT_MID)) _map.getSource(SRC_EDIT_MID).setData(_emptyFC());
        _updateStylePanel();
        _renderProductList();
        _setHint('');
    }

    function _eventTargetsEditedText(e) {
        return _editProduct?.kind === 'text' && e.features?.some(feature =>
            String(feature.properties?.id) === String(_editProduct.id));
    }

    function _onEditTextMouseDown(e) {
        if (_draggingText || e.originalEvent?.button !== 0 || !_eventTargetsEditedText(e)) return;
        e.preventDefault();
        _saveUndo();
        _draggingText = true;
        _map.dragPan.disable();
        _map.getCanvas().style.cursor = 'grabbing';
    }

    function _onEditTextDrag(e) {
        if (!_draggingText || _editProduct?.kind !== 'text') return;
        _editProduct.lng = e.lngLat.lng;
        _editProduct.lat = e.lngLat.lat;
        _updateSymbolLayer();
    }

    function _onEditTextMouseUp() {
        if (!_draggingText) return;
        _draggingText = false;
        _map.dragPan.enable();
        _map.getCanvas().style.cursor = 'move';
        _renderProductList();
    }

    function _onEditTextEnter(e) {
        if (!_draggingText && _eventTargetsEditedText(e)) _map.getCanvas().style.cursor = 'move';
    }

    function _onEditTextLeave() {
        if (!_draggingText) _map.getCanvas().style.cursor = '';
    }

    // ------------------------------------------------------------------
    // Update the edit layer with the current coordinates of the product being edited. 
    // This includes the main line/polygon and the vertex circles, as well as the midpoints for adding new vertices.
    // ------------------------------------------------------------------
    function _updateEditLayer() {
        if (!_map || !_map.getSource(SRC_EDIT) || !_editProduct) return;
        const isOpen = _editProduct.kind === 'front';
        const n = _editCoords.length;

        // ── Main edit features (line skeleton + vertex circles) ────────
        const features = [];
        if (n >= 2) {
            const lineCoords = isOpen ? [..._editCoords] : [..._editCoords, _editCoords[0]];
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: lineCoords },
                properties: {},
            });
        }
        _editCoords.forEach((c, i) => features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: c },
            properties: { vertIdx: i },
        }));
        _map.getSource(SRC_EDIT).setData({ type: 'FeatureCollection', features });

        // ── Midpoint insert handles ────────────────────────────────────
        if (!_map.getSource(SRC_EDIT_MID)) return;
        const midFeatures = [];
        const numEdges = isOpen ? n - 1 : n;
        for (let i = 0; i < numEdges; i++) {
            const j = (i + 1) % n;
            midFeatures.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [
                    (_editCoords[i][0] + _editCoords[j][0]) / 2,
                    (_editCoords[i][1] + _editCoords[j][1]) / 2,
                ]},
                properties: { midAfterIdx: i },
            });
        }
        _map.getSource(SRC_EDIT_MID).setData({ type: 'FeatureCollection', features: midFeatures });
    }

    // ------------------------------------------------------------------
    // Clicking and dragging vertices to move them, or right-clicking to delete them,
    //  or clicking midpoints to add new vertices.
    // ------------------------------------------------------------------

    function _onEditVertMouseDown(e) {
        if (!_editProduct || !e.features?.length || e.originalEvent?.button !== 0) return;
        e.preventDefault();
        _dragVertIdx = Number(e.features[0].properties.vertIdx);
        if (!Number.isInteger(_dragVertIdx)) {
            _dragVertIdx = -1;
            return;
        }
        _map.getCanvas().style.cursor = 'grabbing';
        _map.dragPan.disable();
    }

    function _onEditVertDrag(e) {
        if (_dragVertIdx < 0 || !_editProduct) return;
        _editCoords[_dragVertIdx] = [e.lngLat.lng, e.lngLat.lat];
        const isOpen = _editProduct.kind === 'front';
        _editProduct.coords = isOpen
            ? [..._editCoords]
            : [..._editCoords, _editCoords[0]];
        _updateEditLayer();
        if (_editProduct.kind === 'contour')     _updateContourLayer();
        else if (_editProduct.kind === 'front')  _updateFrontLayer();
    }

    function _onEditVertMouseUp() {
        if (_dragVertIdx < 0) return;
        const validateContour = _editProduct?.kind === 'contour';
        _dragVertIdx = -1;
        _map.dragPan.enable();
        _map.getCanvas().style.cursor = _overEditVertex ? 'move' : '';
        if (validateContour) _renderProductList();
    }

    function _removeEditVertex(index) {
        if (!_editProduct || !Number.isInteger(index)) return false;
        const minVerts = _editProduct.kind === 'front' ? 2 : 3;
        if (_editCoords.length <= minVerts || index < 0 || index >= _editCoords.length) {
            _setHint(`${_editProduct.kind === 'front' ? 'Fronts' : 'Contours'} require at least ${minVerts} vertices`);
            return false;
        }
        _editCoords.splice(index, 1);
        const isOpen = _editProduct.kind === 'front';
        _editProduct.coords = isOpen ? [..._editCoords] : [..._editCoords, _editCoords[0]];
        _updateEditLayer();
        if (_editProduct.kind === 'contour')    _updateContourLayer();
        else if (_editProduct.kind === 'front') _updateFrontLayer();
        if (_editProduct.kind === 'contour') _renderProductList();
        _setHint('Drag vertex to move\nClick \u2295 midpoint to add vertex\nRight-click or Alt-click vertex to delete\nEsc to finish');
        return true;
    }

    function _onEditVertClick(e) {
        if (!e.originalEvent?.altKey || !e.features?.length) return;
        e.preventDefault();
        _removeEditVertex(Number(e.features[0].properties.vertIdx));
    }

    function _onEditVertContextMenu(e) {
        if (!_editProduct || !e.features?.length) return;
        e.preventDefault();
        e.originalEvent?.preventDefault();  // suppress browser native context menu
        _removeEditVertex(Number(e.features[0].properties.vertIdx));
    }

    function _onEditMidClick(e) {
        if (!_editProduct) return;
        e.preventDefault();
        const afterIdx = e.features[0].properties.midAfterIdx;
        const isOpen   = _editProduct.kind === 'front';
        const n        = _editCoords.length;
        const j        = (afterIdx + 1) % n;
        const newCoord = [
            (_editCoords[afterIdx][0] + _editCoords[j][0]) / 2,
            (_editCoords[afterIdx][1] + _editCoords[j][1]) / 2,
        ];
        _editCoords.splice(afterIdx + 1, 0, newCoord);
        _editProduct.coords = isOpen ? [..._editCoords] : [..._editCoords, _editCoords[0]];
        _updateEditLayer();
        if (_editProduct.kind === 'contour')    _updateContourLayer();
        else if (_editProduct.kind === 'front') _updateFrontLayer();

        // Immediately start dragging the new vertex
        _dragVertIdx = afterIdx + 1;
        _map.getCanvas().style.cursor = 'grabbing';
        _map.dragPan.disable();
    }

    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Front pip geometry generation
    // ------------------------------------------------------------------

    // Chaikin corner cutting gives hand-drawn fronts a stable, rounded path
    // without spline overshoot. Keep the original vertices on the product so
    // edit handles and exported user input remain unchanged.
    function _smoothFront(coords, passes = FRONT_SMOOTHING_PASSES) {
        if (!coords || coords.length < 3) return coords || [];
        let result = coords.map(coord => [...coord]);
        for (let pass = 0; pass < passes; pass++) {
            const smoothed = [result[0]];
            for (let i = 0; i < result.length - 1; i++) {
                const a = result[i];
                const b = result[i + 1];
                smoothed.push(
                    [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]],
                    [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]],
                );
            }
            smoothed.push(result[result.length - 1]);
            result = smoothed;
        }
        return result;
    }

    // Geographic pip geometry is regenerated by zoom band. This keeps fronts
    // legible at regional scale without making close-up symbols oversized.
    function _frontGeometryScale() {
        const zoom = _map?.getZoom?.() ?? 5;
        // Web Mercator ground resolution changes by 2× per zoom level. Scale
        // geographic geometry by the inverse amount so pip dimensions and
        // gaps remain approximately stable in screen pixels.
        const quantizedZoom = Math.round(zoom * 2) / 2;
        // Outward zoom needs full compensation to keep neighboring symbols
        // separated. Inward zoom uses a gentler half-rate so fronts remain
        // comfortably readable instead of becoming tiny at street scale.
        const exponent = quantizedZoom <= 5
            ? 5 - quantizedZoom
            : (5 - quantizedZoom) * 0.5;
        return Math.max(0.2, Math.min(8, 2 ** exponent));
    }

    // ITCZ is a continuous band rather than discrete front pips. Fully
    // compensate for map zoom so its band width and cross-link cadence remain
    // stable in screen space at both regional and close-up scales.
    function _itczGeometryScale() {
        const zoom = _map?.getZoom?.() ?? 5;
        const quantizedZoom = Math.round(zoom * 2) / 2;
        return Math.max(0.015625, Math.min(16, 2 ** (5 - quantizedZoom)));
    }

    // Walk a polyline and collect pip positions with local coordinate frames
    function _pipPositions(coords, side, spacingKm = PIP_SPACING_KM, kmPerDegree = 400.3) {
        const pips = [];
        let distSinceLast = spacingKm * 0.4;  // offset first pip from very start
        for (let i = 0; i < coords.length - 1; i++) {
            const [lng0, lat0] = coords[i];
            const [lng1, lat1] = coords[i + 1];
            const midLat = (lat0 + lat1) / 2;
            const cosLat = Math.cos(midLat * Math.PI / 180);
            const dxKm = (lng1 - lng0) * kmPerDegree * cosLat;
            const dyKm = (lat1 - lat0) * kmPerDegree;
            const segLen = Math.sqrt(dxKm * dxKm + dyKm * dyKm);
            if (segLen < 1) continue;
            // Unit tangent in km space
            const txKm = dxKm / segLen;
            const tyKm = dyKm / segLen;
            // Right-hand normal (90° CW: (ty, -tx))
            const rnx =  tyKm,  rny = -txKm;
            const nxKm = side === 'right' ? rnx : -rnx;
            const nyKm = side === 'right' ? rny : -rny;
            let t = distSinceLast;
            while (t <= segLen) {
                pips.push({
                    lng:   lng0 + (t * txKm) / (kmPerDegree * cosLat),
                    lat:   lat0 + (t * tyKm) / kmPerDegree,
                    txKm, tyKm, nxKm, nyKm, cosLat,
                });
                t += spacingKm;
            }
            distSinceLast = t - segLen;
        }
        return pips;
    }

    // Convert a km-space offset (relative to pip centre) to [lng, lat]
    function _toCoord(lng, lat, cosLat, dxKm, dyKm) {
        return [lng + dxKm / (400.3 * cosLat), lat + dyKm / 400.3];
    }

    function _toItczCoord(lng, lat, cosLat, dxKm, dyKm) {
        return [lng + dxKm / (KM_PER_DEGREE_LAT * cosLat), lat + dyKm / KM_PER_DEGREE_LAT];
    }

    function _makeTriangle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat, scale = 1) {
        const h = PIP_COLD_HT_KM * scale, b = PIP_COLD_BASE_KM * scale;
        const p1 = _toCoord(lng, lat, cosLat, -b * txKm, -b * tyKm);   // base-left
        const p2 = _toCoord(lng, lat, cosLat,  b * txKm,  b * tyKm);   // base-right
        const p3 = _toCoord(lng, lat, cosLat,  h * nxKm,  h * nyKm);   // apex
        return [p1, p2, p3, p1];
    }

    function _makeSemicircle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat, radiusKm = PIP_WARM_R_KM, close = true) {
        const r = radiusKm;
        const N = 8;  // arc segments
        const pts = [];
        for (let i = 0; i <= N; i++) {
            const a    = (i / N) * Math.PI;
            const cosA = Math.cos(a), sinA = Math.sin(a);
            // angle=0 → -tangent (base-left), π/2 → normal (apex), π → +tangent (base-right)
            pts.push(_toCoord(lng, lat, cosLat,
                r * (-cosA * txKm + sinA * nxKm),
                r * (-cosA * tyKm + sinA * nyKm)));
        }
        if (close) pts.push(pts[0]);
        return pts;
    }

    function _offsetFrontPolyline(coords, offsetKm) {
        return coords.map((coord, index) => {
            const previous = coords[Math.max(0, index - 1)];
            const following = coords[Math.min(coords.length - 1, index + 1)];
            const midLat = (previous[1] + following[1]) / 2;
            const cosLat = Math.max(0.01, Math.cos(midLat * Math.PI / 180));
            const dx = (following[0] - previous[0]) * KM_PER_DEGREE_LAT * cosLat;
            const dy = (following[1] - previous[1]) * KM_PER_DEGREE_LAT;
            const length = Math.hypot(dx, dy) || 1;
            const nx = dy / length;
            const ny = -dx / length;
            return _toItczCoord(coord[0], coord[1], cosLat, offsetKm * nx, offsetKm * ny);
        });
    }

    // Build the complete set of GeoJSON features for one front product
    function _generateFrontFeatures(p) {
        const cfg = FRONT_CFG[p.frontType] || {};
        const color = cfg.color || p.color;
        const feats = [];
        const frontCoords = _smoothFront(p.coords);
        const geometryScale = _frontGeometryScale();

        if (cfg.pipMode === 'ridge') {
            const teeth = _pipPositions(frontCoords, 'right', RIDGE_ZIG_SPACING_KM * geometryScale);
            const coordinates = [frontCoords[0]];
            teeth.forEach((position, index) => {
                const direction = index % 2 === 0 ? 1 : -1;
                coordinates.push(_toCoord(
                    position.lng, position.lat, position.cosLat,
                    direction * RIDGE_ZIG_AMPLITUDE_KM * geometryScale * position.nxKm,
                    direction * RIDGE_ZIG_AMPLITUDE_KM * geometryScale * position.nyKm,
                ));
            });
            coordinates.push(frontCoords[frontCoords.length - 1]);
            return [{
                type: 'Feature',
                geometry: {type: 'LineString', coordinates},
                properties: {id: p.id, prodKind: 'front-line', color, width: p.width || 2.5},
            }];
        }

        if (cfg.pipMode === 'itcz') {
            const itczScale = _itczGeometryScale();
            const halfWidth = ITCZ_HALF_WIDTH_KM * itczScale;
            const lineProperties = {
                id: p.id, prodKind: 'front-itcz-line', color,
                width: p.width || 2.5, frontType: p.frontType,
            };
            feats.push(
                {
                    type: 'Feature',
                    geometry: {type: 'LineString', coordinates: _offsetFrontPolyline(frontCoords, halfWidth)},
                    properties: lineProperties,
                },
                {
                    type: 'Feature',
                    geometry: {type: 'LineString', coordinates: _offsetFrontPolyline(frontCoords, -halfWidth)},
                    properties: lineProperties,
                },
            );
            _pipPositions(frontCoords, 'right', ITCZ_HATCH_SPACING_KM * itczScale, KM_PER_DEGREE_LAT)
                .forEach(({lng, lat, txKm, tyKm, nxKm, nyKm, cosLat}) => {
                    const skew = ITCZ_HATCH_SKEW_KM * itczScale;
                    feats.push({
                        type: 'Feature',
                        geometry: {type: 'LineString', coordinates: [
                            _toItczCoord(lng, lat, cosLat,
                                -halfWidth * nxKm - skew * txKm,
                                -halfWidth * nyKm - skew * tyKm),
                            _toItczCoord(lng, lat, cosLat,
                                halfWidth * nxKm + skew * txKm,
                                halfWidth * nyKm + skew * tyKm),
                        ]},
                        properties: {
                            ...lineProperties, prodKind: 'front-itcz-link',
                            width: Math.max(2, (p.width || 2.5) * 0.9),
                        },
                    });
                });
            return feats;
        }

        // The squall motif itself is the line. Drawing the ordinary backbone
        // as well produces an incorrect parallel/double-line appearance.
        if (cfg.pipMode !== 'squall') {
            feats.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: frontCoords },
                properties: {
                    id: p.id,
                    prodKind: p.frontType === 'trough' || p.frontType === 'isochrone'
                        ? 'front-dashed-line' : 'front-line',
                    color,
                    width: p.width || 2,
                    frontType: p.frontType,
                    label: p.label || '',
                },
            });
        }

        if (cfg.pipMode === 'isochrone') {
            const endpoint = frontCoords[frontCoords.length - 1];
            feats.push({
                type: 'Feature', geometry: {type: 'Point', coordinates: endpoint},
                properties: {
                    id: p.id, prodKind: 'isochrone-label', frontType: p.frontType,
                    label: p.label || 'T+1h', color, boxImage: _ensureTextBoxImage('#101020'),
                },
            });
            return feats;
        }

        if (cfg.pipMode === 'none' || !p.coords || p.coords.length < 2) return feats;

        if (cfg.pipMode === 'vector') {
            const tip = frontCoords[frontCoords.length - 1];
            const previous = frontCoords[frontCoords.length - 2];
            const midLat = (tip[1] + previous[1]) / 2;
            const cosLat = Math.max(0.01, Math.cos(midLat * Math.PI / 180));
            const dx = (tip[0] - previous[0]) * 400.3 * cosLat;
            const dy = (tip[1] - previous[1]) * 400.3;
            const length = Math.hypot(dx, dy);
            if (length > 0) {
                const tx = dx / length;
                const ty = dy / length;
                const nx = -ty;
                const ny = tx;
                const widthScale = Math.max(0.6, (p.width || 2.5) / 2.5);
                const arrowLength = VECTOR_ARROW_LENGTH_KM * geometryScale * widthScale;
                const halfWidth = arrowLength * 0.48;
                feats.push({
                    type: 'Feature',
                    geometry: {type: 'LineString', coordinates: [
                        _toCoord(tip[0], tip[1], cosLat, -arrowLength * tx + halfWidth * nx, -arrowLength * ty + halfWidth * ny),
                        tip,
                        _toCoord(tip[0], tip[1], cosLat, -arrowLength * tx - halfWidth * nx, -arrowLength * ty - halfWidth * ny),
                    ]},
                    properties: {id: p.id, prodKind: 'front-decoration-line', color, width: p.width || 2.5},
                });
            }
            if (p.label) {
                const labelCoord = frontCoords[Math.floor((frontCoords.length - 1) / 2)];
                feats.push({
                    type: 'Feature', geometry: {type: 'Point', coordinates: labelCoord},
                    properties: {
                        id: p.id, prodKind: 'vector-label', frontType: p.frontType,
                        label: p.label, color, boxImage: _ensureTextBoxImage('#101020'),
                    },
                });
            }
            return feats;
        }

        const side  = p.pipSide || 'right';

        if (cfg.pipMode === 'dry') {
            _pipPositions(frontCoords, side, PIP_DRY_SPACING_KM * geometryScale).forEach(({ lng, lat, txKm, tyKm, nxKm, nyKm, cosLat }) => {
                feats.push({
                    type: 'Feature',
                    geometry: {type: 'LineString', coordinates: _makeSemicircle(
                        lng, lat, txKm, tyKm, nxKm, nyKm, cosLat, PIP_DRY_R_KM * geometryScale, false,
                    )},
                    properties: {id: p.id, prodKind: 'front-pip-outline', color},
                });
            });
            return feats;
        }

        if (cfg.pipMode === 'squall') {
            _pipPositions(frontCoords, side, SQUALL_PATTERN_UNIT_KM * geometryScale).forEach((position, index) => {
                const {lng, lat, txKm, tyKm, nxKm, nyKm, cosLat} = position;
                const center = [lng, lat];
                const patternIndex = index % 48;
                if (patternIndex === 0) {
                    feats.push({
                        type: 'Feature',
                        geometry: {type: 'LineString', coordinates: [
                            _toCoord(center[0], center[1], cosLat, -SQUALL_DASH_HALF_KM * geometryScale * txKm, -SQUALL_DASH_HALF_KM * geometryScale * tyKm),
                            _toCoord(center[0], center[1], cosLat, SQUALL_DASH_HALF_KM * geometryScale * txKm, SQUALL_DASH_HALF_KM * geometryScale * tyKm),
                        ]},
                        properties: {id: p.id, prodKind: 'front-decoration-line', color},
                    });
                } else if (patternIndex === 19 || patternIndex === 29) {
                    feats.push({
                        type: 'Feature', geometry: {type: 'Point', coordinates: center},
                        properties: {id: p.id, prodKind: 'front-decoration-dot', color},
                    });
                }
            });
            return feats;
        }

        if (cfg.pipMode === 'streamline') {
            _pipPositions(frontCoords, 'right', STREAMLINE_ARROW_SPACING_KM * geometryScale)
                .forEach(({lng, lat, txKm, tyKm, nxKm, nyKm, cosLat}) => {
                    const widthScale = Math.max(0.6, (p.width || 2.5) / 2.5);
                    const length = STREAMLINE_ARROW_LENGTH_KM * geometryScale * widthScale;
                    const halfWidth = length * 0.46;
                    const tip = [lng, lat];
                    const backX = -length * txKm;
                    const backY = -length * tyKm;
                    feats.push({
                        type: 'Feature',
                        geometry: {type: 'LineString', coordinates: [
                            _toCoord(lng, lat, cosLat, backX + halfWidth * nxKm, backY + halfWidth * nyKm),
                            tip,
                            _toCoord(lng, lat, cosLat, backX - halfWidth * nxKm, backY - halfWidth * nyKm),
                        ]},
                        properties: {
                            id: p.id, prodKind: 'front-decoration-line', color,
                            width: p.width || 2.5,
                        },
                    });
                });
            return feats;
        }

        // Stationary and occluded fronts use one shared placement sequence.
        // Stationary symbols alternate sides and colors; occluded symbols
        // alternate shapes on the same side and remain purple.
        if (cfg.pipMode === 'stat' || cfg.pipMode === 'occ') {
            const isOccluded = cfg.pipMode === 'occ';
            _pipPositions(frontCoords, side, PIP_SPACING_KM * geometryScale).forEach((position, index) => {
                const { lng, lat, txKm, tyKm, nxKm, nyKm, cosLat } = position;
                const isCold = index % 2 === 0;
                const ring = isCold
                    ? _makeTriangle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat, geometryScale)
                    : _makeSemicircle(lng, lat, txKm, tyKm,
                        isOccluded ? nxKm : -nxKm,
                        isOccluded ? nyKm : -nyKm,
                        cosLat, PIP_WARM_R_KM * geometryScale);
                feats.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    properties: {
                        id: p.id,
                        prodKind: 'front-pip',
                        color: isOccluded ? color : (isCold ? '#3388ff' : '#ff3333'),
                    },
                });
            });
            return feats;
        }

        const wantCold = cfg.pipMode === 'cold';
        const wantWarm = cfg.pipMode === 'warm';

        if (wantCold) {
            const pipColor = color;
            _pipPositions(frontCoords, side, PIP_SPACING_KM * geometryScale).forEach(({ lng, lat, txKm, tyKm, nxKm, nyKm, cosLat }) => {
                const ring = _makeTriangle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat, geometryScale);
                feats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ring] },
                    properties:{ id:p.id, prodKind:'front-pip', color:pipColor } });
            });
        }

        if (wantWarm) {
            const pipColor = color;
            _pipPositions(frontCoords, side, PIP_SPACING_KM * geometryScale).forEach(({ lng, lat, txKm, tyKm, nxKm, nyKm, cosLat }) => {
                const ring = _makeSemicircle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat, PIP_WARM_R_KM * geometryScale);
                feats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ring] },
                    properties:{ id:p.id, prodKind:'front-pip', color:pipColor } });
            });
        }

        return feats;
    }

    // ------------------------------------------------------------------
    // MapLibre source / layer management
    // ------------------------------------------------------------------
    function _validHexColor(value, fallback = '#101020') {
        return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
    }

    function _ensureTextBoxImage(color) {
        const safeColor = _validHexColor(color);
        const imageId = `pg-text-box-${safeColor.slice(1).toLowerCase()}`;
        if (_map.hasImage(imageId)) return imageId;
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = safeColor;
        ctx.fillRect(1, 1, 14, 14);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1;
        ctx.strokeRect(1.5, 1.5, 13, 13);
        _map.addImage(imageId, ctx.getImageData(0, 0, 16, 16), {
            stretchX: [[5, 11]], stretchY: [[5, 11]], content: [4, 4, 12, 12],
        });
        return imageId;
    }

    function _addMapLayers() {
        // ── Contour (polygon) layers ──────────────────────────────────
        _map.addSource(SRC_CONTOUR, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_CTR_FILL, type: 'fill', source: SRC_CONTOUR,
            filter: ['all', ['==', '$type', 'Polygon'], ['==', 'fillPattern', 'solid']],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 },
        });
        _map.addLayer({
            id: LYR_CTR_PATTERN, type: 'fill', source: SRC_CONTOUR,
            filter: ['all', ['==', '$type', 'Polygon'], ['!=', 'fillPattern', 'solid']],
            paint: { 'fill-pattern': ['get', 'patternImage'], 'fill-opacity': 0.9 },
        });
        _map.addLayer({
            id: LYR_CTR_LINE, type: 'line', source: SRC_CONTOUR,
            filter: ['==', 'featureRole', 'outline'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.95 },
        });
        _map.addLayer({
            id: LYR_CTR_LABEL, type: 'symbol', source: SRC_CONTOUR,
            filter: ['==', 'featureRole', 'outline'],
            layout: {
                'text-field': ['get', 'label'], 'text-size': 13,
                'text-font': ['Trebuchet MS'],
                'symbol-placement': 'line', 'symbol-spacing': 200,
                'text-keep-upright': true, 'text-rotation-alignment': 'map', 'text-max-angle': 50,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.5 },
        });

        _map.addSource(SRC_COUNTY_ALERTS, {type: 'geojson', data: _emptyFC()});
        _map.addLayer({
            id: LYR_COUNTY_SELECTED, type: 'fill', source: SRC_COUNTY_ALERTS,
            paint: {'fill-color': ['get', 'color'], 'fill-opacity': 0.22},
        });
        _map.addLayer({
            id: LYR_COUNTY_OUTLINE, type: 'line', source: SRC_COUNTY_ALERTS,
            layout: {'line-join': 'round', 'line-cap': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 1},
        });
        // ── Front (pip + backbone) layers ─────────────────────────────
        _map.addSource(SRC_FRONTS, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_FRONT_PIP, type: 'fill', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-pip'],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 },
        });
        _map.addLayer({
            id: LYR_FRONT_PIP_OUTLINE, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-pip-outline'],
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {
                'line-color': ['get', 'color'],
                'line-width': 2.5,
                'line-opacity': 1,
            },
        });
        _map.addLayer({
            id: LYR_FRONT_DECOR_LINE, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-decoration-line'],
            layout: {'line-cap': 'round'},
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['coalesce', ['get', 'width'], 3],
                'line-opacity': 1,
            },
        });
        _map.addLayer({
            id: LYR_ITCZ_LINE, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-itcz-line'],
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['get', 'width'],
                'line-opacity': 1,
            },
        });
        _map.addLayer({
            id: LYR_ITCZ_LINK, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-itcz-link'],
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['get', 'width'],
                'line-opacity': 1,
            },
        });
        _map.addLayer({
            id: LYR_FRONT_DECOR_DOT, type: 'circle', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-decoration-dot'],
            paint: {'circle-color': ['get', 'color'], 'circle-radius': 3, 'circle-opacity': 1},
        });
        _map.addLayer({
            id: LYR_FRONT_LINE, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-line'],
            paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.95 },
        });
        _map.addLayer({
            id: LYR_FRONT_DASHED_LINE, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-dashed-line'],
            layout: {'line-cap': 'butt', 'line-join': 'round'},
            paint: {
                'line-color': ['get', 'color'],
                'line-width': ['get', 'width'],
                'line-dasharray': [4, 3],
                'line-opacity': 0.95,
            },
        });
        _ensureTextBoxImage('#101020');
        _map.addLayer({
            id: LYR_ISOCHRONE_LABEL, type: 'symbol', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'isochrone-label'],
            layout: {
                'icon-image': ['get', 'boxImage'],
                'icon-text-fit': 'both', 'icon-text-fit-padding': [4, 6, 4, 6],
                'text-field': ['get', 'label'], 'text-size': 13,
                'text-font': ['Trebuchet MS Bold'], 'text-anchor': 'left',
                'text-offset': [0.65, 0], 'text-allow-overlap': true,
                'icon-allow-overlap': true,
            },
            paint: {
                'text-color': ['get', 'color'], 'text-halo-color': '#000000',
                'text-halo-width': 0.7, 'icon-opacity': 0.92,
            },
        });
        _map.addLayer({
            id: LYR_VECTOR_LABEL, type: 'symbol', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'vector-label'],
            layout: {
                'icon-image': ['get', 'boxImage'],
                'icon-text-fit': 'both', 'icon-text-fit-padding': [4, 6, 4, 6],
                'text-field': ['get', 'label'], 'text-size': 13,
                'text-font': ['Trebuchet MS Bold'], 'text-anchor': 'center',
                'text-allow-overlap': true, 'icon-allow-overlap': true,
            },
            paint: {
                'text-color': ['get', 'color'], 'text-halo-color': '#000000',
                'text-halo-width': 0.7, 'icon-opacity': 0.92,
            },
        });

        // ── Text / symbol layers ──────────────────────────────────────
        _map.addSource(SRC_SYMBOLS, { type: 'geojson', data: _emptyFC() });
        _ensureGempakImage(HURRICANE_SYMBOL_ID);
        _ensureGempakImage(_curGempakSymbolId, '#ffffff');
        _map.addLayer({
            id: LYR_HURRICANE_SYMBOL, type: 'symbol', source: SRC_SYMBOLS,
            filter: ['==', ['get', 'subKind'], 'hurricane'],
            layout: {
                'icon-image': _gempakImageId(HURRICANE_SYMBOL_ID),
                'icon-size': ['/', ['get', 'fontSize'], 24],
                'icon-allow-overlap': true,
            },
            paint: {
                'icon-color': ['get', 'color'],
                'icon-halo-color': '#000000',
                'icon-halo-width': 1,
            },
        });
        _map.addLayer({
            id: LYR_GEMPAK_SYMBOL, type: 'symbol', source: SRC_SYMBOLS,
            filter: ['==', ['get', 'subKind'], 'gempak'],
            layout: {
                'icon-image': ['get', 'iconImage'],
                'icon-size': ['/', ['get', 'fontSize'], 24],
                'icon-allow-overlap': true,
            },
            paint: {
                'icon-color': ['get', 'color'],
                'icon-halo-color': '#000000',
                'icon-halo-width': 0.6,
                'icon-opacity': 1,
            },
        });
        _map.addLayer({
            id: LYR_SYMBOL, type: 'symbol', source: SRC_SYMBOLS,
            filter: ['all',
                ['!', ['in', ['get', 'subKind'], ['literal', ['hurricane', 'gempak']]]],
                ['!=', ['get', 'boxed'], true],
            ],
            layout: {
                'text-field':         ['get', 'text'],
                'text-size':          ['get', 'fontSize'],
                'text-font':          ['Trebuchet MS Bold'],
                'text-anchor':        'center',
                'text-allow-overlap': true,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.5 },
        });
        _ensureTextBoxImage(_curTextBackground);
        _map.addLayer({
            id: LYR_BOXED_TEXT, type: 'symbol', source: SRC_SYMBOLS,
            filter: ['all', ['==', ['get', 'subKind'], 'text'], ['==', ['get', 'boxed'], true]],
            layout: {
                'icon-image': ['get', 'boxImage'],
                'icon-text-fit': 'both',
                'icon-text-fit-padding': [5, 7, 5, 7],
                'text-field': ['get', 'text'],
                'text-size': ['get', 'fontSize'],
                'text-font': ['Trebuchet MS Bold'],
                'text-anchor': 'center',
                'text-allow-overlap': true,
                'icon-allow-overlap': true,
            },
            paint: {
                'text-color': ['get', 'color'],
                'text-halo-color': '#000000', 'text-halo-width': 0.7,
                'icon-opacity': 0.92,
            },
        });
        _map.addLayer({
            id: LYR_PRESSURE_LABEL, type: 'symbol', source: SRC_SYMBOLS,
            filter: [
                'all',
                ['in', ['get', 'subKind'], ['literal', ['H', 'L']]],
                ['!=', ['get', 'pressureLabel'], ''],
            ],
            layout: {
                'text-field': ['get', 'pressureLabel'],
                'text-size': ['*', ['get', 'fontSize'], 0.58],
                'text-font': ['Trebuchet MS Bold'],
                'text-anchor': 'top',
                'text-offset': [0, 1.05],
                'text-allow-overlap': true,
            },
            paint: {
                'text-color': ['get', 'color'],
                'text-halo-color': '#000',
                'text-halo-width': 1.2,
            },
        });

        // ── Distance and frame-aware extrapolation guides ────────────
        _map.addSource(SRC_GUIDES, {type: 'geojson', data: _emptyFC()});
        _map.addLayer({
            id: LYR_GUIDE_LINE, type: 'line', source: SRC_GUIDES,
            filter: ['==', ['get', 'prodKind'], 'guide-line'],
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.95},
        });
        _map.addLayer({
            id: LYR_GUIDE_PROJECTION, type: 'line', source: SRC_GUIDES,
            filter: ['==', ['get', 'prodKind'], 'guide-projection'],
            layout: {'line-cap': 'round', 'line-join': 'round'},
            paint: {
                'line-color': ['get', 'color'], 'line-width': ['get', 'width'],
                'line-dasharray': [4, 3], 'line-opacity': 0.9,
            },
        });
        _map.addLayer({
            id: LYR_GUIDE_POINT, type: 'circle', source: SRC_GUIDES,
            filter: ['==', ['get', 'prodKind'], 'guide-point'],
            paint: {
                'circle-color': ['get', 'color'], 'circle-radius': 4,
                'circle-stroke-color': '#000000', 'circle-stroke-width': 1.2,
            },
        });
        _map.addLayer({
            id: LYR_GUIDE_LABEL, type: 'symbol', source: SRC_GUIDES,
            filter: ['==', ['get', 'prodKind'], 'guide-label'],
            layout: {
                'icon-image': ['get', 'boxImage'], 'icon-text-fit': 'both',
                'icon-text-fit-padding': [4, 6, 4, 6],
                'text-field': ['get', 'label'], 'text-size': 12,
                'text-font': ['Trebuchet MS Bold'], 'text-anchor': 'center',
                'text-allow-overlap': true, 'icon-allow-overlap': true,
            },
            paint: {
                'text-color': ['get', 'color'], 'text-halo-color': '#000000',
                'text-halo-width': 0.7, 'icon-opacity': 0.9,
            },
        });

        // ── Draft (in-progress drawing) ───────────────────────────────
        _map.addSource(SRC_DRAFT, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_DRAFT, type: 'line', source: SRC_DRAFT,
            filter: ['==', '$type', 'LineString'],
            paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': 0.9 },
        });
        _map.addLayer({
            id: LYR_VERTS, type: 'circle', source: SRC_DRAFT,
            filter: ['==', '$type', 'Point'],
            paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#222', 'circle-stroke-width': 1, 'circle-opacity': 0.9 },
        });

        // ── Edit (vertex drag) layers ─────────────────────────────────
        _map.addSource(SRC_EDIT, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_EDIT_LINE, type: 'line', source: SRC_EDIT,
            filter: ['==', '$type', 'LineString'],
            paint: { 'line-color': '#00ffff', 'line-width': 1.5, 'line-dasharray': [3, 2], 'line-opacity': 0.85 },
        });
        _map.addLayer({
            id: LYR_EDIT_VERTS, type: 'circle', source: SRC_EDIT,
            filter: ['==', '$type', 'Point'],
            paint: { 'circle-radius': 6, 'circle-color': '#00ffff', 'circle-stroke-color': '#005555', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9 },
        });
        // A larger, nearly invisible interaction target makes vertices easy
        // to acquire without making the teal handles visually oversized.
        // Keep this above the visible vertex layer so it captures mousedown
        // before MapLibre starts a map-pan gesture.
        _map.addLayer({
            id: LYR_EDIT_HIT, type: 'circle', source: SRC_EDIT,
            filter: ['==', '$type', 'Point'],
            paint: {
                'circle-radius': 14,
                'circle-color': '#00ffff',
                'circle-opacity': 0.01,
                'circle-stroke-width': 0,
            },
        });

        // ── Edit midpoint insert handles ──────────────────────────────
        _map.addSource(SRC_EDIT_MID, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_EDIT_MID, type: 'circle', source: SRC_EDIT_MID,
            paint: {
                'circle-radius':       5,
                'circle-color':        '#001a1a',
                'circle-stroke-color': '#00ffff',
                'circle-stroke-width': 1.5,
                'circle-opacity':      0.75,
            },
        });

        // Double-click finalized contour or front → enter edit mode
        const _onDblClickEdit = (e) => {
            if (_activeTool) return;
            e.preventDefault();
            const fid  = e.features[0]?.properties?.id;
            const prod = _products.find(p => p.id === fid);
            if (prod) _enterEditMode(prod);
        };
        _map.on('dblclick', LYR_CTR_FILL,   _onDblClickEdit);
        _map.on('dblclick', LYR_FRONT_LINE, _onDblClickEdit);
    }

    function _updateDraftLayer() {
        if (!_map || !_map.getSource(SRC_DRAFT)) return;
        const features = [];
        if (_draftCoords.length) {
            const isFrontTool = _activeTool && _activeTool.startsWith('front-');
            const line = [..._draftCoords];
            if (_mouseCoord) {
                line.push(_mouseCoord);
                // Only show closing segment for polygon (contour) tool, not for open front lines
                if (!isFrontTool && _draftCoords.length >= 2) line.push(_draftCoords[0]);
            }
            features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
            _draftCoords.forEach(c => features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
        }
        _map.getSource(SRC_DRAFT).setData({ type: 'FeatureCollection', features });
    }

    // Rebuild the contour fill and its explicit closed outline geometry.
    function _updateContourLayer() {
        if (!_map || !_map.getSource(SRC_CONTOUR)) return;
        const contourProperties = p => {
            const fillPattern = p.fillPattern || 'solid';
            return {
                id: p.id,
                color: p.color,
                width: p.width,
                label: p.label || '',
                fillPattern,
                patternDensity: p.patternDensity || 3,
                patternWidth: p.patternWidth || 1.5,
                patternImage: fillPattern === 'solid' ? '' : _ensureContourPatternImage(
                    fillPattern, p.color, p.patternDensity || 3, p.patternWidth || 1.5
                ),
            };
        };
        const features = [];
        const addContourFeatures = (p, coordinates) => {
            if (!coordinates || coordinates.length < 3) return;
            const first = coordinates[0];
            const last = coordinates[coordinates.length - 1];
            const ring = first[0] === last[0] && first[1] === last[1]
                ? coordinates.map(coord => [...coord])
                : [...coordinates.map(coord => [...coord]), [...first]];
            const properties = contourProperties(p);

            // Keep polygon fills and outlines as separate geometries. Rendering
            // a thick line directly from a polygon boundary can expose tile
            // clipping/simplification gaps at particular zoom levels.
            features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [ring] },
                properties: {...properties, featureRole: 'fill'},
            });
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: ring },
                properties: {...properties, featureRole: 'outline'},
            });
        };

        _productsBackToFront()
            .filter(p => p.kind === 'contour' && p.visible !== false && (!_editProduct || p.id !== _editProduct.id))
            .forEach(p => addContourFeatures(p, p.coords));

        // If editing a contour, render the in-progress version
        if (_editProduct && _editProduct.kind === 'contour') {
            addContourFeatures(_editProduct, _editCoords);
        }
        _map.getSource(SRC_CONTOUR).setData({ type: 'FeatureCollection', features });
    }

    function _ensureContourPatternImage(pattern, color, density = 3, patternWidth = 1.5) {
        const normalizedDensity = Math.max(0.25, Math.min(5, Number(density) || 3));
        const normalizedWidth = Math.max(0.5, Math.min(6, Number(patternWidth) || 1.5));
        const densityKey = String(normalizedDensity).replace('.', '_');
        const widthKey = String(normalizedWidth).replace('.', '_');
        const imageId = `pg-${pattern}-d${densityKey}-w${widthKey}-${color.replace('#', '').toLowerCase()}`;
        if (_map.hasImage(imageId)) return imageId;

        const spacing = Math.max(8, Math.round(24 / normalizedDensity + 4));
        const size = pattern === 'stars' ? Math.max(10, spacing + 8) : pattern === 'dashes' ? spacing * 2 : spacing;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = normalizedWidth;

        if (pattern === 'hatch' || pattern === 'crosshatch') {
            const diagonal = reverse => {
                ctx.beginPath();
                for (let offset = -size; offset <= size * 2; offset += Math.max(4, spacing / 2)) {
                    ctx.moveTo(offset, reverse ? 0 : size);
                    ctx.lineTo(offset + size, reverse ? size : 0);
                }
                ctx.stroke();
            };
            diagonal(false);
            if (pattern === 'crosshatch') diagonal(true);
        } else if (pattern === 'dots') {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, 1.6, 0, Math.PI * 2);
            ctx.fill();
        } else if (pattern === 'stars') {
            ctx.beginPath();
            for (let i = 0; i < 10; i++) {
                const radius = i % 2 === 0 ? 4.5 : 2;
                const angle = -Math.PI / 2 + i * Math.PI / 5;
                const x = size / 2 + Math.cos(angle) * radius;
                const y = size / 2 + Math.sin(angle) * radius;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();
        } else if (pattern === 'checker') {
            const half = size / 2;
            ctx.fillRect(0, 0, half, half);
            ctx.fillRect(half, half, half, half);
        } else if (pattern === 'dashes') {
            ctx.lineWidth = normalizedWidth;
            ctx.lineCap = 'butt';
            const dashLength = spacing * 0.34;
            const delta = dashLength / (2 * Math.sqrt(2));
            ctx.beginPath();
            for (let row = -2; row <= 3; row++) {
                const y = spacing * (row + 0.5);
                const rowOffset = row % 2 === 0 ? 0 : spacing / 2;
                for (let x = -size; x <= size * 2; x += spacing) {
                    const centerX = x + rowOffset;
                    ctx.moveTo(centerX - delta, y - delta);
                    ctx.lineTo(centerX + delta, y + delta);
                }
            }
            ctx.stroke();
        }

        _map.addImage(imageId, ctx.getImageData(0, 0, size, size), { pixelRatio: 1 });
        return imageId;
    }

    function _updateFrontLayer() {
        if (!_map || !_map.getSource(SRC_FRONTS)) return;
        const features = [];
        _productsBackToFront().filter(p => p.kind === 'front' && p.visible !== false && (!_editProduct || p.id !== _editProduct.id))
             .forEach(p => _generateFrontFeatures(p).forEach(f => features.push(f)));
        // If editing a front, render the in-progress version
        if (_editProduct && _editProduct.kind === 'front') {
            _generateFrontFeatures({ ..._editProduct, coords: [..._editCoords] }).forEach(f => features.push(f));
        }
        _map.getSource(SRC_FRONTS).setData({ type: 'FeatureCollection', features });
    }

    function _updateSymbolLayer() {
        if (!_map || !_map.getSource(SRC_SYMBOLS)) return;
        _products.filter(p => p.subKind === 'gempak' && p.visible !== false)
            .forEach(p => _ensureGempakImage(p.symbolId, p.color));
        _products.filter(p => p.kind === 'text' && p.subKind === 'text' && p.boxed && p.visible !== false)
            .forEach(p => _ensureTextBoxImage(p.backgroundColor));
        const features = _productsBackToFront()
            .filter(p => p.kind === 'text' && p.visible !== false)
            .map(p => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: {
                    id: p.id, subKind: p.subKind || 'text', text: p.text,
                    color: p.color, fontSize: p.fontSize || 18,
                    pressureLabel: _normalizedPressure(p.pressure),
                    symbolId: p.symbolId || '',
                    iconImage: p.subKind === 'gempak' ? _gempakImageId(p.symbolId, p.color) : '',
                    boxed: Boolean(p.boxed),
                    backgroundColor: _validHexColor(p.backgroundColor),
                    boxImage: p.boxed ? _ensureTextBoxImage(p.backgroundColor) : '',
                },
            }));
        _map.getSource(SRC_SYMBOLS).setData({ type: 'FeatureCollection', features });
    }

    function _updateGuideLayer() {
        const source = _map?.getSource(SRC_GUIDES);
        if (!source) return;
        const features = [];
        const boxImage = _ensureTextBoxImage('#101020');
        _productsBackToFront()
            .filter(p => p.kind === 'measurement' && p.visible !== false)
            .forEach(p => {
                const common = {id: p.id, color: p.color || '#66e0ff', width: p.width || 2};
                features.push({
                    type: 'Feature', geometry: {type: 'LineString', coordinates: p.coords},
                    properties: {...common, prodKind: 'guide-line'},
                });
                p.coords.forEach(coord => features.push({
                    type: 'Feature', geometry: {type: 'Point', coordinates: coord},
                    properties: {...common, prodKind: 'guide-point'},
                }));
                if (p.measureType === 'distance') {
                    const midpoint = [(p.coords[0][0] + p.coords[1][0]) / 2, (p.coords[0][1] + p.coords[1][1]) / 2];
                    features.push({
                        type: 'Feature', geometry: {type: 'Point', coordinates: midpoint},
                        properties: {
                            ...common, prodKind: 'guide-label', boxImage,
                            label: `${p.distanceNm.toFixed(1)} nmi / ${p.distanceKm.toFixed(1)} km · ${Math.round(p.bearing).toString().padStart(3, '0')}°`,
                        },
                    });
                    return;
                }
                const projected = Array.isArray(p.projected) ? p.projected : [];
                if (projected.length) {
                    features.push({
                        type: 'Feature',
                        geometry: {type: 'LineString', coordinates: [p.coords[1], ...projected.map(item => item.coord)]},
                        properties: {...common, prodKind: 'guide-projection'},
                    });
                }
                features.push({
                    type: 'Feature', geometry: {type: 'Point', coordinates: p.coords[1]},
                    properties: {
                        ...common, prodKind: 'guide-label', boxImage,
                        label: `${p.speedKt.toFixed(1)} kt · ${Math.round(p.bearing).toString().padStart(3, '0')}° · Δt ${Math.round(p.elapsedMinutes)} min`,
                    },
                });
                projected.forEach(item => {
                    features.push({
                        type: 'Feature', geometry: {type: 'Point', coordinates: item.coord},
                        properties: {...common, prodKind: 'guide-point'},
                    });
                    features.push({
                        type: 'Feature', geometry: {type: 'Point', coordinates: item.coord},
                        properties: {
                            ...common, prodKind: 'guide-label', boxImage,
                            label: `T+${item.minutes} · ${_formatUtc(item.timeMs).slice(11, 16)}Z`,
                        },
                    });
                });
            });
        source.setData({type: 'FeatureCollection', features});
    }

    function _updateCountyAlertLayers() {
        const source = _map?.getSource(SRC_COUNTY_ALERTS);
        if (!source) return;
        const features = [];
        _productsBackToFront()
            .filter(product => product.kind === 'county-alert' && product.visible !== false)
            .forEach(product => product.counties.forEach(county => {
                if (!county.geometry) return;
                features.push({
                    type: 'Feature', geometry: county.geometry,
                    properties: {fips: county.fips, color: product.color, productId: product.id},
                });
            }));
        source.setData({type: 'FeatureCollection', features});
    }

    async function _loadCountyReference() {
        try {
            const response = await fetch('/assets/counties_select.geojson');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            _countyFeaturesByFips = new Map(data.features.map(feature => [
                String(feature.properties.FIPS).padStart(5, '0'), feature,
            ]));
            _countySpatialGrid = new Map();
            data.features.forEach(feature => {
                const bbox = [Infinity, Infinity, -Infinity, -Infinity];
                const visit = coordinates => {
                    if (typeof coordinates?.[0] === 'number') {
                        bbox[0] = Math.min(bbox[0], coordinates[0]);
                        bbox[1] = Math.min(bbox[1], coordinates[1]);
                        bbox[2] = Math.max(bbox[2], coordinates[0]);
                        bbox[3] = Math.max(bbox[3], coordinates[1]);
                    } else coordinates?.forEach(visit);
                };
                visit(feature.geometry.coordinates);
                const entry = {bbox, feature};
                const minX = Math.floor((bbox[0] + 180) / COUNTY_GRID_DEGREES);
                const maxX = Math.floor((bbox[2] + 180) / COUNTY_GRID_DEGREES);
                const minY = Math.floor((bbox[1] + 90) / COUNTY_GRID_DEGREES);
                const maxY = Math.floor((bbox[3] + 90) / COUNTY_GRID_DEGREES);
                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        const key = `${x}:${y}`;
                        if (!_countySpatialGrid.has(key)) _countySpatialGrid.set(key, []);
                        _countySpatialGrid.get(key).push(entry);
                    }
                }
            });
            PG.info(`Loaded ${data.features.length} county selection features`);
        } catch (error) {
            console.error('[PG] Failed to load county reference data:', error);
            _setHint('County selection data could not be loaded.');
        }
    }

    function _countyHoverElement() {
        let element = document.querySelector('#pg-county-hover');
        if (!element) {
            element = document.createElement('div');
            element.id = 'pg-county-hover';
            _map.getContainer().appendChild(element);
        }
        return element;
    }

    function _onCountyHover(e) {
        if (_activeTool !== 'county-alert') return _hideCountyHover();
        const feature = _findCountyAt(e.lngLat.lng, e.lngLat.lat);
        if (!feature) return _hideCountyHover();
        const properties = feature.properties;
        const element = _countyHoverElement();
        element.textContent = `${properties.COUNTYNAME}${properties.STATE ? `, ${properties.STATE}` : ''} (${properties.FIPS})`;
        element.style.left = `${e.point.x + 14}px`;
        element.style.top = `${e.point.y + 14}px`;
        element.style.display = 'block';
    }

    function _hideCountyHover() {
        const element = document.querySelector('#pg-county-hover');
        if (element) element.style.display = 'none';
    }

    function _onCountyRightClick(e) {
        if (_activeTool !== 'county-alert' || !_activeCountyProduct) return;
        e.preventDefault();
        e.originalEvent?.preventDefault();
        const feature = _findCountyAt(e.lngLat.lng, e.lngLat.lat);
        if (!feature) return;
        const fips = String(feature.properties.FIPS).padStart(5, '0');
        const index = _activeCountyProduct.counties.findIndex(county => county.fips === fips);
        if (index < 0) return;
        _activeCountyProduct.counties.splice(index, 1);
        _updateCountyAlertLayers();
        _renderProductList();
        _setHint(`${_activeCountyProduct.counties.length} counties selected\nRight-click removes a county`);
    }

    function _updateAllLayers() {
        _updateContourLayer();
        _updateFrontLayer();
        _updateSymbolLayer();
        _updateCountyAlertLayers();
        _updateGuideLayer();
    }

    function _productsBackToFront() {
        return [..._products].reverse();
    }

    function _moveProductToIndex(productId, targetIndex) {
        const fromIndex = _products.findIndex(product => product.id === productId);
        const boundedIndex = Math.max(0, Math.min(_products.length - 1, targetIndex));
        if (fromIndex < 0 || fromIndex === boundedIndex) return;
        _saveUndo();
        const [product] = _products.splice(fromIndex, 1);
        _products.splice(boundedIndex, 0, product);
        _renderProductList();
        _updateAllLayers();
    }

    function _dropProductAt(productId, targetProductId, placeBefore) {
        if (productId === targetProductId) return;
        const fromIndex = _products.findIndex(product => product.id === productId);
        if (fromIndex < 0) return;
        const nextProducts = [..._products];
        const [product] = nextProducts.splice(fromIndex, 1);
        const targetIndex = nextProducts.findIndex(item => item.id === targetProductId);
        if (targetIndex < 0) return;
        nextProducts.splice(targetIndex + (placeBefore ? 0 : 1), 0, product);
        if (nextProducts.every((item, index) => item.id === _products[index].id)) return;
        _saveUndo();
        _products = nextProducts;
        _renderProductList();
        _updateAllLayers();
    }

    // ------------------------------------------------------------------
    // Product list UI
    // ------------------------------------------------------------------
    function _issuesByProductId(issues) {
        const byProductId = new Map();
        issues.forEach(issue => issue.productIds.forEach(productId => {
            if (!byProductId.has(productId)) byProductId.set(productId, []);
            byProductId.get(productId).push(issue.message);
        }));
        return byProductId;
    }

    function _updateForecastValidationStatus(issues, announce = false) {
        const status = _panel?.querySelector('#pg-forecast-validation');
        const button = _panel?.querySelector('#pg-validate-btn');
        const configuredContours = _products.filter(product =>
            product.kind === 'contour' && product.suiteId && product.forecastProductId
        );
        if (!status || !button) return;

        status.classList.remove('pg-validation-empty', 'pg-validation-valid', 'pg-validation-invalid');
        button.classList.toggle('pg-validation-invalid', issues.length > 0);
        if (!configuredContours.length) {
            status.classList.add('pg-validation-empty');
            status.textContent = 'Validity: draw a suite contour to check';
            status.title = '';
        } else if (!issues.length) {
            status.classList.add('pg-validation-valid');
            status.textContent = `Validity: no spatial overlaps (${configuredContours.length} area${configuredContours.length === 1 ? '' : 's'})`;
            status.title = 'Forecast categories and probability levels are spatially exclusive.';
        } else {
            status.classList.add('pg-validation-invalid');
            status.textContent = `Validity: ${issues.length} spatial overlap${issues.length === 1 ? '' : 's'}`;
            status.title = issues.map(issue => issue.message).join('\n');
        }

        if (announce) {
            const message = issues.length
                ? `Forecast validity check found ${issues.length} overlap${issues.length === 1 ? '' : 's'}:\n` +
                    issues.slice(0, 5).map(issue => `• ${issue.message}`).join('\n') +
                    (issues.length > 5 ? `\n• ${issues.length - 5} more (hover over Validity)` : '')
                : configuredContours.length
                    ? 'Forecast validity check passed: no category or probability areas overlap.'
                    : 'Draw contours from a forecast suite before running the validity check.';
            _setHint(message);
        }
    }

    function _renderProductList() {
        const ul = _panel.querySelector('#pg-product-list');
        const validationIssues = validateForecastProducts(_products);
        const issuesByProductId = _issuesByProductId(validationIssues);
        _updateForecastValidationStatus(validationIssues);
        if (!_products.length) {
            ul.innerHTML = '<li class="pg-no-products">No products drawn.</li>';
            return;
        }
        ul.innerHTML = '';
        _products.forEach((p, productIndex) => {
            const isEditing  = _editProduct?.id === p.id || _activeCountyProduct?.id === p.id;
            const isVisible  = p.visible !== false;
            const li = document.createElement('li');
            li.className = 'pg-product-item' + (isEditing ? ' selected' : '') + (isVisible ? '' : ' pg-hidden-prod');
            li.dataset.prodId = p.id;
            const productIssues = issuesByProductId.get(p.id) || [];
            if (productIssues.length) {
                li.classList.add('pg-product-invalid');
                li.title = productIssues.join('\n');
            }

            li.addEventListener('dragover', event => {
                if (_draggedProductId === null || _draggedProductId === p.id) return;
                event.preventDefault();
                const before = event.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
                li.classList.toggle('pg-drop-before', before);
                li.classList.toggle('pg-drop-after', !before);
            });
            li.addEventListener('dragleave', () => {
                li.classList.remove('pg-drop-before', 'pg-drop-after');
            });
            li.addEventListener('drop', event => {
                event.preventDefault();
                const before = event.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2;
                _dropProductAt(_draggedProductId, p.id, before);
            });

            // ---- Header row: vis / swatch / badge / name / edit? / del ----
            const hdrRow = document.createElement('div');
            hdrRow.className = 'pg-item-hdr';

            const dragHandle = document.createElement('span');
            dragHandle.className = 'pg-drag-handle';
            dragHandle.draggable = true;
            dragHandle.title = 'Drag to reorder';
            dragHandle.textContent = '⋮⋮';
            dragHandle.addEventListener('dragstart', event => {
                _draggedProductId = p.id;
                li.classList.add('pg-dragging');
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(p.id));
            });
            dragHandle.addEventListener('dragend', () => {
                _draggedProductId = null;
                _panel.querySelectorAll('.pg-product-item').forEach(item =>
                    item.classList.remove('pg-dragging', 'pg-drop-before', 'pg-drop-after'));
            });

            // Visibility toggle
            const visBtn = document.createElement('button');
            visBtn.className = 'pg-vis-btn';
            visBtn.title = isVisible ? 'Hide' : 'Show';
            visBtn.textContent = isVisible ? '●' : '○';
            visBtn.addEventListener('click', () => {
                p.visible = !isVisible;
                _renderProductList();
                _updateAllLayers();
            });

            const swatch = document.createElement('span');
            swatch.className = 'pg-prod-swatch';
            swatch.style.background = p.color;
            if (p.kind === 'contour' && (p.fillPattern || 'solid') !== 'solid') {
                swatch.title = `${p.fillPattern} fill`;
                swatch.style.backgroundImage = 'repeating-linear-gradient(45deg, transparent 0 3px, rgba(0,0,0,.65) 3px 4px)';
            }

            // Kind-aware badge
            const badge = document.createElement('span');
            badge.className = 'pg-prod-badge';
            if (p.kind === 'front') {
                badge.textContent = p.frontType || 'FRONT';
                badge.style.color = (FRONT_CFG[p.frontType] || {}).color || p.color;
            } else if (p.kind === 'text') {
                badge.textContent = p.subKind === 'hurricane' ? '🌀'
                    : p.subKind === 'gempak' ? (_gempakSymbol(p.symbolId)?.code || 'SYM').toUpperCase()
                    : p.text === 'H' ? 'H' : p.text === 'L' ? 'L' : 'TXT';
            } else if (p.kind === 'county-alert') {
                badge.textContent = `${p.hazard} ${p.significance}`;
                badge.title = `${p.counties.length} counties`;
            } else if (p.kind === 'measurement') {
                badge.textContent = p.measureType === 'extrapolation' ? 'XTRP' : 'DIST';
            } else {
                badge.textContent = p.forecastProductLabel
                    ? `${p.forecastProductLabel}: ${p.levelLabel}`
                    : p.type || 'CTR';
            }

            const nameInput = document.createElement('input');
            nameInput.className = 'pg-prod-name';
            nameInput.type  = 'text';
            nameInput.value = p.name;
            nameInput.title = 'Click to rename';
            nameInput.addEventListener('change', () => {
                p.name = nameInput.value.trim() || p.name;
                nameInput.value = p.name;
            });
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') nameInput.blur();
            });

            hdrRow.appendChild(dragHandle);
            hdrRow.appendChild(visBtn);
            hdrRow.appendChild(swatch);
            hdrRow.appendChild(badge);
            hdrRow.appendChild(nameInput);

            if (productIssues.length) {
                const warning = document.createElement('span');
                warning.className = 'pg-validity-warning';
                warning.textContent = '⚠';
                warning.title = productIssues.join('\n');
                hdrRow.appendChild(warning);
            }

            const orderControls = document.createElement('span');
            orderControls.className = 'pg-order-controls';
            const upBtn = document.createElement('button');
            upBtn.type = 'button';
            upBtn.title = 'Move product up';
            upBtn.setAttribute('aria-label', `Move ${p.name} up`);
            upBtn.textContent = '▲';
            upBtn.disabled = productIndex === 0;
            upBtn.addEventListener('click', () => _moveProductToIndex(p.id, productIndex - 1));
            const downBtn = document.createElement('button');
            downBtn.type = 'button';
            downBtn.title = 'Move product down';
            downBtn.setAttribute('aria-label', `Move ${p.name} down`);
            downBtn.textContent = '▼';
            downBtn.disabled = productIndex === _products.length - 1;
            downBtn.addEventListener('click', () => _moveProductToIndex(p.id, productIndex + 1));
            orderControls.append(upBtn, downBtn);
            hdrRow.appendChild(orderControls);

            if (p.kind === 'front') {
                const flipBtn = document.createElement('button');
                flipBtn.className = 'pg-edit-btn';
                flipBtn.title = `Flip front symbols to the ${p.pipSide === 'left' ? 'right' : 'left'} side`;
                flipBtn.setAttribute('aria-label', `Flip orientation of ${p.name}`);
                flipBtn.textContent = '↔';
                flipBtn.addEventListener('click', () => {
                    _saveUndo();
                    p.pipSide = p.pipSide === 'left' ? 'right' : 'left';
                    if (_editProduct?.id === p.id) _editProduct.pipSide = p.pipSide;
                    _updateFrontLayer();
                    _renderProductList();
                });
                hdrRow.appendChild(flipBtn);
            }

            // Text products use the same style editor without vertex handles.
            if (p.kind === 'contour' || p.kind === 'front' || p.kind === 'text') {
                const editBtn = document.createElement('button');
                editBtn.className = 'pg-edit-btn' + (isEditing ? ' active' : '');
                editBtn.title = isEditing ? 'Exit edit mode (Esc)'
                    : p.kind === 'text' ? 'Edit symbol or text' : 'Edit vertices & style';
                editBtn.innerHTML = '&#9998;';
                editBtn.addEventListener('click', () => {
                    if (_editProduct?.id === p.id) _exitEditMode();
                    else _enterEditMode(p);
                });
                hdrRow.appendChild(editBtn);
            } else if (p.kind === 'county-alert') {
                const editBtn = document.createElement('button');
                editBtn.className = 'pg-edit-btn' + (isEditing ? ' active' : '');
                editBtn.title = isEditing ? 'Finish selecting counties' : 'Edit selected counties';
                editBtn.innerHTML = '&#9998;';
                editBtn.addEventListener('click', () => {
                    if (_activeCountyProduct?.id === p.id) {
                        _enterTool(null);
                    } else {
                        _curAlertSignificance = p.significance;
                        _curAlertHazard = p.hazard;
                        _curAlertNumber = p.alertNumber || '';
                        _enterTool('county-alert');
                        _activeCountyProduct = p;
                        _panel.querySelector('#pg-alert-significance').value = p.significance;
                        _panel.querySelector('#pg-alert-hazard').value = p.hazard;
                        _panel.querySelector('#pg-alert-number').value = _curAlertNumber;
                        _renderProductList();
                    }
                });
                hdrRow.appendChild(editBtn);
            }

            const delBtn = document.createElement('button');
            delBtn.className = 'pg-del-btn';
            delBtn.title = 'Delete';
            delBtn.innerHTML = '&#10005;';
            delBtn.addEventListener('click', () => {
                if (_editProduct?.id === p.id) _exitEditMode();
                if (_activeCountyProduct?.id === p.id) {
                    _activeCountyProduct = null;
                    _enterTool(null);
                }
                _saveUndo();
                _products = _products.filter(x => x.id !== p.id);
                _renderProductList();
                _updateAllLayers();
            });
            hdrRow.appendChild(delBtn);
            li.appendChild(hdrRow);

            if (p.kind === 'county-alert') {
                const countySummary = document.createElement('div');
                countySummary.className = 'pg-county-summary';
                countySummary.textContent = `${p.counties.length} ${p.counties.length === 1 ? 'county' : 'counties'}`;
                countySummary.title = p.counties.map(county => `${county.name}${county.state ? `, ${county.state}` : ''} (${county.fips})`).join('\n');
                li.appendChild(countySummary);
            }

            // ---- Label row (contour edit only) ----
            if (isEditing && p.kind === 'contour') {
                const lblRow = document.createElement('div');
                lblRow.className = 'pg-item-label-row';

                const lblLbl = document.createElement('label');
                lblLbl.className = 'pg-lbl';
                lblLbl.textContent = 'Label';

                const lblInput = document.createElement('input');
                lblInput.className = 'pg-prod-label';
                lblInput.type  = 'text';
                lblInput.value = p.label || '';
                lblInput.placeholder = 'text along contour\u2026';
                lblInput.addEventListener('input', () => {
                    p.label = lblInput.value;
                    _updateContourLayer();
                });
                lblInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') lblInput.blur();
                });

                lblRow.appendChild(lblLbl);
                lblRow.appendChild(lblInput);
                li.appendChild(lblRow);
            }

            ul.appendChild(li);
        });
    }

    // TODO: save/load from localStorage
    function _countyAlertMultiPolygon(counties) {
        const polygons = [];
        counties.forEach(county => {
            if (county.geometry?.type === 'Polygon') polygons.push(county.geometry.coordinates);
            else if (county.geometry?.type === 'MultiPolygon') polygons.push(...county.geometry.coordinates);
        });
        return polygons.length ? {type: 'MultiPolygon', coordinates: polygons} : null;
    }

    function _finiteCoordinate(coord) {
        return Array.isArray(coord) && coord.length >= 2 &&
            Number.isFinite(Number(coord[0])) && Number.isFinite(Number(coord[1]));
    }

    function _importedProduct(feature, id) {
        const geometry = feature?.geometry;
        const props = feature?.properties || {};
        if (!geometry || typeof props.kind !== 'string') return null;
        const common = {
            id,
            kind: props.kind,
            name: String(props.name || `${props.kind} #${id}`),
            visible: props.visible !== false,
            color: typeof props.color === 'string' ? props.color : '#ffff00',
        };

        if (props.kind === 'contour' && geometry.type === 'Polygon') {
            const coords = geometry.coordinates?.[0];
            if (!Array.isArray(coords) || coords.length < 4 || !coords.every(_finiteCoordinate)) return null;
            return {
                ...common, coords: coords.map(coord => [Number(coord[0]), Number(coord[1])]),
                width: Number(props.width) || 2, label: String(props.label || ''),
                type: String(props.type || 'General'), fillPattern: String(props.fillPattern || 'solid'),
                patternDensity: Number(props.patternDensity) || 3,
                patternWidth: Number(props.patternWidth) || 1.5,
                suiteId: props.suiteId || null, suiteVersion: props.suiteVersion || null,
                forecastProductId: props.forecastProductId || null,
                forecastProductLabel: props.forecastProductLabel || null,
                levelId: props.levelId || null, levelLabel: props.levelLabel || null,
                value: props.value ?? null, units: props.units || null,
                forecastRole: props.forecastRole || null,
            };
        }
        if (props.kind === 'front' && geometry.type === 'LineString') {
            if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 ||
                !geometry.coordinates.every(_finiteCoordinate)) return null;
            return {
                ...common,
                coords: geometry.coordinates.map(coord => [Number(coord[0]), Number(coord[1])]),
                width: Number(props.width) || 2.5,
                frontType: FRONT_CFG[props.frontType] ? props.frontType : 'trough',
                pipSide: props.pipSide === 'left' ? 'left' : 'right',
                label: String(props.label || ''),
            };
        }
        if (props.kind === 'text' && geometry.type === 'Point' && _finiteCoordinate(geometry.coordinates)) {
            return {
                ...common, lng: Number(geometry.coordinates[0]), lat: Number(geometry.coordinates[1]),
                subKind: String(props.subKind || 'text'), text: String(props.text || 'Label'),
                fontSize: Number(props.fontSize) || 18,
                pressure: _normalizedPressure(props.pressure),
                symbolId: _gempakSymbol(String(props.symbolId || ''))?.id || '',
                boxed: props.subKind === 'text' && props.boxed === true,
                backgroundColor: _validHexColor(props.backgroundColor),
            };
        }
        if (props.kind === 'measurement' && geometry.type === 'LineString') {
            if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 2 ||
                !geometry.coordinates.every(_finiteCoordinate)) return null;
            const coords = geometry.coordinates.map(coord => [Number(coord[0]), Number(coord[1])]);
            const measureType = props.measureType === 'extrapolation' ? 'extrapolation' : 'distance';
            const motion = _geodesicMotion(coords[0], coords[1]);
            const elapsedMinutes = Number(props.elapsedMinutes) || 0;
            const speedKt = Number(props.speedKt) || 0;
            const projected = Array.isArray(props.projected) ? props.projected
                .filter(item => _finiteCoordinate(item?.coord) && Number.isFinite(Number(item?.minutes)))
                .map(item => ({
                    coord: [Number(item.coord[0]), Number(item.coord[1])],
                    minutes: Number(item.minutes), timeMs: Number(item.timeMs) || null,
                })) : [];
            return {
                ...common, measureType, coords, width: Number(props.width) || 2,
                distanceKm: motion.distanceKm, distanceNm: motion.distanceNm, bearing: motion.bearing,
                elapsedMinutes, speedKt, projected,
                observations: Array.isArray(props.observations) ? props.observations : [],
                intervalMinutes: Number(props.intervalMinutes) || 30,
                steps: Number(props.steps) || projected.length,
            };
        }
        if (props.kind === 'county-alert' && geometry.type === 'MultiPolygon') {
            const savedCounties = Array.isArray(props.counties) ? props.counties : [];
            const counties = savedCounties.map((county, index) => ({
                ...county,
                geometry: county.geometry || (geometry.coordinates?.[index]
                    ? {type: 'Polygon', coordinates: geometry.coordinates[index]} : null),
            })).filter(county => county.geometry);
            if (!counties.length) return null;
            return {
                ...common, counties,
                significance: String(props.significance || 'Warning'),
                hazard: String(props.hazard || 'Custom'),
                alertNumber: props.alertNumber || '',
            };
        }
        return null;
    }

    async function _importGeoJSON(file) {
        if (file.size > 25 * 1024 * 1024) throw new Error('file exceeds the 25 MiB import limit');
        const collection = JSON.parse(await file.text());
        if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) {
            throw new Error('expected a GeoJSON FeatureCollection');
        }
        if (collection.schemaVersion != null && Number(collection.schemaVersion) > 1) {
            throw new Error(`schema version ${collection.schemaVersion} is newer than this application supports`);
        }

        let nextImportedId = _nextId;
        const imported = collection.features
            .map(feature => _importedProduct(feature, nextImportedId++))
            .filter(Boolean);
        if (!imported.length) throw new Error('no supported Product Generation features were found');

        const replace = _products.length > 0 && window.confirm(
            `Import ${imported.length} product(s)?\n\nOK: replace current products\nCancel: merge with current products`
        );
        _saveUndo();
        _exitEditMode();
        _products = replace ? imported : [...imported, ..._products];
        _nextId = Math.max(_nextId, nextImportedId);
        _renderProductList();
        _updateAllLayers();
        const issues = validateForecastProducts(_products);
        _updateForecastValidationStatus(issues);
        _setHint(`Imported ${imported.length} product(s)${issues.length ? ` · ${issues.length} validation issue(s)` : ''}`);
    }

    function _exportGeoJSON() {
        const validationIssues = validateForecastProducts(_products);
        _updateForecastValidationStatus(validationIssues);
        if (validationIssues.length) {
            const preview = validationIssues.slice(0, 5)
                .map(issue => `• ${issue.message}`).join('\n');
            const remainder = validationIssues.length > 5
                ? `\n• ${validationIssues.length - 5} more overlap(s)` : '';
            const shouldExport = window.confirm(
                `Forecast validity check found ${validationIssues.length} spatial overlap(s):\n\n` +
                `${preview}${remainder}\n\nExport anyway?`
            );
            if (!shouldExport) return;
        }

        // Build a FeatureCollection with all products in their natural geometries
        const features = [];
        _products.forEach(p => {
            if (p.kind === 'contour') {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [p.coords] },
                    properties: {
                        kind: 'contour', id: p.id, name: p.name,
                        color: p.color, width: p.width, label: p.label || '', type: p.type || '',
                        fillPattern: p.fillPattern || 'solid',
                        patternDensity: p.patternDensity || 3,
                        patternWidth: p.patternWidth || 1.5,
                        suiteId: p.suiteId || null,
                        suiteVersion: p.suiteVersion || null,
                        forecastProductId: p.forecastProductId || null,
                        forecastProductLabel: p.forecastProductLabel || null,
                        levelId: p.levelId || null,
                        levelLabel: p.levelLabel || null,
                        value: p.value ?? null,
                        units: p.units || null,
                        forecastRole: p.forecastRole || null,
                    },
                });
            } else if (p.kind === 'front') {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: p.coords },
                    properties: { kind: 'front', id: p.id, name: p.name, color: p.color, width: p.width, frontType: p.frontType, pipSide: p.pipSide || 'right', label: p.label || '' },
                });
            } else if (p.kind === 'text') {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                    properties: {
                        kind: 'text', id: p.id, name: p.name,
                        subKind: p.subKind || 'text', color: p.color,
                        text: p.text, fontSize: p.fontSize || 18,
                        pressure: _normalizedPressure(p.pressure) || null,
                        symbolId: p.symbolId || null,
                        boxed: Boolean(p.boxed),
                        backgroundColor: p.boxed ? _validHexColor(p.backgroundColor) : null,
                    },
                });
            } else if (p.kind === 'measurement') {
                features.push({
                    type: 'Feature', geometry: {type: 'LineString', coordinates: p.coords},
                    properties: {
                        kind: 'measurement', id: p.id, name: p.name,
                        measureType: p.measureType, color: p.color, width: p.width,
                        distanceKm: p.distanceKm, distanceNm: p.distanceNm, bearing: p.bearing,
                        elapsedMinutes: p.elapsedMinutes || null, speedKt: p.speedKt || null,
                        intervalMinutes: p.intervalMinutes || null, steps: p.steps || null,
                        observations: p.observations || [], projected: p.projected || [],
                    },
                });
            } else if (p.kind === 'county-alert') {
                features.push({
                    type: 'Feature',
                    geometry: _countyAlertMultiPolygon(p.counties),
                    properties: {
                        kind: 'county-alert', id: p.id, name: p.name,
                        significance: p.significance, hazard: p.hazard,
                        alertNumber: p.alertNumber || null,
                        color: p.color,
                        counties: p.counties,
                        county_fips: p.counties.map(county => county.fips),
                    },
                });
            }
        });
        const configuredSuites = [...new Map(_products
            .filter(product => product.suiteId)
            .map(product => [product.suiteId, {
                id: product.suiteId,
                version: product.suiteVersion,
                label: getForecastSuite(product.suiteId)?.label || product.suiteId,
            }])).values()];
        const fc  = JSON.stringify({
            type: 'FeatureCollection',
            schemaVersion: 1,
            forecastSuites: configuredSuites,
            forecastValidation: {
                valid: validationIssues.length === 0,
                issueCount: validationIssues.length,
                issues: validationIssues,
            },
            productOrder: _products.map(product => product.id),
            features,
        }, null, 2);
        const a   = document.createElement('a');
        a.href    = 'data:application/json,' + encodeURIComponent(fc);
        a.download = 'products.geojson';
        a.click();
    }

    function _setHint(msg) {
        const el = _panel && _panel.querySelector('#pg-hint');
        if (el) el.textContent = msg;
    }

    function _emptyFC() {
        return { type: 'FeatureCollection', features: [] };
    }

    return { init, open, close, toggle };
})();
