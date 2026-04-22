/**
 * layermanager.js — Data Layer Manager for web-nmap
 *
 * Inspired by GEMPAK NMAP2's "Add/Edit Data Source" dialog.
 * Manages a stack of simultaneous data sources on the map, time-matching
 * settings, and provides a mini-timeline of computed frame times.
 *
 * Usage:
 *   LayerManager.init();
 *   LayerManager.open(onApply);
 *
 * onApply is called with:
 *   {
 *     sources:     [{ uid, id, name, color, entry }, ...],  // render order (bottom → top)
 *     dominantId:  string,   // catalog id of the dominant (time-master) source
 *     numFrames:   number,
 *     frameSkip:   number,
 *     frames:      Date[],   // computed valid times newest→oldest (frames[0] = latest)
 *   }
 */

// This module handles both the "view" and the "controller" for the layer manager dialog.


import { DataSelector } from "./dataSelector.js";
import { getState } from '../../app/store.js';
import * as CatalogClient from '../../services/api/catalogClient.js';

export const LayerManager = (() => {
    'use strict';

    // ------------------------------------------------------------------------
    // Tiny scoped logger to debug and inform about LayerManager state changes
    // ------------------------------------------------------------------------
    const LM = {
        tag: '%c[LM]%c',
        css: ['color:#4a9eff;font-weight:bold', 'color:inherit'],
        info (msg, ...a) { console.info( this.tag + ' ' + msg, ...this.css, ...a); },
        debug(msg, ...a) { console.debug(this.tag + ' ' + msg, ...this.css, ...a); },
        warn (msg, ...a) { console.warn( this.tag + ' ' + msg, ...this.css, ...a); },
    };

    // ------------------------------------------------------------------
    // Persistent state (survives dialog close/open cycles)
    // ------------------------------------------------------------------
    let _sources      = [];     // [{ uid, id, name, color, entry }]
    let _dominantId   = null;   // catalog id of dominant source
    let _numFrames    = 12;     // Number of frames to show in the timeline
    let _frameSkip    = 1;      // Number of frames to skip in the dominant data source
    let _onApply      = null;   // callback to call when user clicks "Apply"
    let _editingUid   = null;   // uid being replaced via "Edit Source"
    let _overlay      = null;   // DOM overlay for the layer manager dialog
    let _uidCounter   = 0;      // Incrementing counter for assigning unique IDs to sources

    // PROBE STATE - this is the action that actually queries the data store
    // for available frames and builds the timeline.
    let _allFrames    = [];     // ALL found frames from last probe (newest first)
    let _probedFrames = [];     // selected subset after applying numFrames / frameSkip
    let _probing      = false;  // true while HEAD requests are in flight
    let _probeToken   = 0;      // incremented to cancel stale probe results
    let _probeTimer   = null;   // debounce timer handle

    // Visible timeline range (set by Range/Int dialog; null = auto from allFrames)
    let _rangeStart       = null;  // Date | null — left edge of visible timeline
    let _rangeEnd         = null;  // Date | null — right edge of visible timeline
    let _rangeIntervalMin = null;  // number | null — min minutes between selected frames

    // Draggable selection-window box (time-coordinate based)
    let _selWindowStart   = null;  // Date | null — left edge of red box (null = auto-newest)
    let _tlPxPerMs        = 0;     // pixels-per-ms (set during render, used by drag)
    let _dragStartX       = 0;     // mouse X at drag begin
    let _dragStartWSms    = 0;     // window start in ms at drag begin

    // ------------------------------------------------------------------
    // Color palette auto-assigned to sources
    // ------------------------------------------------------------------
    const PALETTE = [
        '#4a9eff', '#ff7f4a', '#55d46a', '#ff4ab0',
        '#ffe04a', '#bf4aff', '#4ae0d4', '#ff5555',
    ];
    function _nextColor() {
        return PALETTE[_sources.length % PALETTE.length];
    }

    // ------------------------------------------------------------------
    // Helpers for looking up source entries (replaces DataCatalog.byId)
    // ------------------------------------------------------------------

    /**
     * Get the entry object for the current dominant source.
     * Returns null if no dominant is set or not found.
     */
    function _getDomEntry() {
        if (!_dominantId) return null;
        const src = _sources.find(s => s.id === _dominantId);
        return src?.entry || null;
    }

    /**
     * Look up an API source object from the store's sources array
     * and convert to the entry shape used internally.
     */
    function _makeEntry(sourceId) {
        const apiSources = getState().sources || [];
        const apiSrc = apiSources.find(s => s.source_id === sourceId);
        if (!apiSrc) return null;
        return {
            id:               apiSrc.source_id,
            name:             apiSrc.label,
            category:         apiSrc.source_type || apiSrc.data_category || 'MISC',
            subcategory:      apiSrc.data_category || null,
            description:      apiSrc.label,
            endpoint_type:    apiSrc.endpoint_type || 'gridded',
            has_forecast_hour: !!(apiSrc.has_fhrs || apiSrc.has_cycles),
            has_cycles:        !!(apiSrc.has_cycles),
            has_fhrs:          !!(apiSrc.has_fhrs),
            // Defaults for fields no longer in the API
            temporal_frequency_min: null,
            forecast_hr_step:       null,
            default_frame_no:       null,
            default_range_hr:       48,
            max_forecast_hr:        null,
        };
    }

    /**
     * Convert a Date to cycle string format "YYYYMMDDHH" for API calls.
     */
    function _dateToCycleStr(dt) {
        const p = (n, w = 2) => String(n).padStart(w, '0');
        return (
            `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
            `${p(dt.getUTCHours())}`
        );
    }

    // Format a source as CATEGORY / Subcategory / Name (NMAP2-style slash path).
    function _srcLabel(src) {
        const e = src.entry;
        if (!e) return src.name;
        return [e.category, e.subcategory, e.name].filter(Boolean).join(' / ');
    }

    // ------------------------------------------------------------------
    // Build DOM — called only once by init()
    // ------------------------------------------------------------------
    function _buildDOM() {
        const overlay = document.createElement('div');
        overlay.id = 'lm-overlay';
        overlay.innerHTML = `
<div id="lm-dialog">
  <div id="lm-titlebar">
    <span id="lm-title">&#9632; DATA SOURCE MANAGER</span>
    <button id="lm-close" title="Close">&#10005;</button>
  </div>
  <div id="lm-sources">
    <div class="lm-section-hdr">ACTIVE SOURCES</div>
    <ul id="lm-source-list"></ul>
    <div id="lm-source-btns">
      <button class="lm-btn lm-btn-action" id="lm-btn-new">+ New Source</button>
      <button class="lm-btn lm-btn-action" id="lm-btn-edit" disabled>Edit Source</button>
      <button class="lm-btn lm-btn-remove" id="lm-btn-remove" disabled>&#10005; Remove</button>
      <label class="lm-bin-label" title="Bin Source (not yet implemented)"><input type="checkbox" id="lm-bin-check" disabled /> Bin Source</label>
    </div>
  </div>
  <div id="lm-settings">
    <div class="lm-section-hdr">SETTINGS</div>
    <div id="lm-settings-row">
      <div class="lm-setting-group">
        <label class="lm-label">Dominant</label>
        <select id="lm-dominant"></select>
      </div>
      <div class="lm-setting-group">
        <label class="lm-label">Frames</label>
        <div id="lm-frames-control">
          <input id="lm-frames-num" type="number" min="1" max="100" value="12" />
          <input id="lm-frames-slider" type="range" min="1" max="100" value="12" />
          <span id="lm-frames-label">12</span>
        </div>
      </div>
      <div class="lm-setting-group">
        <label class="lm-label">Skip</label>
        <select id="lm-skip">
          <option value="1">1 (none)</option>
          <option value="2">2</option>
          <option value="3">3</option>
          <option value="5">5</option>
          <option value="10">10</option>
        </select>
      </div>
    </div>
    <div id="lm-frame-info"></div>
  </div>
  <div id="lm-timeline-section">
    <div class="lm-section-hdr">
      TIMELINE
      <span id="lm-timeline-range"></span>
      <button class="lm-btn" id="lm-curtime-btn" title="Jump to current time">Current Time</button>
      <button class="lm-btn lm-btn-range" id="lm-range-btn">Range/Int&#8230;</button>
    </div>
    <div id="lm-timeline-scroll">
      <div id="lm-timeline"></div>
    </div>
  </div>
  <div id="lm-footer">
    <span id="lm-footer-status"></span>
    <div id="lm-footer-btns">
      <button class="lm-btn" id="lm-cancel-btn">CANCEL</button>
      <button class="lm-btn lm-btn-apply" id="lm-apply-btn">APPLY</button>
    </div>
  </div>
</div>
<!-- Range / Interval dialog (inside overlay so z-index stacks correctly) -->
<div id="lm-ri-modal" style="display:none">
  <div id="lm-ri-dialog">
    <div class="lm-ri-title">&#9632; RANGE / INTERVAL</div>
    <div class="lm-ri-row">
      <label class="lm-ri-label">Center (UTC)</label>
      <input id="lm-ri-date" type="date" />
      <input id="lm-ri-time" type="time" step="3600" />
      <button class="lm-btn lm-btn-action lm-ri-now-btn" id="lm-ri-now-btn">Now</button>
    </div>
    <div class="lm-ri-row">
      <label class="lm-ri-label">Before center</label>
      <input id="lm-ri-before" type="number" min="0" max="480" value="24" />
      <span class="lm-ri-unit">h</span>
    </div>
    <div class="lm-ri-row">
      <label class="lm-ri-label">After center</label>
      <input id="lm-ri-after" type="number" min="0" max="240" value="0" />
      <span class="lm-ri-unit">h</span>
    </div>
    <div class="lm-ri-row">
      <label class="lm-ri-label">Interval</label>
      <input id="lm-ri-interval" type="number" min="1" max="1440" placeholder="auto" />
      <span class="lm-ri-unit">min</span>
    </div>
    <div class="lm-ri-btns">
      <button class="lm-btn" id="lm-ri-reset-btn">Reset (Auto)</button>
      <button class="lm-btn" id="lm-ri-cancel-btn">Cancel</button>
      <button class="lm-btn lm-btn-apply" id="lm-ri-apply-btn">Apply</button>
    </div>
  </div>
</div>
`;

        document.body.appendChild(overlay);
        overlay.style.display = 'none';

        // Close / cancel / apply
        overlay.querySelector('#lm-close').addEventListener('click', _close);
        overlay.querySelector('#lm-cancel-btn').addEventListener('click', _close);
        overlay.querySelector('#lm-apply-btn').addEventListener('click', _handleApply);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) _close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') _close();
        });

        // Source list selection (delegated)
        overlay.querySelector('#lm-source-list').addEventListener('click', (e) => {
            const li = e.target.closest('.lm-source-item');
            if (!li) return;
            _selectSourceItem(li.dataset.uid);
        });

        // New / Edit / Remove
        overlay.querySelector('#lm-btn-new').addEventListener('click', () => {
            _editingUid = null;
            DataSelector.open(_onDataSelected);
        });
        overlay.querySelector('#lm-btn-edit').addEventListener('click', () => {
            const sel = _getSelectedUid();
            if (!sel) return;
            _editingUid = sel;
            const src = _sources.find(s => s.uid === sel);
            const presel = src ? { id: src.id, productKey: src.productKey || null, cycleTime: src.cycleTime || null } : null;
            DataSelector.open(_onDataSelected, presel);
        });
        overlay.querySelector('#lm-btn-remove').addEventListener('click', _removeSelected);

        // Dominant dropdown
        overlay.querySelector('#lm-dominant').addEventListener('change', (e) => {
            _dominantId    = e.target.value || null;
            _allFrames     = [];   // force full re-probe for new source
            _probedFrames  = [];
            _selWindowStart = null; // reset selection window to newest end
            // If the newly selected dominant has a default frame count, adopt it
            try {
                const domEntry = _getDomEntry();
                if (domEntry && domEntry.default_frame_no) {
                    _numFrames = domEntry.default_frame_no;
                    const numInput = overlay.querySelector('#lm-frames-num');
                    const slider   = overlay.querySelector('#lm-frames-slider');
                    const label    = overlay.querySelector('#lm-frames-label');
                    numInput.value = _numFrames;
                    slider.value   = _numFrames;
                    label.textContent = _numFrames;
                }
            } catch (e) {}
            _scheduleProbe();
        });

        // Frame count — keep num input and slider controlling the width of the
        // time window in sync.
        const numInput = overlay.querySelector('#lm-frames-num');
        const slider   = overlay.querySelector('#lm-frames-slider');
        const label    = overlay.querySelector('#lm-frames-label');

        const _syncFrames = (v) => {
            const max = +(slider.max || 100);
            v = Math.max(1, Math.min(max, +v));
            _numFrames = v;
            numInput.value    = v;
            slider.value      = v;
            label.textContent = v;
            _recomputeSelection();
        };
        numInput.addEventListener('change', () => _syncFrames(numInput.value));
        slider.addEventListener('input',    () => _syncFrames(slider.value));

        // Skip dropdown
        overlay.querySelector('#lm-skip').addEventListener('change', (e) => {
            _frameSkip = +e.target.value;
            _recomputeSelection();
        });

        // Current Time button — reset to auto-newest
        overlay.querySelector('#lm-curtime-btn').addEventListener('click', () => {
            _rangeStart     = null;
            _rangeEnd       = null;
            _selWindowStart = null;   // auto mode → selbox snaps to newest frames
            _updateSliderMax();
            _recomputeSelection();
        });

        // Range / Interval button
        overlay.querySelector('#lm-range-btn').addEventListener('click', _openRangeInt);

        // Range/Int modal controls
        overlay.querySelector('#lm-ri-now-btn').addEventListener('click', () => {
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            overlay.querySelector('#lm-ri-date').value =
                `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())}`;
            overlay.querySelector('#lm-ri-time').value =
                `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
        });
        overlay.querySelector('#lm-ri-cancel-btn').addEventListener('click', () => {
            overlay.querySelector('#lm-ri-modal').style.display = 'none';
        });
        overlay.querySelector('#lm-ri-reset-btn').addEventListener('click', () => {
            _rangeStart       = null;
            _rangeEnd         = null;
            _rangeIntervalMin = null;
            _selWindowStart   = null;
            overlay.querySelector('#lm-ri-modal').style.display = 'none';
            _updateSliderMax();
            _recomputeSelection();
        });
        overlay.querySelector('#lm-ri-apply-btn').addEventListener('click', _applyRangeInt);

        return overlay;
    }

    // ------------------------------------------------------------------
    // DataSelector callback — add a new source or replace an existing one
    // ------------------------------------------------------------------
    function _onDataSelected(id, productKey, cycleTime) {
        const entry = _makeEntry(id);
        if (!entry) return;

        // Only store a cycle time for datasets that actually have forecast hours
        const storedCycle = (entry.has_forecast_hour && cycleTime instanceof Date)
            ? cycleTime : null;

        if (_editingUid !== null) {
            // Replace existing source
            const idx = _sources.findIndex(s => s.uid === _editingUid);
            if (idx !== -1) {
                const old = _sources[idx];
                _sources[idx] = { uid: old.uid, id, name: entry.name, color: old.color, entry, productKey: productKey || null, cycleTime: storedCycle };
                if (_dominantId === old.id) {
                    _dominantId = id;
                    try {
                        const domEntry = _getDomEntry();
                        if (domEntry && domEntry.default_frame_no) {
                            _numFrames = domEntry.default_frame_no;
                            const numInput = _overlay.querySelector('#lm-frames-num');
                            const slider   = _overlay.querySelector('#lm-frames-slider');
                            const label    = _overlay.querySelector('#lm-frames-label');
                            if (numInput && slider && label) {
                                numInput.value = _numFrames;
                                slider.value   = _numFrames;
                                label.textContent = _numFrames;
                            }
                        }
                    } catch (e) {}
                }
                LM.info(`Source replaced → uid=${old.uid} | ${old.id} ⟶ ${id} (${entry.name})`);
            }
            _editingUid = null;
        } else {
            // Add new source
            const uid = ++_uidCounter;
            const color = _nextColor();
            _sources.push({ uid, id, name: entry.name, color, entry, productKey: productKey || null, cycleTime: storedCycle });
            if (_sources.length === 1) {
                _dominantId = id; // auto-assign first dominant
                try {
                    const domEntry = _getDomEntry();
                    if (domEntry && domEntry.default_frame_no) {
                        _numFrames = domEntry.default_frame_no;
                        const numInput = _overlay.querySelector('#lm-frames-num');
                        const slider   = _overlay.querySelector('#lm-frames-slider');
                        const label    = _overlay.querySelector('#lm-frames-label');
                        if (numInput && slider && label) {
                            numInput.value = _numFrames;
                            slider.value   = _numFrames;
                            label.textContent = _numFrames;
                        }
                    }
                } catch (e) {}
            }
            LM.info(`Source added → uid=${uid} | id="${id}" product="${productKey || 'none'}" name="${entry.name}" cycle=${storedCycle ? storedCycle.toISOString() : 'n/a'} dominant=${_dominantId === id}`);
        }

        _renderAll();

        // Return focus to layer manager (DataSelector already closed)
        _overlay.style.display = 'flex';
        // If adding/replacing a source changed the dominant or we auto-assigned one, probe for frames
        if (_dominantId) _scheduleProbe();
    }

    // ------------------------------------------------------------------
    // Dataset/Product selection helpers
    // ------------------------------------------------------------------
    let _selectedUid = null;

    function _getSelectedUid() { return _selectedUid; }

    function _selectSourceItem(uid) {
        uid = uid !== undefined ? +uid : null;
        _selectedUid = uid;
        _overlay.querySelectorAll('.lm-source-item').forEach(li => {
            li.classList.toggle('selected', +li.dataset.uid === uid);
        });
        const hasSel = uid !== null;
        _overlay.querySelector('#lm-btn-edit').disabled   = !hasSel;
        _overlay.querySelector('#lm-btn-remove').disabled = !hasSel;
    }

    // Remove a selected data source from the list of data sources.
    function _removeSelected() {
        if (_selectedUid === null) return;
        const removedSrc = _sources.find(s => s.uid === _selectedUid);
        _sources = _sources.filter(s => s.uid !== _selectedUid);
        // If removed source was dominant, reassign
        if (removedSrc && removedSrc.id === _dominantId) {
            _dominantId = _sources.length ? _sources[0].id : null;
            LM.info(`Dominant reassigned → "${_dominantId}" (removed source was dominant)`);
        }
        if (removedSrc) LM.info(`Source removed → uid=${removedSrc.uid} | id="${removedSrc.id}" name="${removedSrc.name}" | ${_sources.length} source(s) remaining`);
        _selectedUid = null;
        _renderAll();
    }

    // BEGIN RENDERING FUNCTIONS

    // ------------------------------------------------------------------
    // Render the source list
    // ------------------------------------------------------------------
    function _renderSourceList() {
        LM.info(`Rendering source list (${_sources.length} source(s), selectedUid=${_selectedUid}, dominantId=${_dominantId})`);
        const ul = _overlay.querySelector('#lm-source-list');
        ul.innerHTML = '';

        if (!_sources.length) {
            const li = document.createElement('li');
            li.className = 'lm-source-empty';
            li.textContent = 'No sources added. Click "+ New Source".';
            ul.appendChild(li);
            _selectSourceItem(null);
            return;
        }

        _sources.forEach((src, idx) => {
            const li = document.createElement('li');
            li.className = 'lm-source-item' + (_selectedUid === src.uid ? ' selected' : '');
            li.dataset.uid = src.uid;

            const isDominant = src.id === _dominantId;

            // Show shortened cycle label for forecast sources
            const cycleTag = (src.cycleTime && src.entry && src.entry.has_forecast_hour)
                ? `<span class="lm-src-cycle" title="Model cycle">${_fmtCycleShort(src.cycleTime)}</span>`
                : '';

            li.innerHTML =
                `<span class="lm-src-swatch" style="background:${src.color}"></span>` +
                `<span class="lm-src-name" title="${_srcLabel(src)}">${_srcLabel(src)}</span>` +
                cycleTag +
                (isDominant ? `<span class="lm-src-dom" title="Dominant source">&#8679;</span>` : '') +
                `<button class="lm-src-up"   title="Move up"   data-uid="${src.uid}">&#9650;</button>` +
                `<button class="lm-src-down" title="Move down" data-uid="${src.uid}">&#9660;</button>`;

            // Move up/down
            li.querySelector('.lm-src-up').addEventListener('click', (e) => {
                e.stopPropagation();
                if (idx > 0) {
                    [_sources[idx - 1], _sources[idx]] = [_sources[idx], _sources[idx - 1]];
                    _renderAll();
                }
            });
            li.querySelector('.lm-src-down').addEventListener('click', (e) => {
                e.stopPropagation();
                if (idx < _sources.length - 1) {
                    [_sources[idx + 1], _sources[idx]] = [_sources[idx], _sources[idx + 1]];
                    _renderAll();
                }
            });

            ul.appendChild(li);
        });

        // Re-apply selection highlight
        _overlay.querySelector('#lm-btn-edit').disabled   = _selectedUid === null;
        _overlay.querySelector('#lm-btn-remove').disabled = _selectedUid === null;
    }

    // ------------------------------------------------------------------
    // Render the dominant source dropdown
    // ------------------------------------------------------------------
    function _renderDominantDropdown() {
        const sel = _overlay.querySelector('#lm-dominant');
        sel.innerHTML = '';

        if (!_sources.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(none)';
            sel.appendChild(opt);
            sel.disabled = true;
            return;
        }

        sel.disabled = false;
        _sources.forEach(src => {
            const opt = document.createElement('option');
            opt.value = src.id;
            opt.textContent = _srcLabel(src);
            if (src.id === _dominantId) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    // ------------------------------------------------------------------
    // Render frame info summary (uses probed frame list)
    // ------------------------------------------------------------------
    function _renderFrameInfo() {
        const el = _overlay.querySelector('#lm-frame-info');
        const dom = _getDomEntry();

        if (!dom) {
            el.textContent = '';
            return;
        }

        if (_probing) {
            el.innerHTML = '<div class="lm-frameinfo"><span class="lm-fi-key">Probing&#8230;</span></div>';
            return;
        }

        if (!_allFrames.length) {
            const dominantSrc = _sources.find(s => s.id === _dominantId);
            if (dom && dom.has_forecast_hour && (!dominantSrc || !dominantSrc.cycleTime)) {
                el.innerHTML = '<div class="lm-frameinfo"><span class="lm-fi-key" style="color:#aa8833">No cycle selected — remove/re-add source to choose a cycle.</span></div>';
            } else {
                el.innerHTML = '<div class="lm-frameinfo"><span class="lm-fi-key" style="color:#aa5544">No data files found.</span></div>';
            }
            return;
        }

        if (!_probedFrames.length) {
            el.innerHTML = '<div class="lm-frameinfo"><span class="lm-fi-key" style="color:#aa8833">No frames in selection window.</span></div>';
            return;
        }

        const newest  = _probedFrames[0].valid;
        const oldest  = _probedFrames[_probedFrames.length - 1].valid;
        const spanHr  = ((newest - oldest) / 3600000).toFixed(1);
        // Derive interval from actual frame data
        const freqMin = _actualFreqMs(_allFrames) / 60000;

        // For forecast datasets, show the cycle and forecast-hour range
        let fhrNote = '';
        if (dom.has_forecast_hour) {
            const dominantSrc = _sources.find(s => s.id === _dominantId);
            const cycleStr = dominantSrc && dominantSrc.cycleTime
                ? `&nbsp; <span class="lm-fi-key">Cycle:</span> <span>${_fmtCycleShort(dominantSrc.cycleTime)}</span>`
                : '';
            const maxFhrActual = _probedFrames.length
                ? `F${String(_probedFrames[0].fhr).padStart(3,'0')}` : '—';
            fhrNote = cycleStr +
                `&nbsp; <span class="lm-fi-key">Latest F-hr:</span> <span>${maxFhrActual}</span>`;
        }

        el.innerHTML =
            `<div class="lm-frameinfo">` +
            `<span class="lm-fi-key">Found:</span> <span>${_allFrames.length}</span>&nbsp; ` +
            `<span class="lm-fi-key selected-count">Loaded:</span> <span class="lm-fi-selected">${_probedFrames.length}</span>&nbsp; ` +
            `<span class="lm-fi-key">Span:</span> <span>${spanHr}h</span>&nbsp; ` +
            `<span class="lm-fi-key">Interval:</span> <span>${freqMin >= 60 ? freqMin/60+'h' : freqMin+'min'}</span>` +
            fhrNote +
            `</div>`;
    }

    // ------------------------------------------------------------------
    // Render the timeline — NMAP2-style proportional axis with three rows:
    //   Row 1 (day row): MonDD labels + vertical day-boundary dividers
    //   Row 2 (axis row): horizontal baseline with hour tick marks + labels
    //   Row 3 (dot row):  frame-availability dots + draggable selection box
    // ------------------------------------------------------------------
    function _renderTimeline() {
        const container  = _overlay.querySelector('#lm-timeline');
        const rangeLabel = _overlay.querySelector('#lm-timeline-range');
        container.innerHTML = '';
        container.style.flexDirection = 'column';
        container.style.alignItems    = 'flex-start';
        container.style.minHeight     = '';

        // Tell the user we're finding all of the available data.
        if (_probing) {
            container.innerHTML = '<span class="lm-tl-empty lm-tl-probing">Probing data directory&#8230;</span>';
            rangeLabel.textContent = '';
            return;
        }

        // If don't have all of the frames, let the user know.
        if (!_allFrames.length) {
            const dom = _getDomEntry();
            const dominantSrc = _sources.find(s => s.id === _dominantId);
            let msg;
            if (dom && dom.has_forecast_hour && (!dominantSrc || !dominantSrc.cycleTime)) {
                msg = 'No cycle time selected &#8212; remove and re-add this source to choose a cycle.';
            } else if (_dominantId) {
                msg = 'No data files found.';
            } else {
                msg = 'No dominant source selected.';
            }
            container.innerHTML = `<span class="lm-tl-empty">${msg}</span>`;
            rangeLabel.textContent = '';
            return;
        }

        const dom    = _getDomEntry();
        const hasFhr = dom && dom.has_forecast_hour;
        // Derive frequency from actual frame data rather than catalog metadata
        const freqMin = _actualFreqMs(_allFrames) / 60000;

        const allNewest = _allFrames[0].valid;
        const allOldest = _allFrames[_allFrames.length - 1].valid;

        // KEY FIX:
        // Always derive the timeline extents from actual available frames,
        // plus one interval of padding.  The API backend handles file discovery
        // so we don't need to distinguish data_store_catalog vs HEAD probing.
        let defaultEnd, defaultStart;
        const padMs = freqMin * 60000;
        if (hasFhr) {
            defaultEnd   = allNewest;
            defaultStart = allOldest;
        } else {
            defaultStart = new Date(allOldest.getTime() - padMs);
            defaultEnd   = new Date(allNewest.getTime() + padMs);
        }

        // Set up the timeline start and end dates.
        const tlEnd   = _rangeEnd   || defaultEnd;
        const tlStart = _rangeStart || defaultStart;

        const totalMs   = Math.max(tlEnd.getTime() - tlStart.getTime(), 3600000); // min 1 h
        const totalHr   = totalMs / 3600000;

        const containerW = Math.max(200,
            (container.parentElement ? container.parentElement.clientWidth - 24 : 700) || 700);
        const pxPerHr   = Math.min(60, containerW / Math.max(totalHr, 1));
        const totalPx   = Math.round(totalHr * pxPerHr);
        _tlPxPerMs      = pxPerHr / 3600000;

        const posX = (t) => Math.round((t.getTime() - tlStart.getTime()) * _tlPxPerMs);

        rangeLabel.textContent = `${_fmtDateUTC(tlStart, true)} \u2192 ${_fmtDateUTC(tlEnd, true)}`;

        const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const pad  = n => String(n).padStart(2, '0');

        // ── Row 1: Day row ──────────────────────────────────────────────
        const dayRow = document.createElement('div');
        dayRow.className = 'lm-tl-dayrow';
        dayRow.style.width = totalPx + 'px';

        const firstDay = new Date(Date.UTC(
            tlStart.getUTCFullYear(), tlStart.getUTCMonth(), tlStart.getUTCDate()));
        for (let d = new Date(firstDay); d.getTime() <= tlEnd.getTime(); d = new Date(d.getTime() + 86400000)) {
            const dayEnd  = new Date(d.getTime() + 86400000);
            const left    = Math.max(0,        posX(d));
            const right   = Math.min(totalPx,  posX(dayEnd));
            if (right <= left) continue;

            const span = document.createElement('div');
            span.className = 'lm-tl-dayspan';
            span.style.left  = left + 'px';
            span.style.width = (right - left) + 'px';
            span.textContent = MONS[d.getUTCMonth()] + pad(d.getUTCDate());
            dayRow.appendChild(span);

            if (left > 2) {
                const div = document.createElement('div');
                div.className  = 'lm-tl-daydiv';
                div.style.left = left + 'px';
                dayRow.appendChild(div);
            }
        }
        container.appendChild(dayRow);

        // ── Row 2: Axis row (hour ticks) ───────────────────────────────
        const axisRow = document.createElement('div');
        axisRow.className = 'lm-tl-axisrow';
        axisRow.style.width = totalPx + 'px';

        let tickHr = 24;
        for (const candidate of [1, 2, 3, 6, 12, 24, 48, 72, 168]) {
            if (candidate * pxPerHr >= 28) { tickHr = candidate; break; }
        }

        const axisLine = document.createElement('div');
        axisLine.className = 'lm-tl-axisline';
        axisLine.style.width = totalPx + 'px';
        axisRow.appendChild(axisLine);

        const startHr0 = new Date(Date.UTC(
            tlStart.getUTCFullYear(), tlStart.getUTCMonth(), tlStart.getUTCDate()));
        for (let h = 0; ; h += tickHr) {
            const t = new Date(startHr0.getTime() + h * 3600000);
            if (t.getTime() > tlEnd.getTime() + tickHr * 3600000) break;
            if (t.getTime() < tlStart.getTime()) continue;
            const left = posX(t);
            if (left < 0 || left > totalPx + 4) continue;

            const tick = document.createElement('div');
            tick.className = 'lm-tl-htick';
            tick.style.left = left + 'px';

            const mark = document.createElement('div');
            mark.className = 'lm-tl-htick-mark';
            tick.appendChild(mark);

            const lbl = document.createElement('div');
            lbl.className = 'lm-tl-htick-label';
            lbl.textContent = pad(t.getUTCHours());
            tick.appendChild(lbl);

            axisRow.appendChild(tick);
        }
        container.appendChild(axisRow);

        // ── Row 3: Dot row ─────────────────────────────────────────────
        // This is where we show all of the frames available using dots.
        const dotRow = document.createElement('div');
        dotRow.className = 'lm-tl-dotrow';
        dotRow.style.width = totalPx + 'px';

        const selectedPaths = new Set(_probedFrames.map(f => f.path));
        const latestPath    = _probedFrames.length ? _probedFrames[0].path : null;

        for (const frame of _allFrames) {
            if (frame.valid.getTime() < tlStart.getTime()) continue;
            if (frame.valid.getTime() > tlEnd.getTime())   continue;

            const left = posX(frame.valid);
            const isSelected = selectedPaths.has(frame.path);
            const isLatest   = frame.path === latestPath;

            const dot = document.createElement('div');
            dot.className    = 'lm-tl-dot ' +
                (isLatest ? 'lm-tl-latest' : isSelected ? 'lm-tl-included' : 'lm-tl-excluded');
            dot.style.left   = (left - 1) + 'px';
            dot.dataset.path = frame.path;

            if (hasFhr) {
                dot.title = `Valid: ${_fmtDateUTC(frame.valid, false)}\n` +
                    `Cycle: ${_fmtDateUTC(frame.cycle, false)}  F${String(frame.fhr).padStart(3,'0')}` +
                    (isSelected ? '' : '\n(not loaded)');
            } else {
                dot.title = _fmtDateUTC(frame.valid, false) + (isSelected ? '' : '\n(not loaded)');
            }
            dotRow.appendChild(dot);
        }

        // Draggable selection box
        // Let's setup the draggable selection box so the user can select a range of frames to load.
        let selLeft, selW;
        if (_selWindowStart === null && _probedFrames.length) {
            const selNewest = _probedFrames[0].valid;
            const selOldest = _probedFrames[_probedFrames.length - 1].valid;
            selLeft = Math.max(0, posX(selOldest));
            selW    = Math.max(4, posX(selNewest) - selLeft);
        } else {
            const actualFreqMs2 = _actualFreqMs(_allFrames);
            const windowMs2 = _numFrames * actualFreqMs2;
            let winStart2;
            if (_selWindowStart) {
                winStart2 = new Date(Math.max(_selWindowStart.getTime(), tlStart.getTime()));
            } else {
                winStart2 = new Date(Math.max(tlEnd.getTime() - windowMs2, tlStart.getTime()));
            }
            const winEnd2 = new Date(Math.min(winStart2.getTime() + windowMs2, tlEnd.getTime()));
            selLeft = Math.max(0, posX(winStart2));
            selW    = Math.max(4, posX(winEnd2) - selLeft);
        }
        const selbox  = document.createElement('div');
        selbox.id     = 'lm-tl-selbox';
        selbox.style.left  = selLeft + 'px';
        selbox.style.width = selW    + 'px';
        selbox.addEventListener('mousedown', (e) => {
            e.preventDefault();
            _dragStartX    = e.clientX;
            _dragStartWSms = tlStart.getTime() + selLeft / _tlPxPerMs;
            _selWindowStart = new Date(_dragStartWSms);
            document.addEventListener('mousemove', _onDragMove);
            document.addEventListener('mouseup',   _onDragEnd);
        });
        dotRow.appendChild(selbox);
        container.appendChild(dotRow);
    }

    // ------------------------------------------------------------------
    // Full re-render of all dynamic panels.
    // Source list and dominant dropdown update synchronously;
    // timeline / frame-info update asynchronously via _scheduleProbe().
    // ------------------------------------------------------------------
    function _renderAll() {
        _renderSourceList();
        _renderDominantDropdown();
        _scheduleProbe();
    }

    // END RENDERING FUNCTIONS

    // ------------------------------------------------------------------
    // Probe the API for actually-available frames.
    //
    // For forecast datasets: fetches available fhrs from the cycle.
    // For analysis/obs datasets: fetches available valid times.
    //
    // Returns an array of { valid, cycle, fhr, path } sorted newest first.
    // Returns null if this probe was superseded by a newer one.
    // ------------------------------------------------------------------
    async function _probeFrames(token) {
        const dom = _getDomEntry();
        if (!dom || !_dominantId) return [];

        const dominantSrc = _sources.find(s => s.id === _dominantId);

        if (dom.has_forecast_hour) {
            // ── Forecast source: fetch available fhrs for the selected cycle ──
            const cycle = dominantSrc?.cycleTime;
            if (!cycle) return [];

            try {
                const cycleStr = _dateToCycleStr(cycle);
                const fhrData = await CatalogClient.listFhrs(_dominantId, cycleStr);
                if (token !== _probeToken) return null; // stale

                const frames = [];
                for (let i = 0; i < fhrData.fhrs.length; i++) {
                    const fhr = fhrData.fhrs[i];
                    frames.push({
                        valid: new Date(cycle.getTime() + fhr * 3600000),
                        cycle: new Date(cycle.getTime()),
                        fhr,
                        path: fhrData.keys?.[i] || `${cycleStr}_f${String(fhr).padStart(3, '0')}`,
                    });
                }

                // Apply range filter if set
                const filtered = frames.filter(f => {
                    if (_rangeStart && f.valid < _rangeStart) return false;
                    if (_rangeEnd   && f.valid > _rangeEnd)   return false;
                    return true;
                });

                filtered.sort((a, b) => b.valid - a.valid);
                LM.info(`Probed ${filtered.length} forecast frames for "${_dominantId}" cycle ${cycleStr}`);
                return filtered;

            } catch (err) {
                LM.warn(`Probe failed for forecast source "${_dominantId}": ${err.message}`);
                return [];
            }

        } else {
            // ── Analysis / observation source: fetch available valid times ──
            try {
                const opts = { limit: 500 };
                if (_rangeStart) opts.after  = _rangeStart.toISOString();
                if (_rangeEnd)   opts.before = _rangeEnd.toISOString();

                const times = await CatalogClient.listTimesDetailed(_dominantId, opts);
                if (token !== _probeToken) return null; // stale

                const frames = times
                    .map(t => ({
                        valid: new Date(t.valid_time),
                        cycle: t.cycle ? new Date(t.cycle) : new Date(t.valid_time),
                        fhr:   t.fhr ?? null,
                        path:  t.key,
                    }))
                    .filter(f => Number.isFinite(f.valid.getTime()));

                frames.sort((a, b) => b.valid - a.valid);
                LM.info(`Probed ${frames.length} analysis/obs frames for "${_dominantId}"`);
                return frames;

            } catch (err) {
                LM.warn(`Probe failed for source "${_dominantId}": ${err.message}`);
                return [];
            }
        }
    }

    // Debounce helper: schedule a probe run 400 ms after the last settings change.
    function _scheduleProbe() {
        if (_probeTimer) clearTimeout(_probeTimer);
        _probeTimer = setTimeout(_runProbe, 400);
    }

    // Find datasets with a data_store_catalog and probe them for available frames.
    async function _runProbe() {
        _probeTimer = null;
        const token = ++_probeToken;
        _probing = true;
        const domEntry = _getDomEntry();
        LM.debug(`Probe #${token} started → dominant="${_dominantId || 'none'}" sources=${_sources.length}`);
        _renderTimeline();
        _renderFrameInfo();
        const frames = await _probeFrames(token);
        if (frames === null) {
            LM.debug(`Probe #${token} cancelled (superseded)`);
            return; // stale — a newer probe is running
        }
        _allFrames      = frames;
        _selWindowStart = null;          // reset selection window to newest end
        _updateSliderMax();
        _probedFrames   = _computeSelected(_allFrames);
        _probing = false;
        if (_allFrames.length) {
            const oldest  = _allFrames[_allFrames.length - 1].valid;
            const newest  = _allFrames[0].valid;
            const spanHr  = ((newest - oldest) / 3600000).toFixed(1);
            LM.info(`Probe #${token} complete → ${_allFrames.length} total frames found | span ${spanHr}h | oldest ${oldest.toISOString()} → newest ${newest.toISOString()}`);
            LM.debug(`  Selected (displayed): ${_probedFrames.length} frame(s) | numFrames=${_numFrames} frameSkip=${_frameSkip}`);
        } else {
            LM.warn(`Probe #${token} complete → 0 frames found for dominant="${_dominantId || 'none'}"`);
        }
        _renderTimeline();
        _renderFrameInfo();
    }

    // Median inter-frame gap from probed data — much more accurate than catalog value
    // when the actual archive is sparser or denser than the catalog advertises.
    function _actualFreqMs(allFrames) {
        if (allFrames.length < 2) {
            // No actual data to derive from — use a sensible default (1 hour)
            return 3600000;
        }
        const gaps = [];
        for (let i = 0; i < allFrames.length - 1; i++)
            gaps.push(allFrames[i].valid.getTime() - allFrames[i+1].valid.getTime());
        gaps.sort((a, b) => a - b);
        return gaps[Math.floor(gaps.length / 2)];
    }

    // Apply the selection window to allFrames.
    // Auto mode (_selWindowStart===null): walk newest→oldest, no time-window needed
    //   — box position is derived from the actual selected frames afterward.
    // Drag mode (_selWindowStart set): pick frames within a time window positioned
    //   by the user; window width = numFrames × actualFreq.
    function _computeSelected(allFrames) {
        if (!Array.isArray(allFrames) || allFrames.length === 0) return [];

        const tlEnd   = _rangeEnd   || allFrames[0].valid;
        const tlStart = _rangeStart || allFrames[allFrames.length - 1].valid;

        const visible = allFrames.filter(f =>
            f.valid.getTime() >= tlStart.getTime() &&
            f.valid.getTime() <= tlEnd.getTime()
        );
        if (!visible.length) return [];

        const out = [];
        const unlimited = (() => {
            const dom = _getDomEntry();
            return !!(dom && dom.default_frame_no === -1);
        })();
        const maxFrames = unlimited ? Infinity : _numFrames;

        // IMPORTANT:
        // Always select from ACTUAL visible frames only.
        // No synthetic stepping by temporal_frequency_min.
        let idx = 0;
        for (const f of visible) {
            if (idx % _frameSkip === 0) {
                out.push(f);
                if (out.length >= maxFrames) break;
            }
            idx++;
        }
        return out;
    }

    // Update frames slider/numInput max to the count of available frames in the
    // current visible range.  Clamps _numFrames if it now exceeds the new max.
    function _updateSliderMax() {
        if (!_overlay) return;
        const tlEnd   = _rangeEnd   || (_allFrames.length ? _allFrames[0].valid                   : null);
        const tlStart = _rangeStart || (_allFrames.length ? _allFrames[_allFrames.length-1].valid : null);
        const count   = (!tlStart || !tlEnd) ? 0
            : _allFrames.filter(f => f.valid >= tlStart && f.valid <= tlEnd).length;
        const maxVal  = Math.max(1, count);
        const slider  = _overlay.querySelector('#lm-frames-slider');
        const numInput = _overlay.querySelector('#lm-frames-num');
        const label    = _overlay.querySelector('#lm-frames-label');
        slider.max    = maxVal;
        numInput.max  = maxVal;
        if (_numFrames > maxVal) {
            _numFrames = maxVal;
            slider.value         = maxVal;
            numInput.value       = maxVal;
            label.textContent    = maxVal;
        }
    }

    // Recompute selection from cached frames and re-render (no server round-trip).
    function _recomputeSelection() {
        if (!_allFrames.length) {
            // No frames cached yet — need a full probe
            _scheduleProbe();
            return;
        }
        _probedFrames = _computeSelected(_allFrames);
        _renderTimeline();
        _renderFrameInfo();
    }

    // ------------------------------------------------------------------------
    // Selection-box drag handlers (module-level to allow removeEventListener)
    // ------------------------------------------------------------------------
    const _onDragMove = (e) => {
        if (!_tlPxPerMs) return;
        const actualFreqMs = _actualFreqMs(_allFrames);
        const windowMs = _numFrames * actualFreqMs;  // skip never inflates box

        const tlEnd   = _rangeEnd   || (_allFrames.length ? _allFrames[0].valid                   : new Date());
        const tlStart = _rangeStart || (_allFrames.length ? _allFrames[_allFrames.length-1].valid : new Date());

        const dx  = e.clientX - _dragStartX;
        const dtMs = dx / _tlPxPerMs;
        let newStart = new Date(_dragStartWSms + dtMs);
        // Clamp so box stays within visible range
        newStart = new Date(Math.max(newStart.getTime(), tlStart.getTime()));
        newStart = new Date(Math.min(newStart.getTime(), Math.max(tlStart.getTime(), tlEnd.getTime() - windowMs)));

        if (Math.abs(newStart.getTime() - ((_selWindowStart || tlEnd) - windowMs)) < 10000) return;
        _selWindowStart = newStart;

        // Move the selbox directly without full re-render
        const selbox = _overlay && _overlay.querySelector('#lm-tl-selbox');
        if (selbox) {
            const leftPx  = Math.round((newStart.getTime() - tlStart.getTime()) * _tlPxPerMs);
            const widthPx = Math.max(4, Math.round(Math.min(windowMs, tlEnd.getTime() - newStart.getTime()) * _tlPxPerMs));
            selbox.style.left  = leftPx  + 'px';
            selbox.style.width = widthPx + 'px';
        }

        // Recompute selected set and update dot classes in-place
        _probedFrames = _computeSelected(_allFrames);
        const selPaths   = new Set(_probedFrames.map(f => f.path));
        const latestPath = _probedFrames.length ? _probedFrames[0].path : null;
        (_overlay ? _overlay.querySelectorAll('.lm-tl-dot') : []).forEach(dot => {
            const p  = dot.dataset.path;
            if (!p) return;
            dot.className = 'lm-tl-dot ' +
                (p === latestPath ? 'lm-tl-latest' : selPaths.has(p) ? 'lm-tl-included' : 'lm-tl-excluded');
        });
        _renderFrameInfo();
    };

    const _onDragEnd = () => {
        document.removeEventListener('mousemove', _onDragMove);
        document.removeEventListener('mouseup',   _onDragEnd);
    };

    // ------------------------------------------------------------------
    // Shared date formatters
    // ------------------------------------------------------------------
    function _fmtDateUTC(dt, short) {
        const pad = n => String(n).padStart(2, '0');
        const HH  = pad(dt.getUTCHours());
        const mm  = pad(dt.getUTCMinutes());
        const DD  = pad(dt.getUTCDate());
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
        if (short) return `${DD}${mon} ${HH}${mm}Z`;
        return `${DD}${mon} ${HH}:${mm}Z`;
    }

    /** Short cycle label for the source list badge, e.g. "27 Feb 06Z" */
    function _fmtCycleShort(dt) {
        const pad = n => String(n).padStart(2, '0');
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
        return `${pad(dt.getUTCDate())} ${mon} ${pad(dt.getUTCHours())}Z`;
    }

    // ------------------------------------------------------------------
    // Range / Interval dialog
    // ------------------------------------------------------------------
    function _openRangeInt() {
        const pad = n => String(n).padStart(2, '0');
        // Determine current center from existing range or allFrames
        let center, beforeHr, afterHr;
        if (_rangeStart && _rangeEnd) {
            center   = new Date((_rangeStart.getTime() + _rangeEnd.getTime()) / 2);
            beforeHr = (_rangeEnd.getTime() - _rangeStart.getTime()) / 2 / 3600000;
            afterHr  = beforeHr;
        } else {
            center   = new Date();
            const dom = _getDomEntry();
            beforeHr = (dom && dom.default_range_hr) ? Math.min(dom.default_range_hr, 48) : 24;
            afterHr  = (dom && dom.has_forecast_hour && dom.max_forecast_hr) ? dom.max_forecast_hr : 0;
        }
        _overlay.querySelector('#lm-ri-date').value =
            `${center.getUTCFullYear()}-${pad(center.getUTCMonth()+1)}-${pad(center.getUTCDate())}`;
        // TODO: Change the time input to a 24-hour format and remove the AM/PM selection. This will simplify the user interface and avoid confusion with time zones.  The web browser chooses the locale (and thus the time format) based on the user's system settings, which can lead to inconsistencies. By enforcing a 24-hour format, we ensure that all users see the same time representation, regardless of their locale. This is especially important for applications that deal with global data and need to avoid ambiguity in time representation.  We could create two separate boxes, one for hour, one for minute to get around this.
        _overlay.querySelector('#lm-ri-time').value =
            `${pad(center.getUTCHours())}:${pad(center.getUTCMinutes())}`;
        _overlay.querySelector('#lm-ri-before').value   = Math.round(beforeHr);
        _overlay.querySelector('#lm-ri-after').value    = Math.round(afterHr);
        _overlay.querySelector('#lm-ri-interval').value = _rangeIntervalMin || '';
        _overlay.querySelector('#lm-ri-modal').style.display = 'flex';
    }

    function _applyRangeInt() {
        const pad     = n => String(n).padStart(2, '0');
        const dateVal = _overlay.querySelector('#lm-ri-date').value;       // YYYY-MM-DD
        const timeVal = _overlay.querySelector('#lm-ri-time').value;       // HH:MM
        const before  = Math.max(0, parseFloat(_overlay.querySelector('#lm-ri-before').value)   || 24);
        const after   = Math.max(0, parseFloat(_overlay.querySelector('#lm-ri-after').value)    || 0);
        const intVal  = _overlay.querySelector('#lm-ri-interval').value;

        const center      = new Date(`${dateVal}T${timeVal}:00Z`);
        _rangeStart       = new Date(center.getTime() - before * 3600000);
        _rangeEnd         = new Date(center.getTime() + after  * 3600000);
        _rangeIntervalMin = intVal ? Math.max(1, +intVal) : null;
        _selWindowStart   = null;   // reset selection box to auto (newest end)

        LM.info(`Timeline Range Set to ${_rangeStart.toISOString()} → ${_rangeEnd.toISOString()}`);
        
        _overlay.querySelector('#lm-ri-modal').style.display = 'none';
        _updateSliderMax();
        _recomputeSelection();
    }

    // ------------------------------------------------------------------
    // Open / close the layer manager overlay.  The overlay is built once and reused.
    // ------------------------------------------------------------------
    function _close() {
        if (_overlay) _overlay.style.display = 'none';
    }

    function _handleApply() {
        // Use probed valid times; falls back to empty array if probe hasn't completed yet.
        const frames = _probedFrames.map(f => f.valid);
        // Log a grouped summary before closing the dialog
        const domEntry = _getDomEntry();

        // Log some information to the console regarding the data.
        console.groupCollapsed('%c[LM]%c Apply — %d source(s), %d frame(s)', 'color:#4a9eff;font-weight:bold', 'color:inherit', _sources.length, frames.length);
        console.info('  Dominant :', _dominantId, domEntry ? `(${domEntry.name})` : '(none)');
        console.info('  Sources  :', _sources.map(s => `uid=${s.uid} "${s.id}" ${s.cycleTime ? '@'+_fmtCycleShort(s.cycleTime) : ''}`.trim()));
        console.info('  numFrames:', _numFrames, '  frameSkip:', _frameSkip);
        if (frames.length) {
            console.info('  Frame range:', frames[frames.length-1].toISOString(), '→', frames[0].toISOString());
            console.info('  Frames (newest→oldest):', frames.map(d => d.toISOString()));
        }
        console.groupEnd();

        // Close the dialog and call the onApply callback with the current state
        _close();
        if (typeof _onApply === 'function') {
            _onApply({
                sources:     _sources.slice(),
                dominantId:  _dominantId,
                numFrames:   _numFrames,
                frameSkip:   _frameSkip,
                frames,
            });
        }
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    return {
        /**
         * Build DOM and initialize DataSelector.  Call once after catalog is loaded.
         */
        init() {
            DataSelector.init();
            _overlay = _buildDOM();
        },

        /**
         * Open the Layer Manager dialog.
         * @param {Function} onApply  called with { sources, dominantId, numFrames, frameSkip, frames }
         */
        open(onApply) {
            _onApply = onApply;

            // If a dominant source is present, prefer its defaults
            const domEntry = _getDomEntry() || (_sources.length ? _sources[0].entry : null);
            if (domEntry && domEntry.default_frame_no) {
                _numFrames = domEntry.default_frame_no;
            }
            // Sync UI controls to persisted state
            _overlay.querySelector('#lm-frames-num').value    = _numFrames;
            _overlay.querySelector('#lm-frames-slider').value = _numFrames;
            _overlay.querySelector('#lm-frames-label').textContent = _numFrames;
            _overlay.querySelector('#lm-skip').value          = _frameSkip;
            _overlay.querySelector('#lm-footer-status').textContent = '';
            _updateSliderMax();  // reflect any already-probed frames

            _selectedUid = null;
            _renderAll();
            _overlay.style.display = 'flex';
        },
    };
    
})();

// TODO: Figure out how the layer manager will handle the miscellanous data sources as they are a little different and infrequent compared to the other data sources. 

window.LayerManager = LayerManager;
