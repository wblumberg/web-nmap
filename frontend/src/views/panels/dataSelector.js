/**
 * dataselector.js — Dataset Selector Dialog for web-nmap
 *
 * Provides a three-panel hierarchical dataset picker inspired by GEMPAK NMAP2's
 * data selector.  The three panels are:
 *
 *   [CATEGORY] → [DATASET LIST] → [METADATA]
 *
 * Usage:
 *   DataSelector.init();               // call once after catalog is loaded
 *   DataSelector.open(onLoadCallback); // opens the dialog
 *     onLoadCallback(id) is called with the catalog id when the user clicks Load
 */

import { getState } from '../../app/store.js';
import * as CatalogClient from '../../services/api/catalogClient.js';
import { PRODUCT_SUITES } from '../../domain/dataProducts/productIndex.js';


export const DataSelector = (() => {
    'use strict';
    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let _onLoad    = null;   // callback(id) invoked on "Load"
    let _selCat    = null;   // currently selected category key
    let _selId     = null;   // currently selected catalog entry id
    let _entries   = [];     // flat list of display entries from API sources
    let _overlay   = null;   // root DOM element (created once)

    // Cycle-time selection state (forecast datasets only)
    let _selCycleTime    = null;  // selected cycle time (Date) or null
    let _cycleProbeToken = 0;     // incremented to cancel stale cycle probes
    let _preselCycleTime = null;  // cycle to pre-select when editing an existing source

    // ------------------------------------------------------------------
    // Category label map (replaces the old DataCategoryLabel global)
    // ------------------------------------------------------------------
    const DataCategoryLabel = {
        MODEL_DET:    'Deterministic Models',
        MODEL_ENS:    'Ensemble Models',
        ANALYSIS:     'Analyses',
        SATELLITE:    'Satellite',
        RADAR_MOSAIC: 'Radar Mosaics',
        RADAR_NEXRAD: 'NEXRAD (Single Site)',
        OBS_UPPERAIR: 'Upper Air Observations',
        OBS_SURFACE:  'Surface Observations',
        MISC:         'Miscellaneous',
    };

    // ------------------------------------------------------------------
    // Helpers: map API sources to display entries + product availability
    // ------------------------------------------------------------------

    /**
     * Check if any product suite declares support for this source.
     * Replaces the old `DataRegistry.has(id)` check.
     */
    function _hasProducts(sourceId) {
        return Object.values(PRODUCT_SUITES).some(p =>
            Array.isArray(p.available_for) && p.available_for.includes(sourceId)
        );
    }

    /**
     * Convert API source objects into the shape the DataSelector rendering
     * functions expect.
     *
     * API source: { source_id, label, data_category, source_type, has_cycles, has_fhrs }
     * Display entry: { id, name, category, description, subcategory, tags,
     *                   has_forecast_hour, ... }
     */
    function _mapSources(apiSources) {
        if (!apiSources || !apiSources.length) return [];
        return apiSources.map(src => ({
            id:             src.source_id,
            name:           src.label,
            // Use source_type for the category selector hierarchy (MODEL_DET, OBS_SURFACE, …)
            category:       src.source_type || src.data_category || 'MISC',
            description:    src.label,
            subcategory:    src.data_category || null,
            tags:           [],
            has_forecast_hour: !!(src.has_fhrs || src.has_cycles),
            has_cycles:        !!(src.has_cycles),
            // These fields were from the old catalog.json — we don't have them
            // from the API but keep them so the info panel degrades gracefully.
            data_format: null,
            dtype:       null,
            grid:        null,
            max_zoom:    null,
            temporal_frequency_min: null,
            time_range_hr:         null,
        }));
    }

    // ------------------------------------------------------------------
    // Category order (mirrors DataCategoryLabel in catalog.js)
    // ------------------------------------------------------------------
    const CAT_ORDER = [
        'MODEL_DET',
        'MODEL_ENS',
        'ANALYSIS',
        'SATELLITE',
        'RADAR_MOSAIC',
        'RADAR_NEXRAD',
        'OBS_UPPERAIR',
        'OBS_SURFACE',
        'MISC',
    ];

    // ------------------------------------------------------------------
    // Build DOM (called once by init())
    // ------------------------------------------------------------------
    function _buildDOM() {
        const overlay = document.createElement('div');
        overlay.id = 'ds-overlay';
        overlay.innerHTML = `
<div id="ds-dialog">
  <div id="ds-titlebar">
    <span id="ds-title">&#9632; SELECT DATASET</span>
    <button id="ds-close" title="Close">&#10005;</button>
  </div>
  <div id="ds-search-bar">
    <input id="ds-search" type="text" placeholder="Search datasets..." autocomplete="off" spellcheck="false" />
    <span id="ds-search-clear" title="Clear search">&#10005;</span>
  </div>
  <div id="ds-panels">
    <div id="ds-cat-panel">
      <div class="ds-panel-header">CATEGORY</div>
      <ul id="ds-cat-list"></ul>
    </div>
    <div id="ds-list-panel">
      <div class="ds-panel-header">DATASET <span id="ds-list-count"></span></div>
      <ul id="ds-dataset-list"></ul>
    </div>
    <div id="ds-info-panel">
      <div class="ds-panel-header">INFO</div>
      <div id="ds-info-content">
        <p class="ds-info-placeholder">Select a dataset.</p>
      </div>
    </div>
  </div>
  <div id="ds-footer">
    <div id="ds-status"></div>
    <div id="ds-footer-btns">
      <button id="ds-cancel-btn">CANCEL</button>
      <button id="ds-load-btn" disabled>LOAD</button>
    </div>
  </div>
</div>`;

        document.body.appendChild(overlay);

        // Wire up close / cancel / load
        overlay.querySelector('#ds-close').addEventListener('click', _close);
        overlay.querySelector('#ds-cancel-btn').addEventListener('click', _close);
        overlay.querySelector('#ds-load-btn').addEventListener('click', _handleLoad);

        // Clicking the backdrop closes the dialog
        overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(); });

        // Search box
        const searchInput = overlay.querySelector('#ds-search');
        const searchClear = overlay.querySelector('#ds-search-clear');
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim();
            searchClear.style.display = q ? 'flex' : 'none';
            _renderDatasetList();
        });
        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            searchClear.style.display = 'none';
            _renderDatasetList();
        });

        // Keyboard: Escape closes
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display !== 'none' && overlay.style.display !== '') {
                _close();
            }
        });

        return overlay;
    }

    // ------------------------------------------------------------------
    // Cycle-time helpers (forecast datasets) — API-based
    // ------------------------------------------------------------------

    /**
     * Probe available cycles for a forecast source using the catalog API.
     * Replaces the old HEAD-request / data_store_catalog approach.
     */
    async function _probeCyclesFromAPI(entry, token) {
        if (!entry || !entry.has_forecast_hour) return null;

        try {
            const cyclesData = await CatalogClient.listCycles(entry.id, { limit: 20 });
            if (token !== _cycleProbeToken) return null; // stale

            // cyclesData: [{ cycle, cycle_time, fhr_count, fhr_min, fhr_max, fhrs }]
            // Convert to Date array (newest first) for the cycle picker.
            const cycles = cyclesData
                .map(c => new Date(c.cycle_time))
                .filter(d => Number.isFinite(d.getTime()));

            return cycles;
        } catch (err) {
            console.warn(`[DataSelector] Failed to probe cycles for "${entry.id}":`, err);
            return null;
        }
    }

    /** Format a Date as "DD Mon YYYY HHZ" for the cycle picker dropdown. */
    function _fmtCycleLabel(dt) {
        const pad = n => String(n).padStart(2, '0');
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
        return `${pad(dt.getUTCDate())} ${mon} ${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:00 UTC`;
    }

    // RENDERING FUNCTION SECTION

    // ------------------------------------------------------------------
    // Render category list
    // ------------------------------------------------------------------
    function _renderCategories() {
        const ul = _overlay.querySelector('#ds-cat-list');
        ul.innerHTML = '';

        // Count entries per category so we can show them
        const counts = {};
        const impl   = {};
        for (const e of _entries) {
            counts[e.category] = (counts[e.category] || 0) + 1;
            if (_hasProducts(e.id)) impl[e.category] = (impl[e.category] || 0) + 1;
        }

        for (const cat of CAT_ORDER) {
            if (!counts[cat]) continue;
            const li = document.createElement('li');
            li.className = 'ds-cat-item';
            li.dataset.cat = cat;

            const label = DataCategoryLabel[cat] || cat;
            const n     = counts[cat] || 0;
            const ni    = impl[cat]   || 0;

            li.innerHTML =
                `<span class="ds-cat-label">${label}</span>` +
                `<span class="ds-cat-badge">${ni}/${n}</span>`;

            if (cat === _selCat) li.classList.add('selected');

            li.addEventListener('click', () => {
                _selCat = cat;
                _selId  = null;
                _renderCategories();
                _renderDatasetList();
                _renderInfo();
            });

            ul.appendChild(li);
        }

        // "All" pseudo-category goes at the top
        const allLi = document.createElement('li');
        allLi.className = 'ds-cat-item ds-cat-all' + (_selCat === null ? ' selected' : '');
        allLi.innerHTML =
            `<span class="ds-cat-label">All</span>` +
            `<span class="ds-cat-badge">${_entries.length}</span>`;
        allLi.addEventListener('click', () => {
            _selCat = null;
            _selId  = null;
            _renderCategories();
            _renderDatasetList();
            _renderInfo();
        });
        ul.insertBefore(allLi, ul.firstChild);
    }

    // ------------------------------------------------------------------
    // Render dataset list for selected category, filtered by search
    // ------------------------------------------------------------------
    function _renderDatasetList() {
        const ul      = _overlay.querySelector('#ds-dataset-list');
        const counter = _overlay.querySelector('#ds-list-count');
        const query   = (_overlay.querySelector('#ds-search').value || '').trim().toLowerCase();

        ul.innerHTML = '';

        let visible = _selCat ? _entries.filter(e => e.category === _selCat) : _entries.slice();

        if (query) {
            visible = visible.filter(e =>
                e.name.toLowerCase().includes(query) ||
                e.description.toLowerCase().includes(query) ||
                (e.tags || []).some(t => t.toLowerCase().includes(query)) ||
                (e.subcategory || '').toLowerCase().includes(query)
            );
        }

        counter.textContent = visible.length ? `(${visible.length})` : '';

        if (!visible.length) {
            const li = document.createElement('li');
            li.className = 'ds-no-results';
            li.textContent = 'No datasets match.';
            ul.appendChild(li);
            return;
        }

        // Group by subcategory within the list so it's easy to scan
        const bySub = {};
        const subOrder = [];
        for (const e of visible) {
            const sub = e.subcategory || '';
            if (!bySub[sub]) { bySub[sub] = []; subOrder.push(sub); }
            bySub[sub].push(e);
        }

        for (const sub of subOrder) {
            // Subcategory header (only show if more than one subcat present)
            if (subOrder.length > 1 && sub) {
                const hdr = document.createElement('li');
                hdr.className = 'ds-subcat-header';
                hdr.textContent = sub;
                ul.appendChild(hdr);
            }

            for (const e of bySub[sub]) {
                const isImpl = _hasProducts(e.id);
                const li = document.createElement('li');
                li.className = 'ds-dataset-item' +
                    (isImpl ? ' ds-implemented' : ' ds-unimplemented') +
                    (e.id === _selId ? ' selected' : '');
                li.dataset.id = e.id;

                li.innerHTML =
                    `<span class="ds-ds-indicator">${isImpl ? '&#9679;' : '&#9675;'}</span>` +
                    `<span class="ds-ds-name">${e.name}</span>`;

                li.addEventListener('click', () => {
                    _selId = e.id;
                    // re-highlight list without full re-render
                    ul.querySelectorAll('.ds-dataset-item').forEach(el => {
                        el.classList.toggle('selected', el.dataset.id === _selId);
                    });
                    _renderInfo();
                    _overlay.querySelector('#ds-load-btn').disabled = !isImpl;
                });

                // Double-click to immediately load if implemented
                if (isImpl) {
                    li.addEventListener('dblclick', () => {
                        _selId = e.id;
                        _handleLoad();
                    });
                }

                ul.appendChild(li);
            }
        }
    }

    // ------------------------------------------------------------------
    // Render metadata panel
    // ------------------------------------------------------------------
    function _renderInfo() {
        const panel = _overlay.querySelector('#ds-info-content');
        const status = _overlay.querySelector('#ds-status');

        if (!_selId) {
            panel.innerHTML = '<p class="ds-info-placeholder">Select a dataset to see its details.</p>';
            status.textContent = '';
            return;
        }

        const e      = _entries.find(en => en.id === _selId);
        const isImpl = _hasProducts(e.id);

        status.textContent = isImpl ? '' : 'Not yet implemented';
        status.className   = isImpl ? '' : 'ds-status-warn';

        const freq = e.temporal_frequency_min != null
            ? (e.temporal_frequency_min >= 60
                ? `${e.temporal_frequency_min / 60}h`
                : `${e.temporal_frequency_min}min`)
            : '—';

        const range = e.time_range_hr != null ? `${e.time_range_hr}h` : '—';

        let gridHtml = '—';
        if (e.grid) {
            const g = e.grid;
            if (g.type === 'latlon') {
                gridHtml = `${g.type} ${g.nx}&times;${g.ny}`;
            } else if (g.type === 'lambert') {
                gridHtml = `${g.type} ${g.nx}&times;${g.ny}, ${g.dx_m}m`;
            } else {
                gridHtml = g.type;
            }
        }

        const pathHtml = '<em>Managed by API</em>';

        const tagsHtml = (e.tags || [])
            .map(t => `<span class="ds-tag">${t}</span>`).join(' ');

        // Reset cycle selection on every new dataset pick
        _selCycleTime = null;
        const cyclePickerHtml = e.has_forecast_hour ? `
<div class="ds-info-path-label" style="margin-top:0.8em">Model Cycle:</div>
<div id="ds-cycle-row">
  <select id="ds-cycle-sel" disabled><option value="">(probing&#8230;)</option></select>
</div>` : '';

        panel.innerHTML = `
<div class="ds-info-name">${e.name}</div>
<div class="ds-info-sub">${(e.category || '')} / ${(e.subcategory || '')}</div>
<p class="ds-info-desc">${e.description}</p>
<table class="ds-info-table">
  <tr><td>Update freq.</td><td>${freq}</td></tr>
  <tr><td>Time range</td><td>${range}</td></tr>
  <tr><td>Fcst hours</td><td>${e.has_forecast_hour ? 'Yes' : 'No'}</td></tr>
  <tr><td>Format</td><td>${e.data_format || '—'} ${e.dtype ? '/ ' + e.dtype : ''}</td></tr>
  <tr><td>Grid</td><td>${gridHtml}</td></tr>
  <tr><td>Category</td><td>${e.subcategory || '—'}</td></tr>
</table>
${cyclePickerHtml}
<div class="ds-info-path-label">Path template:</div>
${pathHtml}
<div class="ds-info-tags">${tagsHtml}</div>`;

        // If this is a forecast dataset, asynchronously populate the cycle picker
        if (e.has_forecast_hour) {
            const token = ++_cycleProbeToken;
            _probeCyclesFromAPI(e, token).then(cycles => {
                if (!cycles) return; // stale or probing error
                const sel = _overlay.querySelector('#ds-cycle-sel');
                if (!sel) return; // user navigated away
                sel.innerHTML = '';
                if (!cycles.length) {
                    const opt = document.createElement('option');
                    opt.value = '';
                    opt.textContent = '(no cycles found)';
                    sel.appendChild(opt);
                    sel.disabled = true;
                    return;
                }
                cycles.forEach((cycle, i) => {
                    const opt = document.createElement('option');
                    opt.value = cycle.toISOString();
                    opt.textContent = _fmtCycleLabel(cycle);
                    if (i === 0) opt.selected = true;
                    sel.appendChild(opt);
                });
                sel.disabled = false;
                // If editing an existing source, pre-select its cycle; else default to latest
                let defaultCycle = cycles[0];
                if (_preselCycleTime) {
                    const preselIso = _preselCycleTime.toISOString();
                    const match = cycles.find(c => c.toISOString() === preselIso);
                    if (match) defaultCycle = match;
                    _preselCycleTime = null;
                }
                _selCycleTime = defaultCycle;
                sel.value = defaultCycle.toISOString();
                sel.addEventListener('change', () => {
                    _selCycleTime = sel.value ? new Date(sel.value) : null;
                });
            });
        }
    }

    // END RENDERING FUNCTION SECTION

    // ------------------------------------------------------------------
    // Open / close
    // ------------------------------------------------------------------
    function _close() {
        if (_overlay) _overlay.style.display = 'none';
    }

    function _handleLoad() {
        if (!_selId || !_hasProducts(_selId)) return;
        const entry = _entries.find(en => en.id === _selId);
        // For forecast datasets pass the selected cycle time; non-forecast pass null
        const cycleTime = (entry && entry.has_forecast_hour) ? _selCycleTime : null;
        _close();
        if (typeof _onLoad === 'function') _onLoad(_selId, cycleTime);
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    return {
        /**
         * Build the dialog DOM.  Call once after DOMContentLoaded.
         * (Store must have sources populated first.)
         */
        init() {
            _entries = _mapSources(getState().sources || []);
            _overlay = _buildDOM();
            _overlay.style.display = 'none';
        },

        /**
         * Open the selector dialog.
         * @param {Function} onLoad   callback(id, cycleTime) called when user clicks Load
         * @param {Object}  [presel]  optional pre-selection: { id, cycleTime }
         *                            When provided the dialog opens with that dataset
         *                            already highlighted (and its cycle pre-selected).
         */
        open(onLoad, presel) {
            _onLoad = onLoad;
            _entries = _mapSources(getState().sources || []);   // refresh from API store

            // Reset selection
            _selCycleTime    = null;
            _preselCycleTime = null;
            ++_cycleProbeToken; // cancel any in-flight cycle probe
            _overlay.querySelector('#ds-search').value = '';
            _overlay.querySelector('#ds-search-clear').style.display = 'none';
            _overlay.querySelector('#ds-status').textContent = '';

            if (presel && presel.id) {
                // Pre-select the provided dataset
                const entry = _entries.find(e => e.id === presel.id);
                _selId  = presel.id;
                _selCat = entry ? entry.category : null;
                if (presel.cycleTime instanceof Date) {
                    _preselCycleTime = presel.cycleTime;
                }
                _overlay.querySelector('#ds-load-btn').disabled = !_hasProducts(presel.id);
            } else {
                _selCat = null;
                _selId  = null;
                _overlay.querySelector('#ds-load-btn').disabled = true;
            }

            _renderCategories();
            _renderDatasetList();
            _renderInfo();

            _overlay.style.display = 'flex';
            // Focus search only when opening fresh (not pre-selected)
            if (!presel) _overlay.querySelector('#ds-search').focus();
        },
    };
})();

window.DataSelector = DataSelector;
