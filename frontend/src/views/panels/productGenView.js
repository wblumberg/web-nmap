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
    const LYR_CTR_LINE   = 'pg-contour-line';
    const LYR_CTR_LABEL  = 'pg-contour-label';

    // ── Front source / layer IDs ───────────────────────────────────────
    const SRC_FRONTS     = 'pg-fronts';
    const LYR_FRONT_PIP  = 'pg-front-pip';
    const LYR_FRONT_LINE = 'pg-front-line';

    // ── Text / symbol source / layer IDs ──────────────────────────────
    const SRC_SYMBOLS    = 'pg-symbols';
    const LYR_SYMBOL     = 'pg-symbol-text';

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
    const FRONT_SMOOTHING_PASSES = 3;

    // ── Per-front-type defaults ────────────────────────────────────────
    const FRONT_CFG = {
        'cold':       { color: '#3388ff', pipMode: 'cold'  },
        'warm':       { color: '#ff3333', pipMode: 'warm'  },
        'stationary': { color: '#884488', pipMode: 'stat'  },
        'occluded':   { color: '#9922cc', pipMode: 'occ'   },
        'dryline':    { color: '#b05000', pipMode: 'warm'  },  // bumps
        'trough':     { color: '#cc8800', pipMode: 'none'  },
    };

    let _map     = null;
    let _panel   = null;
    let _isOpen  = false;

    // Drawing tool state
    let _activeTool  = null;   // 'contour'|'front-cold'|…|'H'|'L'|'text'|null
    let _drawing     = false;
    let _draftCoords = [];     // [[lng,lat], …]
    let _mouseCoord  = null;

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
    let _curText     = 'Label';
    let _curFontSize = 20;

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
    function init(map) {
        _map = map;
        _buildDOM();
        _addMapLayers();
        PG.info('ProductGen initialised');

        // Keyboard shortcuts for undo/redo, cancel, delete last vertex
        document.addEventListener('keydown', (e) => {
            // Undo / Redo
            if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); _undo(); return; }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); _redo(); return; }
            if (e.key === 'Escape') {
                if (_drawing) _cancelDraft();
                else if (_editProduct) _exitEditMode();
                return;
            }
            if (!_drawing) return;
            if (e.key === 'Backspace' || e.key === 'Delete') {
                if (_draftCoords.length) {
                    _draftCoords.pop();
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
    <button class="pg-hdr-btn" id="pg-export-btn" title="Export products as GeoJSON">&#8681;</button>
    <button id="pg-close" title="Close">&#10005;</button>
  </div>
</div>

<div class="pg-section-lbl">CONTOURS</div>
<div class="pg-tool-group">
  <button class="pg-tool-btn" id="pg-tool-contour" data-tool="contour" title="Closed Contour — click vertices, dbl-click to close">
    <svg width="40" height="18" viewBox="0 0 40 18" fill="none" stroke="currentColor" stroke-width="1.6">
      <ellipse cx="20" cy="9" rx="16" ry="6"/>
      <ellipse cx="20" cy="9" rx="8" ry="3"/>
    </svg>
    <span>Closed</span>
  </button>
</div>

<div class="pg-section-lbl">FRONTS <span class="pg-sect-note">pips on right of draw direction</span></div>
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
      <polygon points="8,9 17,9 12.5,2" fill="#3388ff"/>
      <polygon points="25,9 34,9 29.5,2" fill="#3388ff"/>
      <path d="M 3,9 A 8,8 0 0 0 19,9" fill="#ff3333"/>
      <path d="M 23,9 A 8,8 0 0 0 39,9" fill="#ff3333"/>
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
      <path d="M 3,9 A 8,8 0 0 1 19,9" fill="#b05000"/>
      <path d="M 23,9 A 8,8 0 0 1 39,9" fill="#b05000"/>
    </svg>
    <span style="color:#b05000">Dry</span>
  </button>
  <button class="pg-tool-btn pg-front-btn" id="pg-tool-front-trough" data-tool="front-trough" title="Trough (dashed, no pips)">
    <svg width="44" height="18" viewBox="0 0 44 18">
      <line x1="0" y1="9" x2="44" y2="9" stroke="#cc8800" stroke-width="2" stroke-dasharray="5 4"/>
    </svg>
    <span style="color:#cc8800">Trgh</span>
  </button>
</div>

<div class="pg-section-lbl">SYMBOLS &amp; TEXT</div>
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
</div>

<div class="pg-section-lbl">STYLE</div>
<div id="pg-style-section">
  <div class="pg-style-row" id="pg-row-ctype">
    <label class="pg-lbl">Type</label>
    <select id="pg-type">
      <option value="General">General</option>
      <option value="Probability">Probability</option>
      <option value="Region of Interest">Region of Interest</option>
      <option value="Threat Area">Threat Area</option>
      <option value="Advisory">Advisory</option>
      <option value="Custom">Custom</option>
    </select>
  </div>
  <div class="pg-style-row" id="pg-row-text">
    <label class="pg-lbl">Text</label>
    <input type="text" id="pg-text-content" value="Label" placeholder="Annotation\u2026" />
  </div>
  <div class="pg-style-row" id="pg-row-color">
    <label class="pg-lbl">Color</label>
    <input type="color" id="pg-color" value="#ffff00" />
    <label class="pg-lbl" style="margin-left:8px" id="pg-lbl-size">Width</label>
    <input type="number" id="pg-width" min="1" max="40" value="2" />
  </div>
</div>

<div id="pg-products-hdr">
  <span>PRODUCTS</span>
  <button class="pg-sm-btn" id="pg-clear-all" title="Remove all products">Clear All</button>
</div>
<ul id="pg-product-list">
  <li class="pg-no-products">No products drawn.</li>
</ul>
<div id="pg-hint"></div>
`;
        document.body.appendChild(_panel);

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
            }
        });

        // Undo / redo
        _panel.querySelector('#pg-undo').addEventListener('click', _undo);
        _panel.querySelector('#pg-redo').addEventListener('click', _redo);

        // Export to GeoJSON
        _panel.querySelector('#pg-export-btn').addEventListener('click', _exportGeoJSON);

        // Clear all
        _panel.querySelector('#pg-clear-all').addEventListener('click', () => {
            _saveUndo();
            _products = [];
            _exitEditMode();
            _renderProductList();
            _updateAllLayers();
        });

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
        const isHL      = _activeTool === 'H' || _activeTool === 'L';
        const noTool    = !_activeTool;

        // "Type" row only for contour tool
        _panel.querySelector('#pg-row-ctype').style.display = (isContour || (noTool && _editProduct?.kind === 'contour')) ? '' : 'none';
        // "Text" row only for text tool (or editing a text product)
        _panel.querySelector('#pg-row-text').style.display  = (isText || (noTool && _editProduct?.kind === 'text')) ? '' : 'none';
        // "Color+Width" row always, but hidden for H/L (auto-coloured)
        _panel.querySelector('#pg-row-color').style.display = isHL ? 'none' : '';
        // Label for width vs. size
        const sizeLabel = _panel.querySelector('#pg-lbl-size');
        if (sizeLabel) sizeLabel.textContent = isText ? 'Size' : 'Width';
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
            _map.doubleClickZoom.enable();
            _map.getCanvas().style.cursor = '';
            _panel.querySelector(`#pg-tool-${_activeTool}`)?.classList.remove('active');
        }

        _activeTool = toolName;

        if (toolName) {
            _map.on('click',     _onMapClick);
            _map.on('mousemove', _onMapMouseMove);
            _map.on('dblclick',  _onMapDblClick);
            _map.doubleClickZoom.disable();
            _map.getCanvas().style.cursor = 'crosshair';
            _panel.querySelector(`#pg-tool-${toolName}`)?.classList.add('active');

            // Set sensible style defaults per tool
            if (toolName === 'front-cold')       { _curColor = '#3388ff'; _curWidth = 2.5; }
            else if (toolName === 'front-warm')  { _curColor = '#ff3333'; _curWidth = 2.5; }
            else if (toolName === 'front-stationary') { _curColor = '#884488'; _curWidth = 2.5; }
            else if (toolName === 'front-occluded')   { _curColor = '#9922cc'; _curWidth = 2.5; }
            else if (toolName === 'front-dryline')    { _curColor = '#b05000'; _curWidth = 2.5; }
            else if (toolName === 'front-trough')     { _curColor = '#cc8800'; _curWidth = 2.5; }
            else if (toolName === 'H') { _curColor = '#4488ff'; _curWidth = 20; }
            else if (toolName === 'L') { _curColor = '#ff4444'; _curWidth = 20; }
            else if (toolName === 'text') { _curWidth = 18; }

            // Sync style controls to new defaults
            _panel.querySelector('#pg-color').value = _curColor;
            _panel.querySelector('#pg-width').value = _curWidth;

            const isFront = toolName.startsWith('front-');
            // Set the hint text for the active tool to help the user understand how to draw it
            if (toolName === 'contour' || isFront) {
                _setHint('Click to place vertices\nDbl-click to finish\nBackspace to undo\xa0\xa0Esc to cancel');
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
        if (tool === 'contour' || tool.startsWith('front-')) {
            _drawing = true;
            _draftCoords.push([e.lngLat.lng, e.lngLat.lat]);
            _updateDraftLayer();
        // Handle single click of the  H/L/text
        } else if (tool === 'H' || tool === 'L') {
            _placeText(e.lngLat.lng, e.lngLat.lat, tool, tool, tool === 'H' ? '#4488ff' : '#ff4444', 22);
        } else if (tool === 'text') {
            const txt = _panel.querySelector('#pg-text-content').value.trim() || 'Label';
            _placeText(e.lngLat.lng, e.lngLat.lat, 'text', txt, _curColor, _curWidth || 18);
        }
    }

    // Handler for keeping track of the mouse position while drawing.
    function _onMapMouseMove(e) {
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
        const p = {
            id:    _nextId++,
            kind:  'contour',
            type:  _curType,
            name:  '',
            visible: true,
            coords: closed,
            color: _curColor,
            width: _curWidth,
            label: '',
        };
        p.name = `${p.type} #${p.id}`;
        _products.push(p);
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
        };
        p.name = `${frontType.charAt(0).toUpperCase() + frontType.slice(1)} Front #${p.id}`;
        _products.push(p);
        PG.info(`Front created → id=${p.id} "${p.name}" type=${frontType} vertices=${p.coords.length} | total: ${_products.length}`);
        _drawing = false; _draftCoords = []; _mouseCoord = null;
        _updateDraftLayer();
        _updateFrontLayer();
        _renderProductList();
        _setHint('Click to place vertices\nDbl-click to finish\nBackspace to undo\xa0\xa0Esc to cancel');
    }

    // Place a text product (H, L, or free text) at the given coordinates with the specified color and font size. This is called when the user clicks on the map while the H/L/text tool is active.
    function _placeText(lng, lat, kind, text, color, fontSize) {
        _saveUndo();
        const p = {
            id:       _nextId++,
            kind:     'text',
            subKind:  kind,    // 'H' | 'L' | 'text'
            name:     `${kind === 'H' || kind === 'L' ? kind + ' center' : 'Text'} #${_nextId - 1}`,
            visible:  true,
            lng, lat,
            text,
            color,
            fontSize: fontSize || 18,
        };
        _products.push(p);
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
        const raw = product.coords;
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
        }
        if (product.kind === 'text') {
            _panel.querySelector('#pg-text-content').value = product.text || '';
            _curText = product.text || '';
            _curFontSize = product.fontSize || 18;
            _panel.querySelector('#pg-color').value = product.color;
            _panel.querySelector('#pg-width').value = product.fontSize || 18;
        }
        _updateStylePanel();
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
        _dragVertIdx = -1;
        _map.dragPan.enable();
        _map.getCanvas().style.cursor = _overEditVertex ? 'move' : '';
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

    // Walk a polyline and collect pip positions with local coordinate frames
    function _pipPositions(coords, side) {
        const pips = [];
        let distSinceLast = PIP_SPACING_KM * 0.4;  // offset first pip from very start
        for (let i = 0; i < coords.length - 1; i++) {
            const [lng0, lat0] = coords[i];
            const [lng1, lat1] = coords[i + 1];
            const midLat = (lat0 + lat1) / 2;
            const cosLat = Math.cos(midLat * Math.PI / 180);
            const dxKm = (lng1 - lng0) * 400.3 * cosLat;
            const dyKm = (lat1 - lat0) * 400.3;
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
                    lng:   lng0 + (t * txKm) / (400.3 * cosLat),
                    lat:   lat0 + (t * tyKm) / 400.3,
                    txKm, tyKm, nxKm, nyKm, cosLat,
                });
                t += PIP_SPACING_KM;
            }
            distSinceLast = t - segLen;
        }
        return pips;
    }

    // Convert a km-space offset (relative to pip centre) to [lng, lat]
    function _toCoord(lng, lat, cosLat, dxKm, dyKm) {
        return [lng + dxKm / (400.3 * cosLat), lat + dyKm / 400.3];
    }

    function _makeTriangle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat) {
        const h = PIP_COLD_HT_KM, b = PIP_COLD_BASE_KM;
        const p1 = _toCoord(lng, lat, cosLat, -b * txKm, -b * tyKm);   // base-left
        const p2 = _toCoord(lng, lat, cosLat,  b * txKm,  b * tyKm);   // base-right
        const p3 = _toCoord(lng, lat, cosLat,  h * nxKm,  h * nyKm);   // apex
        return [p1, p2, p3, p1];
    }

    function _makeSemicircle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat) {
        const r = PIP_WARM_R_KM;
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
        pts.push(pts[0]);
        return pts;
    }

    // Build the complete set of GeoJSON features for one front product
    function _generateFrontFeatures(p) {
        const cfg = FRONT_CFG[p.frontType] || {};
        const color = cfg.color || p.color;
        const feats = [];
        const frontCoords = _smoothFront(p.coords);

        feats.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: frontCoords },
            properties: { id: p.id, prodKind: 'front-line', color, width: p.width || 2 },
        });

        if (cfg.pipMode === 'none' || !p.coords || p.coords.length < 2) return feats;

        const side  = p.pipSide || 'right';

        // A stationary front uses one shared placement sequence. Alternating
        // entries are triangles on the cold side and semicircles on the warm
        // side; generating two complete sequences caused the previous paired
        // (and visually non-alternating) symbols.
        if (cfg.pipMode === 'stat') {
            _pipPositions(frontCoords, side).forEach((position, index) => {
                const { lng, lat, txKm, tyKm, nxKm, nyKm, cosLat } = position;
                const isCold = index % 2 === 0;
                const ring = isCold
                    ? _makeTriangle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat)
                    : _makeSemicircle(lng, lat, txKm, tyKm, -nxKm, -nyKm, cosLat);
                feats.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [ring] },
                    properties: {
                        id: p.id,
                        prodKind: 'front-pip',
                        color: isCold ? '#3388ff' : '#ff3333',
                    },
                });
            });
            return feats;
        }

        const wantCold = cfg.pipMode === 'cold' || cfg.pipMode === 'occ';
        const wantWarm = cfg.pipMode === 'warm';

        if (wantCold) {
            const pipColor = cfg.pipMode === 'occ' ? '#9922cc' : color;
            _pipPositions(frontCoords, side).forEach(({ lng, lat, txKm, tyKm, nxKm, nyKm, cosLat }) => {
                const ring = _makeTriangle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat);
                feats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ring] },
                    properties:{ id:p.id, prodKind:'front-pip', color:pipColor } });
            });
        }

        if (wantWarm) {
            const pipColor = color;
            _pipPositions(frontCoords, side).forEach(({ lng, lat, txKm, tyKm, nxKm, nyKm, cosLat }) => {
                const ring = _makeSemicircle(lng, lat, txKm, tyKm, nxKm, nyKm, cosLat);
                feats.push({ type:'Feature', geometry:{ type:'Polygon', coordinates:[ring] },
                    properties:{ id:p.id, prodKind:'front-pip', color:pipColor } });
            });
        }

        return feats;
    }

    // ------------------------------------------------------------------
    // MapLibre source / layer management
    // ------------------------------------------------------------------
    function _addMapLayers() {
        // ── Contour (polygon) layers ──────────────────────────────────
        _map.addSource(SRC_CONTOUR, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_CTR_FILL, type: 'fill', source: SRC_CONTOUR,
            filter: ['==', '$type', 'Polygon'],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 },
        });
        _map.addLayer({
            id: LYR_CTR_LINE, type: 'line', source: SRC_CONTOUR,
            paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.95 },
        });
        _map.addLayer({
            id: LYR_CTR_LABEL, type: 'symbol', source: SRC_CONTOUR,
            layout: {
                'text-field': ['get', 'label'], 'text-size': 13,
                'text-font': ['Trebuchet MS'],
                'symbol-placement': 'line', 'symbol-spacing': 200,
                'text-keep-upright': true, 'text-rotation-alignment': 'map', 'text-max-angle': 50,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.5 },
        });

        // ── Front (pip + backbone) layers ─────────────────────────────
        _map.addSource(SRC_FRONTS, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_FRONT_PIP, type: 'fill', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-pip'],
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 1.0 },
        });
        _map.addLayer({
            id: LYR_FRONT_LINE, type: 'line', source: SRC_FRONTS,
            filter: ['==', ['get', 'prodKind'], 'front-line'],
            paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': 0.95 },
        });

        // ── Text / symbol layers ──────────────────────────────────────
        _map.addSource(SRC_SYMBOLS, { type: 'geojson', data: _emptyFC() });
        _map.addLayer({
            id: LYR_SYMBOL, type: 'symbol', source: SRC_SYMBOLS,
            layout: {
                'text-field':         ['get', 'text'],
                'text-size':          ['get', 'fontSize'],
                'text-font':          ['Trebuchet MS Bold'],
                'text-anchor':        'center',
                'text-allow-overlap': true,
            },
            paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.5 },
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

    // FIXME: Make sure that the outline of the polygon is completely visible and forms a closed loop.  
    function _updateContourLayer() {
        if (!_map || !_map.getSource(SRC_CONTOUR)) return;
        const features = _products
            .filter(p => p.kind === 'contour' && p.visible !== false && (!_editProduct || p.id !== _editProduct.id))
            .map(p => ({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [p.coords] },
                properties: { id: p.id, color: p.color, width: p.width, label: p.label || '' },
            }));
        // If editing a contour, render the in-progress version
        if (_editProduct && _editProduct.kind === 'contour') {
            features.push({
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [_editCoords] },
                properties: { id: _editProduct.id, color: _editProduct.color, width: _editProduct.width, label: _editProduct.label || '' },
            });
        }
        _map.getSource(SRC_CONTOUR).setData({ type: 'FeatureCollection', features });
    }

    function _updateFrontLayer() {
        if (!_map || !_map.getSource(SRC_FRONTS)) return;
        const features = [];
        _products.filter(p => p.kind === 'front' && p.visible !== false && (!_editProduct || p.id !== _editProduct.id))
             .forEach(p => _generateFrontFeatures(p).forEach(f => features.push(f)));
        // If editing a front, render the in-progress version
        if (_editProduct && _editProduct.kind === 'front') {
            _generateFrontFeatures({ ..._editProduct, coords: [..._editCoords] }).forEach(f => features.push(f));
        }
        _map.getSource(SRC_FRONTS).setData({ type: 'FeatureCollection', features });
    }

    function _updateSymbolLayer() {
        if (!_map || !_map.getSource(SRC_SYMBOLS)) return;
        const features = _products
            .filter(p => p.kind === 'text' && p.visible !== false)
            .map(p => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                properties: { id: p.id, text: p.text, color: p.color, fontSize: p.fontSize || 18 },
            }));
        _map.getSource(SRC_SYMBOLS).setData({ type: 'FeatureCollection', features });
    }

    function _updateAllLayers() {
        _updateContourLayer();
        _updateFrontLayer();
        _updateSymbolLayer();
    }

    // ------------------------------------------------------------------
    // Product list UI
    // ------------------------------------------------------------------
    function _renderProductList() {
        const ul = _panel.querySelector('#pg-product-list');
        if (!_products.length) {
            ul.innerHTML = '<li class="pg-no-products">No products drawn.</li>';
            return;
        }
        ul.innerHTML = '';
        _products.forEach(p => {
            const isEditing  = _editProduct?.id === p.id;
            const isVisible  = p.visible !== false;
            const li = document.createElement('li');
            li.className = 'pg-product-item' + (isEditing ? ' selected' : '') + (isVisible ? '' : ' pg-hidden-prod');
            li.dataset.prodId = p.id;

            // ---- Header row: vis / swatch / badge / name / edit? / del ----
            const hdrRow = document.createElement('div');
            hdrRow.className = 'pg-item-hdr';

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

            // Kind-aware badge
            const badge = document.createElement('span');
            badge.className = 'pg-prod-badge';
            if (p.kind === 'front') {
                badge.textContent = p.frontType || 'FRONT';
                badge.style.color = (FRONT_CFG[p.frontType] || {}).color || p.color;
            } else if (p.kind === 'text') {
                badge.textContent = p.text === 'H' ? 'H' : p.text === 'L' ? 'L' : 'TXT';
            } else {
                badge.textContent = p.type || 'CTR';
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

            hdrRow.appendChild(visBtn);
            hdrRow.appendChild(swatch);
            hdrRow.appendChild(badge);
            hdrRow.appendChild(nameInput);

            // Edit button only for contour and front (not for text/H/L)
            if (p.kind === 'contour' || p.kind === 'front') {
                const editBtn = document.createElement('button');
                editBtn.className = 'pg-edit-btn' + (isEditing ? ' active' : '');
                editBtn.title = isEditing ? 'Exit edit mode (Esc)' : 'Edit vertices & style';
                editBtn.innerHTML = '&#9998;';
                editBtn.addEventListener('click', () => {
                    if (_editProduct?.id === p.id) _exitEditMode();
                    else _enterEditMode(p);
                });
                hdrRow.appendChild(editBtn);
            }

            const delBtn = document.createElement('button');
            delBtn.className = 'pg-del-btn';
            delBtn.title = 'Delete';
            delBtn.innerHTML = '&#10005;';
            delBtn.addEventListener('click', () => {
                if (_editProduct?.id === p.id) _exitEditMode();
                _saveUndo();
                _products = _products.filter(x => x.id !== p.id);
                _renderProductList();
                _updateAllLayers();
            });
            hdrRow.appendChild(delBtn);
            li.appendChild(hdrRow);

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

    // TODO: export to GeoJSON, import from GeoJSON, undo/redo, save/load from localStorage
    function _exportGeoJSON() {
        // Build a FeatureCollection with all products in their natural geometries
        const features = [];
        _products.forEach(p => {
            if (p.kind === 'contour') {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [p.coords] },
                    properties: { kind: 'contour', id: p.id, name: p.name, color: p.color, width: p.width, label: p.label || '', type: p.type || '' },
                });
            } else if (p.kind === 'front') {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: p.coords },
                    properties: { kind: 'front', id: p.id, name: p.name, color: p.color, width: p.width, frontType: p.frontType, pipSide: p.pipSide || 'right' },
                });
            } else if (p.kind === 'text') {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                    properties: { kind: 'text', id: p.id, name: p.name, color: p.color, text: p.text, fontSize: p.fontSize || 18 },
                });
            }
        });
        const fc  = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
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
