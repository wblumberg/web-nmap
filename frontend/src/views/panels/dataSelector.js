/**
 * dataSelector.js — Dataset Selector Dialog for web-nmap
 *
 * Three-level hierarchical picker:
 *
 *   Column 1: Data Category (MODEL_DET, SATELLITE, RADAR_MOSAIC, …)
 *             grouped by source_type from the catalog API.
 *             Within each category, sources are collapsed under their
 *             source_group (e.g. "GOES-E", "MRMS").
 *
 *   Column 2: Products available for the selected source_group / source_id,
 *             organised by product group tag (goes_conus, basic, shear, …).
 *
 *   Column 3: INFO panel — metadata about the selected data source and,
 *             once a product is selected, details about that product.
 *             For forecast sources a cycle-time picker is shown here.
 *
 * Callback signature (unchanged from previous version):
 *   onLoad(sourceId, productKey, cycleTime)
 *     sourceId   — backend source_id string
 *     productKey — PRODUCT_SUITES key (e.g. 'goes_conus_wv'), or null
 *     cycleTime  — Date for forecast sources, otherwise null
 */

import { getState } from '../../app/store.js';
import * as CatalogClient from '../../services/api/catalogClient.js';
import { PRODUCT_SUITES, PRODUCT_GROUPS } from '../../domain/dataProducts/productIndex.js';

export const DataSelector = (() => {
    'use strict';

    // ─── state ────────────────────────────────────────────────────────
    let _onLoad          = null;   // callback(sourceId, productKey, cycleTime)
    let _overlay         = null;
    let _apiSources      = [];     // raw objects from catalog API

    // Column-1 selection
    let _selCatKey       = null;   // source_type key, e.g. 'SATELLITE'
    let _selGroupKey     = null;   // source_group, e.g. 'GOES-E'
    let _selRegionKey    = null;   // region sub-group within a group, e.g. 'CONUS'
    let _selSourceId     = null;   // specific source_id, e.g. 'GOES-E_CONUS_C08'

    // Column-2 selection
    let _selProductKey   = null;   // PRODUCT_SUITES key

    // Forecast cycle state
    let _selCycleTime    = null;
    let _cycleProbeToken = 0;
    let _preselCycleTime = null;

    // Search
    let _searchQuery     = '';

    // ─── constants ────────────────────────────────────────────────────
    const CAT_LABEL = {
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

    const CAT_ORDER = [
        'MODEL_DET','MODEL_ENS','ANALYSIS',
        'SATELLITE','RADAR_MOSAIC','RADAR_NEXRAD',
        'OBS_UPPERAIR','OBS_SURFACE','MISC',
    ];

    // Friendly display labels for multi-source groups that don't expose a label
    // on the individual sources (e.g., "GOES-E" → "GOES-East").
    const GROUP_LABEL = {
        'MRMS':   'MRMS',
        'GOES-E': 'GOES-East',
        'GOES-W': 'GOES-West',
    };

    // ─── helpers ──────────────────────────────────────────────────────

    /** Products whose available_for includes at least one source in a set. */
    function _productsForSources(sourceIds) {
        const idSet = new Set(sourceIds);
        return Object.entries(PRODUCT_SUITES).filter(([, p]) =>
            Array.isArray(p.available_for) && p.available_for.some(id => idSet.has(id))
        );
    }

    /** All source_ids that belong to a given source_group. */
    function _sourcesInGroup(groupKey) {
        return _apiSources
            .filter(s => (s.source_group || s.source_id) === groupKey)
            .map(s => s.source_id);
    }

    /**
     * Unique region values within a group (from sources' regions[0] field),
     * preserving first-seen order.  Returns [] for groups with no region tags.
     */
    function _regionsInGroup(groupKey) {
        const seen = new Set();
        const out  = [];
        for (const s of _apiSources) {
            if ((s.source_group || s.source_id) !== groupKey) continue;
            const region = s.regions && s.regions.length ? s.regions[0] : null;
            if (region && !seen.has(region)) { seen.add(region); out.push(region); }
        }
        return out;
    }

    /** All source_ids in a group that belong to a specific region. */
    function _sourcesInGroupRegion(groupKey, regionKey) {
        return _apiSources
            .filter(s =>
                (s.source_group || s.source_id) === groupKey &&
                Array.isArray(s.regions) && s.regions.includes(regionKey)
            )
            .map(s => s.source_id);
    }

    /** Unique source_groups within a category, preserving first-seen order. */
    function _groupsInCat(catKey) {
        const seen = new Set();
        const out  = [];
        for (const s of _apiSources) {
            if (s.source_type !== catKey) continue;
            const g = s.source_group || s.source_id;
            if (!seen.has(g)) { seen.add(g); out.push(g); }
        }
        return out;
    }

    /** A friendly display label for a source_group. */
    function _groupLabel(groupKey) {
        // 1. Static friendly map (e.g. "GOES-E" → "GOES-East")
        if (GROUP_LABEL[groupKey]) return GROUP_LABEL[groupKey];
        const src = _apiSources.find(s => (s.source_group || s.source_id) === groupKey);
        if (!src) return groupKey;
        // 2. Explicit group label from API
        if (src.source_group_label) return src.source_group_label;
        // 3. Single-source groups: the group key equals the source_id, so
        //    use the human-readable label from the API (e.g. "ECMWF IFS",
        //    "Hourly Mesoanalysis Grids") rather than the raw source_id.
        if (!src.source_group || src.source_group === src.source_id) return src.label;
        return groupKey;
    }

    /** Count of sources in a group that have at least one registered product. */
    function _implCountInGroup(groupKey) {
        const ids = _sourcesInGroup(groupKey);
        return ids.filter(id =>
            Object.values(PRODUCT_SUITES).some(p =>
                Array.isArray(p.available_for) && p.available_for.includes(id)
            )
        ).length;
    }

    /** Is there any registered product for this exact source_id? */
    function _sourceHasProducts(sourceId) {
        return Object.values(PRODUCT_SUITES).some(p =>
            Array.isArray(p.available_for) && p.available_for.includes(sourceId)
        );
    }

    /** Apply search query against a source or product label. */
    function _matches(text) {
        if (!_searchQuery) return true;
        return text.toLowerCase().includes(_searchQuery);
    }

    /** Whether the LOAD button should be enabled given current state. */
    function _canLoad() {
        if (!_selSourceId) return false;
        if (_selProductKey) return true;
        // no product selected yet → only enable if at least one product exists for this source
        return _sourceHasProducts(_selSourceId);
    }

    // ─── DOM build ────────────────────────────────────────────────────
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
    <input id="ds-search" type="text" placeholder="Search datasets and products&#8230;" autocomplete="off" spellcheck="false" />
    <span id="ds-search-clear" title="Clear">&#10005;</span>
  </div>
  <div id="ds-panels">
    <div id="ds-cat-panel">
      <div class="ds-panel-header">DATA SOURCE</div>
      <ul id="ds-cat-list"></ul>
    </div>
    <div id="ds-prod-panel">
      <div class="ds-panel-header">PRODUCTS <span id="ds-prod-count"></span></div>
      <ul id="ds-prod-list"></ul>
    </div>
    <div id="ds-info-panel">
      <div class="ds-panel-header">INFO</div>
      <div id="ds-info-content">
        <p class="ds-info-placeholder">Select a data source.</p>
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

        overlay.querySelector('#ds-close').addEventListener('click', _close);
        overlay.querySelector('#ds-cancel-btn').addEventListener('click', _close);
        overlay.querySelector('#ds-load-btn').addEventListener('click', _handleLoad);
        overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });

        const searchInput = overlay.querySelector('#ds-search');
        const searchClear = overlay.querySelector('#ds-search-clear');
        searchInput.addEventListener('input', () => {
            _searchQuery = searchInput.value.trim().toLowerCase();
            searchClear.style.display = _searchQuery ? 'flex' : 'none';
            // In search mode collapse all group selections to show broad results
            _renderSourcePanel();
            _renderProductPanel();
            _renderInfo();
        });
        searchClear.addEventListener('click', () => {
            searchInput.value = '';
            _searchQuery = '';
            searchClear.style.display = 'none';
            _renderSourcePanel();
            _renderProductPanel();
            _renderInfo();
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && overlay.style.display !== 'none' && overlay.style.display !== '')
                _close();
        });

        return overlay;
    }

    // ─── cycle picker helpers ─────────────────────────────────────────
    async function _probeCyclesFromAPI(sourceId, token) {
        const src = _apiSources.find(s => s.source_id === sourceId);
        if (!src || !(src.has_fhrs || src.has_cycles)) return null;
        try {
            const cyclesData = await CatalogClient.listCycles(sourceId, { limit: 20 });
            if (token !== _cycleProbeToken) return null;
            return cyclesData
                .map(c => new Date(c.cycle_time))
                .filter(d => Number.isFinite(d.getTime()));
        } catch (err) {
            console.warn(`[DataSelector] cycle probe failed for "${sourceId}":`, err);
            return null;
        }
    }

    function _fmtCycleLabel(dt) {
        const pad = n => String(n).padStart(2, '0');
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
        return `${pad(dt.getUTCDate())} ${mon} ${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:00 UTC`;
    }

    // ─── Column 1: source panel ───────────────────────────────────────
    function _renderSourcePanel() {
        const ul = _overlay.querySelector('#ds-cat-list');
        ul.innerHTML = '';

        // In search mode show a flat list of matching sources across all categories
        if (_searchQuery) {
            _renderSourcePanelSearch(ul);
            return;
        }

        for (const cat of CAT_ORDER) {
            const groups = _groupsInCat(cat);
            if (!groups.length) continue;

            // Category header row
            const hdr = document.createElement('li');
            hdr.className = 'ds-cat-header';
            hdr.innerHTML = `<span class="ds-cat-header-label">${CAT_LABEL[cat] || cat}</span>`;
            ul.appendChild(hdr);

            for (const grp of groups) {
                const hasImpl = _implCountInGroup(grp) > 0;
                const isSelGroup   = _selGroupKey  === grp;
                const isSelCat     = _selCatKey    === cat;
                const sources      = _sourcesInGroup(grp);
                const isSingleSrc  = sources.length === 1;

                const li = document.createElement('li');
                li.className = 'ds-group-item'
                    + (isSelGroup ? ' selected' : '')
                    + (hasImpl ? ' ds-implemented' : ' ds-unimplemented');
                li.dataset.group = grp;
                li.dataset.cat   = cat;

                li.innerHTML =
                    `<span class="ds-ds-indicator">${hasImpl ? '&#9679;' : '&#9675;'}</span>` +
                    `<span class="ds-group-label">${_groupLabel(grp)}</span>`;

                li.addEventListener('click', () => {
                    _selCatKey    = cat;
                    _selGroupKey  = grp;
                    _selRegionKey = null;  // reset region when group changes
                    // If this group has exactly one source, auto-select it
                    _selSourceId  = isSingleSrc ? sources[0] : null;
                    _selProductKey = null;
                    _selCycleTime  = null;
                    ++_cycleProbeToken;
                    _renderSourcePanel();
                    _renderProductPanel();
                    _renderInfo();
                    _overlay.querySelector('#ds-load-btn').disabled = !_canLoad();
                });

                ul.appendChild(li);

                // If this group is selected and has multiple sources, expand them inline.
                // For groups with region tags (MRMS, GOES-E/W), show regions as sub-items.
                // Otherwise fall back to showing individual source_ids.
                if (isSelGroup && !isSingleSrc) {
                    const regions = _regionsInGroup(grp);
                    if (regions.length > 0) {
                        // ── Region sub-items ──
                        for (const region of regions) {
                            const regionSourceIds = _sourcesInGroupRegion(grp, region);
                            const hasP = regionSourceIds.some(id => _sourceHasProducts(id));
                            const subLi = document.createElement('li');
                            subLi.className = 'ds-source-sub-item'
                                + (region === _selRegionKey ? ' selected' : '')
                                + (hasP ? ' ds-implemented' : ' ds-unimplemented');
                            subLi.dataset.region = region;
                            subLi.innerHTML =
                                `<span class="ds-ds-indicator">${hasP ? '&#9679;' : '&#9675;'}</span>` +
                                `<span class="ds-source-sub-label">${region}</span>`;
                            subLi.addEventListener('click', e => {
                                e.stopPropagation();
                                _selRegionKey  = region;
                                _selSourceId   = null;  // resolved when a product is picked
                                _selProductKey = null;
                                _selCycleTime  = null;
                                ++_cycleProbeToken;
                                ul.querySelectorAll('.ds-source-sub-item').forEach(el =>
                                    el.classList.toggle('selected', el.dataset.region === region)
                                );
                                _renderProductPanel();
                                _renderInfo();
                                _overlay.querySelector('#ds-load-btn').disabled = !_canLoad();
                            });
                            ul.appendChild(subLi);
                        }
                    } else {
                        // ── Individual source sub-items (legacy / non-region groups) ──
                        for (const srcId of sources) {
                            const hasP = _sourceHasProducts(srcId);
                            const src  = _apiSources.find(s => s.source_id === srcId);
                            const subLi = document.createElement('li');
                            subLi.className = 'ds-source-sub-item'
                                + (srcId === _selSourceId ? ' selected' : '')
                                + (hasP ? ' ds-implemented' : ' ds-unimplemented');
                            subLi.dataset.srcId = srcId;
                            subLi.innerHTML =
                                `<span class="ds-ds-indicator">${hasP ? '&#9679;' : '&#9675;'}</span>` +
                                `<span class="ds-source-sub-label">${src ? src.label : srcId}</span>`;
                            subLi.addEventListener('click', e => {
                                e.stopPropagation();
                                _selSourceId   = srcId;
                                _selRegionKey  = null;
                                _selProductKey = null;
                                _selCycleTime  = null;
                                ++_cycleProbeToken;
                                ul.querySelectorAll('.ds-source-sub-item').forEach(el =>
                                    el.classList.toggle('selected', el.dataset.srcId === srcId)
                                );
                                _renderProductPanel();
                                _renderInfo();
                                _overlay.querySelector('#ds-load-btn').disabled = !_canLoad();
                            });
                            ul.appendChild(subLi);
                        }
                    }
                }  // end if (isSelGroup && !isSingleSrc)
            }
        }
    }

    function _renderSourcePanelSearch(ul) {
        // Flat filtered list — search across source labels
        const matched = _apiSources.filter(s =>
            _matches(s.label) || _matches(s.source_id) || _matches(s.source_group || '')
        );
        if (!matched.length) {
            const li = document.createElement('li');
            li.className = 'ds-no-results';
            li.textContent = 'No sources match.';
            ul.appendChild(li);
            return;
        }
        for (const src of matched) {
            const hasP = _sourceHasProducts(src.source_id);
            const li = document.createElement('li');
            li.className = 'ds-group-item'
                + (src.source_id === _selSourceId ? ' selected' : '')
                + (hasP ? ' ds-implemented' : ' ds-unimplemented');
            li.dataset.srcId = src.source_id;
            li.innerHTML =
                `<span class="ds-ds-indicator">${hasP ? '&#9679;' : '&#9675;'}</span>` +
                `<span class="ds-group-label">${src.label}</span>`;
            li.addEventListener('click', () => {
                _selSourceId   = src.source_id;
                _selGroupKey   = src.source_group || src.source_id;
                _selCatKey     = src.source_type;
                _selRegionKey  = null;
                _selProductKey = null;
                _selCycleTime  = null;
                ++_cycleProbeToken;
                _renderSourcePanel();
                _renderProductPanel();
                _renderInfo();
                _overlay.querySelector('#ds-load-btn').disabled = !_canLoad();
            });
            ul.appendChild(li);
        }
    }

    // ─── Column 2: product panel ──────────────────────────────────────
    function _renderProductPanel() {
        const ul      = _overlay.querySelector('#ds-prod-list');
        const counter = _overlay.querySelector('#ds-prod-count');
        ul.innerHTML  = '';

        // Determine which source_ids feed this panel.
        // Priority: explicit source > region sub-group > full group > nothing.
        let sourceIds = [];
        if (_selSourceId) {
            sourceIds = [_selSourceId];
        } else if (_selRegionKey && _selGroupKey) {
            sourceIds = _sourcesInGroupRegion(_selGroupKey, _selRegionKey);
        } else if (_selGroupKey) {
            sourceIds = _sourcesInGroup(_selGroupKey);
        }

        if (!sourceIds.length && !_searchQuery) {
            counter.textContent = '';
            const li = document.createElement('li');
            li.className = 'ds-no-results';
            li.textContent = 'Select a data source.';
            ul.appendChild(li);
            return;
        }

        // In search mode also search product labels
        let products;
        if (_searchQuery) {
            // Union of products for selected sources + any product matching
            // the query regardless of source (cross-search)
            const fromSource = sourceIds.length ? _productsForSources(sourceIds) : [];
            const fromQuery  = Object.entries(PRODUCT_SUITES).filter(([k, p]) =>
                _matches(p.label || k) || _matches(p.group || '')
            );
            // Deduplicate
            const seen = new Set(fromSource.map(([k]) => k));
            const combined = [...fromSource];
            for (const entry of fromQuery) {
                if (!seen.has(entry[0])) { seen.add(entry[0]); combined.push(entry); }
            }
            products = combined;
        } else {
            products = _productsForSources(sourceIds);
        }

        if (!products.length) {
            counter.textContent = '';
            const li = document.createElement('li');
            li.className = 'ds-no-results';
            li.textContent = 'No products available.';
            ul.appendChild(li);
            return;
        }

        // Group by product.group
        const byGroup  = new Map();
        const grpOrder = [];
        for (const [key, prod] of products) {
            const g = prod.group || 'misc';
            if (!byGroup.has(g)) { byGroup.set(g, []); grpOrder.push(g); }
            byGroup.get(g).push([key, prod]);
        }

        counter.textContent = `(${products.length})`;

        for (const grp of grpOrder) {
            const grpLabel = PRODUCT_GROUPS[grp] || grp;

            const hdr = document.createElement('li');
            hdr.className = 'ds-prod-group-header';
            hdr.textContent = grpLabel;
            ul.appendChild(hdr);

            for (const [key, prod] of byGroup.get(grp)) {
                const li = document.createElement('li');
                li.className = 'ds-prod-item' + (key === _selProductKey ? ' selected' : '');
                li.dataset.key = key;
                li.innerHTML =
                    `<span class="ds-prod-indicator">&#9654;</span>` +
                    `<span class="ds-prod-label">${prod.label || key}</span>`;

                li.addEventListener('click', () => {
                    _selProductKey = key;
                    // When a product is picked, resolve which source_id to use.
                    // Prefer already-selected source_id if it's compatible.
                    // If a region sub-group is active, restrict candidates to that region.
                    if (!_selSourceId || !prod.available_for.includes(_selSourceId)) {
                        const regionCandidates = (_selRegionKey && _selGroupKey)
                            ? _sourcesInGroupRegion(_selGroupKey, _selRegionKey)
                            : null;
                        const firstMatch = (prod.available_for || []).find(id => {
                            if (!_apiSources.some(s => s.source_id === id)) return false;
                            if (regionCandidates) return regionCandidates.includes(id);
                            return true;
                        });
                        if (firstMatch) {
                            _selSourceId  = firstMatch;
                            const src = _apiSources.find(s => s.source_id === firstMatch);
                            if (src) {
                                _selGroupKey = src.source_group || src.source_id;
                                _selCatKey   = src.source_type;
                            }
                        }
                    }
                    ul.querySelectorAll('.ds-prod-item').forEach(el =>
                        el.classList.toggle('selected', el.dataset.key === key)
                    );
                    _renderInfo();
                    _overlay.querySelector('#ds-load-btn').disabled = !_canLoad();
                });

                li.addEventListener('dblclick', () => {
                    _selProductKey = key;
                    _handleLoad();
                });

                ul.appendChild(li);
            }
        }
    }

    // ─── Column 3: info panel ─────────────────────────────────────────
    function _renderInfo() {
        const panel  = _overlay.querySelector('#ds-info-content');
        const status = _overlay.querySelector('#ds-status');

        const src  = _selSourceId ? _apiSources.find(s => s.source_id === _selSourceId) : null;
        const prod = _selProductKey ? PRODUCT_SUITES[_selProductKey] : null;

        if (!src && !prod) {
            panel.innerHTML = '<p class="ds-info-placeholder">Select a data source.</p>';
            status.textContent = '';
            return;
        }

        const hasForecast = src && !!(src.has_fhrs || src.has_cycles);

        status.textContent = '';
        status.className   = '';

        // Cycle picker HTML — injected only for forecast sources
        const cyclePickerHtml = hasForecast ? `
<div class="ds-info-section-label" style="margin-top:0.8em">Model Cycle</div>
<div id="ds-cycle-row">
  <select id="ds-cycle-sel" disabled><option value="">(probing&#8230;)</option></select>
</div>` : '';

        // Product detail section
        const prodHtml = prod ? `
<div class="ds-info-section-label" style="margin-top:1em">Selected Product</div>
<div class="ds-info-prod-name">${prod.label || _selProductKey}</div>
<div class="ds-info-prod-meta">
  Group: <span class="ds-info-prod-group">${PRODUCT_GROUPS[prod.group] || prod.group || '—'}</span>
</div>
<div class="ds-info-prod-meta">
  Data keys: <code>${(prod.data_keys || []).join(', ')}</code>
</div>` : '';

        panel.innerHTML = src ? `
<div class="ds-info-name">${src.label}</div>
<div class="ds-info-sub">${CAT_LABEL[src.source_type] || src.source_type || ''}${src.source_group && src.source_group !== src.source_id ? ' &rsaquo; ' + src.source_group : ''}</div>
<table class="ds-info-table">
  <tr><td>Source ID</td><td><code>${src.source_id}</code></td></tr>
  <tr><td>Category</td><td>${src.data_category || '—'}</td></tr>
  <tr><td>Forecast</td><td>${hasForecast ? 'Yes' : 'No'}</td></tr>
  <tr><td>Regions</td><td>${(src.regions || []).join(', ') || '—'}</td></tr>
</table>
${cyclePickerHtml}
${prodHtml}` : `
<p class="ds-info-placeholder" style="margin-top:0">
  Product: <strong>${prod ? (prod.label || _selProductKey) : '—'}</strong><br>
  Select a data source to load it.
</p>`;

        // Async cycle picker population
        if (hasForecast) {
            _selCycleTime = null;
            const token = ++_cycleProbeToken;
            _probeCyclesFromAPI(_selSourceId, token).then(cycles => {
                if (!cycles) return;
                const sel = _overlay.querySelector('#ds-cycle-sel');
                if (!sel) return;
                sel.innerHTML = '';
                if (!cycles.length) {
                    sel.innerHTML = '<option value="">(no cycles found)</option>';
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
                let defaultCycle = cycles[0];
                if (_preselCycleTime) {
                    const iso = _preselCycleTime.toISOString();
                    const match = cycles.find(c => c.toISOString() === iso);
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

    // ─── load / close ─────────────────────────────────────────────────
    function _close() {
        if (_overlay) _overlay.style.display = 'none';
    }

    function _handleLoad() {
        if (!_canLoad()) return;
        const src = _apiSources.find(s => s.source_id === _selSourceId);
        const hasForecast = src && !!(src.has_fhrs || src.has_cycles);
        const cycleTime = hasForecast ? _selCycleTime : null;
        _close();
        if (typeof _onLoad === 'function')
            _onLoad(_selSourceId, _selProductKey, cycleTime);
    }

    // ─── public API ───────────────────────────────────────────────────
    return {
        /**
         * Build the dialog DOM. Call once after DOMContentLoaded.
         */
        init() {
            _apiSources = getState().sources || [];
            _overlay    = _buildDOM();
            _overlay.style.display = 'none';
        },

        /**
         * Open the selector dialog.
         * @param {Function} onLoad  callback(sourceId, productKey, cycleTime)
         * @param {Object}  [presel] optional { id, cycleTime } to pre-select
         */
        open(onLoad, presel) {
            _onLoad     = onLoad;
            _apiSources = getState().sources || [];

            // Reset transient state
            _searchQuery     = '';
            _selCycleTime    = null;
            _preselCycleTime = null;
            ++_cycleProbeToken;
            _overlay.querySelector('#ds-search').value = '';
            _overlay.querySelector('#ds-search-clear').style.display = 'none';
            _overlay.querySelector('#ds-status').textContent = '';

            if (presel && presel.id) {
                const src = _apiSources.find(s => s.source_id === presel.id);
                _selSourceId  = presel.id;
                _selGroupKey  = src ? (src.source_group || src.source_id) : null;
                _selCatKey    = src ? src.source_type : null;
                _selRegionKey = null;
                _selProductKey = presel.productKey || null;
                if (presel.cycleTime instanceof Date) _preselCycleTime = presel.cycleTime;
                _overlay.querySelector('#ds-load-btn').disabled = !_canLoad();
            } else {
                _selCatKey     = null;
                _selGroupKey   = null;
                _selRegionKey  = null;
                _selSourceId   = null;
                _selProductKey = null;
                _overlay.querySelector('#ds-load-btn').disabled = true;
            }

            _renderSourcePanel();
            _renderProductPanel();
            _renderInfo();

            _overlay.style.display = 'flex';
            if (!presel) _overlay.querySelector('#ds-search').focus();
        },
    };
})();

window.DataSelector = DataSelector;
