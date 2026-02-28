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

'use strict';

const LayerManager = (() => {

    // ------------------------------------------------------------------
    // Persistent state (survives dialog close/open cycles)
    // ------------------------------------------------------------------
    let _sources      = [];     // [{ uid, id, name, color, entry }]
    let _dominantId   = null;   // catalog id of dominant source
    let _numFrames    = 12;
    let _frameSkip    = 1;
    let _onApply      = null;
    let _editingUid   = null;   // uid being replaced via "Edit Source"
    let _overlay      = null;
    let _uidCounter   = 0;

    // Probe state
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
    let _dragStartX       = 0;
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
    // Build DOM — called once by init()
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
  <div id="lm-body">
    <div id="lm-left">
      <div class="lm-section-hdr">ACTIVE SOURCES</div>
      <ul id="lm-source-list"></ul>
      <div id="lm-source-btns">
        <button class="lm-btn lm-btn-action" id="lm-btn-new">+ New Source</button>
        <button class="lm-btn lm-btn-action" id="lm-btn-edit" disabled>Edit Source</button>
        <button class="lm-btn lm-btn-remove" id="lm-btn-remove" disabled>&#10005; Remove</button>
      </div>
    </div>
    <div id="lm-right">
      <div class="lm-section-hdr">SETTINGS</div>
      <div class="lm-setting-block">
        <div class="lm-setting-row">
          <label class="lm-label">Dominant</label>
          <select id="lm-dominant"></select>
        </div>
        <div class="lm-setting-row">
          <label class="lm-label">Frames</label>
          <div id="lm-frames-control">
            <input id="lm-frames-num" type="number" min="1" max="100" value="12" />
            <input id="lm-frames-slider" type="range" min="1" max="100" value="12" />
            <span id="lm-frames-label">12</span>
          </div>
        </div>
        <div class="lm-setting-row">
          <label class="lm-label">Skip frames</label>
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
  </div>
  <div id="lm-timeline-section">
    <div class="lm-section-hdr">
      TIMELINE
      <span id="lm-timeline-range"></span>
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
            const presel = src ? { id: src.id, cycleTime: src.cycleTime || null } : null;
            DataSelector.open(_onDataSelected, presel);
        });
        overlay.querySelector('#lm-btn-remove').addEventListener('click', _removeSelected);

        // Dominant dropdown
        overlay.querySelector('#lm-dominant').addEventListener('change', (e) => {
            _dominantId    = e.target.value || null;
            _allFrames     = [];   // force full re-probe for new source
            _probedFrames  = [];
            _selWindowStart = null; // reset selection window to newest end
            _scheduleProbe();
        });

        // Frame count — keep num input and slider in sync
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
    function _onDataSelected(id, cycleTime) {
        const entry = DataCatalog.byId(id);
        if (!entry) return;

        // Only store a cycle time for datasets that actually have forecast hours
        const storedCycle = (entry.has_forecast_hour && cycleTime instanceof Date)
            ? cycleTime : null;

        if (_editingUid !== null) {
            // Replace existing source
            const idx = _sources.findIndex(s => s.uid === _editingUid);
            if (idx !== -1) {
                const old = _sources[idx];
                _sources[idx] = { uid: old.uid, id, name: entry.name, color: old.color, entry, cycleTime: storedCycle };
                if (_dominantId === old.id) _dominantId = id;
            }
            _editingUid = null;
        } else {
            // Add new source
            const uid = ++_uidCounter;
            const color = _nextColor();
            _sources.push({ uid, id, name: entry.name, color, entry, cycleTime: storedCycle });
            if (_sources.length === 1) _dominantId = id; // auto-assign first dominant
        }

        _renderAll();

        // Return focus to layer manager (DataSelector already closed)
        _overlay.style.display = 'flex';
    }

    // ------------------------------------------------------------------
    // Selection helpers
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

    function _removeSelected() {
        if (_selectedUid === null) return;
        const removedSrc = _sources.find(s => s.uid === _selectedUid);
        _sources = _sources.filter(s => s.uid !== _selectedUid);
        // If removed source was dominant, reassign
        if (removedSrc && removedSrc.id === _dominantId) {
            _dominantId = _sources.length ? _sources[0].id : null;
        }
        _selectedUid = null;
        _renderAll();
    }

    // ------------------------------------------------------------------
    // Render the source list
    // ------------------------------------------------------------------
    function _renderSourceList() {
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
                `<span class="lm-src-name">${src.name}</span>` +
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
            opt.textContent = src.name;
            if (src.id === _dominantId) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    // ------------------------------------------------------------------
    // Probe the data directory for actually-available frames.
    //
    // Fires HTTP HEAD requests against expanded path_template URLs and
    // returns only the candidates that respond with HTTP 200.
    //
    // For datasets with has_forecast_hour, candidates span (cycle × fhr)
    // so the timeline shows *valid* times instead of cycle times.
    //
    // Returns an array of { valid, cycle, fhr, path } sorted newest first,
    // trimmed to _numFrames entries with _frameSkip spacing.
    // Returns null if this probe was superseded by a newer one.
    // ------------------------------------------------------------------
    async function _probeFrames(token) {
        const dom = _dominantId ? DataCatalog.byId(_dominantId) : null;
        if (!dom || !dom.temporal_frequency_min || !dom.path_template) return [];

        const freqMin    = dom.temporal_frequency_min;
        const lookbackHr = dom.time_range_hr || 48;
        const now        = new Date();
        // Floor to the latest cycle boundary
        const epochMin    = Math.floor(now.getTime() / (freqMin * 60000)) * freqMin * 60000;
        const latestCycle = new Date(epochMin);
        // +2 extra cycles ensures the full lookbackHr window is always covered
        // even when latestCycle is up to 2 cycle-lengths behind the exact current time.
        const maxCycles  = Math.ceil(lookbackHr * 60 / freqMin) + 2;

        const candidates = [];

        if (dom.has_forecast_hour && dom.forecast_hr_step && dom.max_forecast_hr != null) {
            // Forecast dataset: probe ONLY the cycle time chosen in DataSelector.
            // If no cycle was chosen, return empty so the UI can prompt the user.
            const dominantSrc = _sources.find(s => s.id === _dominantId);
            const cycleTime   = dominantSrc ? dominantSrc.cycleTime : null;

            if (!cycleTime) return [];

            for (let fhr = 0; fhr <= dom.max_forecast_hr; fhr += dom.forecast_hr_step) {
                const valid  = new Date(cycleTime.getTime() + fhr * 3600000);
                // Do NOT skip future valid times — forecast files exist before their valid time.
                // The HEAD request determines actual file existence.
                const fhrStr = String(fhr).padStart(3, '0');
                const path = DataCatalog.expandPath(dom.path_template, cycleTime, { FFF: fhrStr });
                candidates.push({ valid, cycle: cycleTime, fhr, path });
            }
        } else {
            // Analysis / obs: the cycle time IS the valid time.
            for (let ci = 0; ci < maxCycles; ci++) {
                const cycle = new Date(latestCycle.getTime() - ci * freqMin * 60000);
                const path  = DataCatalog.expandPath(dom.path_template, cycle);
                candidates.push({ valid: cycle, cycle, fhr: null, path });
            }
        }

        // For forecast datasets the full candidate list is already bounded by
        // max_forecast_hr; for obs/analysis it is bounded by time_range_hr via maxCycles.
        // Never apply the obs-derived maxCycles cap to forecast candidates.
        const MAX_PROBES = dom.has_forecast_hour
            ? candidates.length
            : Math.min(maxCycles, 2000);
        const probeList  = candidates.slice(0, MAX_PROBES);

        // Fire all HEAD requests in parallel
        const results = await Promise.all(probeList.map(async (cand) => {
            try {
                const resp = await fetch(cand.path, { method: 'HEAD', cache: 'no-store' });
                return resp.ok ? cand : null;
            } catch {
                return null;
            }
        }));

        // Discard result if a newer probe has been started
        if (token !== _probeToken) return null;

        const found = results.filter(Boolean);
        // Sort newest valid time first
        found.sort((a, b) => b.valid - a.valid);

        // Return all found frames — selection is applied separately by _computeSelected()
        return found;
    }

    // Median inter-frame gap from probed data — much more accurate than catalog value
    // when the actual archive is sparser or denser than the catalog advertises.
    function _actualFreqMs(allFrames) {
        if (allFrames.length < 2) {
            const dom = DataCatalog.byId(_dominantId);
            const fMin = (dom && dom.has_forecast_hour && dom.forecast_hr_step)
                ? dom.forecast_hr_step * 60
                : (dom ? dom.temporal_frequency_min : 60);
            return fMin * 60000;
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
        if (!allFrames.length) return [];

        // Filter to the visible range first
        const tlEnd   = _rangeEnd   || allFrames[0].valid;
        const tlStart = _rangeStart || allFrames[allFrames.length - 1].valid;
        const visible = allFrames.filter(
            f => f.valid.getTime() >= tlStart.getTime() &&
                 f.valid.getTime() <= tlEnd.getTime());
        if (!visible.length) return [];

        if (_selWindowStart === null) {
            // ── Auto mode: just take newest N frames (with skip/interval thinning) ──
            const result = [];
            if (_rangeIntervalMin) {
                const intervalMs = _rangeIntervalMin * 60000;
                let lastMs = Infinity;
                for (const f of visible) {
                    if (lastMs - f.valid.getTime() >= intervalMs - 30000) {
                        result.push(f);
                        lastMs = f.valid.getTime();
                        if (result.length >= _numFrames) break;
                    }
                }
            } else {
                let idx = 0;
                for (const f of visible) {
                    if (idx % _frameSkip === 0) {
                        result.push(f);
                        if (result.length >= _numFrames) break;
                    }
                    idx++;
                }
            }
            return result; // newest-first
        }

        // ── Drag mode: time-window based on actual measured spacing ──
        const actualFreqMs = _actualFreqMs(allFrames);
        const windowMs  = _numFrames * actualFreqMs;  // skip never inflates box
        const winStart  = new Date(Math.max(_selWindowStart.getTime(), tlStart.getTime()));
        const winEnd    = new Date(Math.min(winStart.getTime() + windowMs, tlEnd.getTime()));

        const result = [];
        if (_rangeIntervalMin) {
            const intervalMs = _rangeIntervalMin * 60000;
            let lastMs = Infinity;
            for (const f of visible) {
                if (f.valid.getTime() > winEnd.getTime())   continue;
                if (f.valid.getTime() < winStart.getTime()) break;
                if (lastMs - f.valid.getTime() >= intervalMs - 30000) {
                    result.push(f);
                    lastMs = f.valid.getTime();
                    if (result.length >= _numFrames) break;
                }
            }
        } else {
            let idx = 0;
            for (const f of visible) {
                if (f.valid.getTime() > winEnd.getTime())   continue;
                if (f.valid.getTime() < winStart.getTime()) break;
                if (idx % _frameSkip === 0) {
                    result.push(f);
                    if (result.length >= _numFrames) break;
                }
                idx++;
            }
        }
        return result; // newest-first
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

    // Debounce helper: schedule a probe run 400 ms after the last settings change.
    function _scheduleProbe() {
        if (_probeTimer) clearTimeout(_probeTimer);
        _probeTimer = setTimeout(_runProbe, 400);
    }

    async function _runProbe() {
        _probeTimer = null;
        const token = ++_probeToken;
        _probing = true;
        _renderTimeline();
        _renderFrameInfo();
        const frames = await _probeFrames(token);
        if (frames === null) return; // stale — a newer probe is running
        _allFrames      = frames;
        _selWindowStart = null;          // reset selection window to newest end
        _updateSliderMax();
        _probedFrames   = _computeSelected(_allFrames);
        _probing = false;
        _renderTimeline();
        _renderFrameInfo();
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

    // ------------------------------------------------------------------
    // Render frame info summary (uses probed frame list)
    // ------------------------------------------------------------------
    function _renderFrameInfo() {
        const el = _overlay.querySelector('#lm-frame-info');
        const dom = _dominantId ? DataCatalog.byId(_dominantId) : null;

        if (!dom || !dom.temporal_frequency_min) {
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
        // Interval shown is the forecast step for forecast data, otherwise cycle freq
        const freqMin = (dom.has_forecast_hour && dom.forecast_hr_step)
            ? dom.forecast_hr_step * 60
            : dom.temporal_frequency_min;

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
    // Selection-box drag handlers (module-level to allow removeEventListener)
    // ------------------------------------------------------------------
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

        if (_probing) {
            container.innerHTML = '<span class="lm-tl-empty lm-tl-probing">Probing data directory&#8230;</span>';
            rangeLabel.textContent = '';
            return;
        }

        if (!_allFrames.length) {
            const dom = _dominantId ? DataCatalog.byId(_dominantId) : null;
            const dominantSrc = _sources.find(s => s.id === _dominantId);
            let msg;
            if (dom && dom.has_forecast_hour && (!dominantSrc || !dominantSrc.cycleTime)) {
                msg = 'No cycle time selected &#8212; remove and re-add this source to choose a cycle.';
            } else if (dom && dom.path_template) {
                msg = 'No data files found in directory.';
            } else {
                msg = 'No dominant source with known update frequency selected.';
            }
            container.innerHTML = `<span class="lm-tl-empty">${msg}</span>`;
            rangeLabel.textContent = '';
            return;
        }

        const dom    = DataCatalog.byId(_dominantId);
        const hasFhr = dom && dom.has_forecast_hour;
        const freqMin = hasFhr && dom.forecast_hr_step
            ? dom.forecast_hr_step * 60
            : (dom ? dom.temporal_frequency_min : 60);

        const allNewest = _allFrames[0].valid;
        const allOldest = _allFrames[_allFrames.length - 1].valid;
        const tlEnd     = _rangeEnd   || allNewest;
        const tlStart   = _rangeStart || allOldest;
        const totalMs   = Math.max(tlEnd.getTime() - tlStart.getTime(), 3600000); // min 1 h
        const totalHr   = totalMs / 3600000;

        // Auto-scale: fit inside the visible scroll container (subtract padding).
        // No lower-bound floor — long spans (336 h = 14 days) must scale down to fit.
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

        // Iterate every UTC day that overlaps the range
        const firstDay = new Date(Date.UTC(
            tlStart.getUTCFullYear(), tlStart.getUTCMonth(), tlStart.getUTCDate()));
        for (let d = new Date(firstDay); d.getTime() <= tlEnd.getTime(); d = new Date(d.getTime() + 86400000)) {
            const dayEnd  = new Date(d.getTime() + 86400000);
            const left    = Math.max(0,        posX(d));
            const right   = Math.min(totalPx,  posX(dayEnd));
            if (right <= left) continue;

            // Day label (e.g. "Feb27"), centered over the span
            const span = document.createElement('div');
            span.className = 'lm-tl-dayspan';
            span.style.left  = left + 'px';
            span.style.width = (right - left) + 'px';
            span.textContent = MONS[d.getUTCMonth()] + pad(d.getUTCDate());
            dayRow.appendChild(span);

            // Vertical day divider at midnight (skip the very left edge — that's the axis start)
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

        // Choose hour-tick interval: smallest step where ticks are at least 28 px apart
        let tickHr = 24;
        for (const candidate of [1, 2, 3, 6, 12, 24, 48, 72, 168]) {
            if (candidate * pxPerHr >= 28) { tickHr = candidate; break; }
        }

        // Horizontal baseline
        const axisLine = document.createElement('div');
        axisLine.className = 'lm-tl-axisline';
        axisLine.style.width = totalPx + 'px';
        axisRow.appendChild(axisLine);

        // Hour ticks: start from the first even multiple of tickHr on or after tlStart
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

        // ── Row 3: Dot row (frame dots + selection box) ────────────────
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
            dot.style.left   = (left - 1) + 'px';   // center the 3px bar
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

        // Draggable selection-window box — position derived from actual selected frames
        // in auto mode, or from the time window in drag mode.
        let selLeft, selW;
        if (_selWindowStart === null && _probedFrames.length) {
            // Auto: span exactly the selected frames
            const selNewest = _probedFrames[0].valid;
            const selOldest = _probedFrames[_probedFrames.length - 1].valid;
            selLeft = Math.max(0, posX(selOldest));
            selW    = Math.max(4, posX(selNewest) - selLeft);
        } else {
            // Drag mode: use time window based on actual spacing
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
            // Convert the box's current left-edge pixel back to a timestamp
            _dragStartWSms = tlStart.getTime() + selLeft / _tlPxPerMs;
            _selWindowStart = new Date(_dragStartWSms); // switch to drag mode
            document.addEventListener('mousemove', _onDragMove);
            document.addEventListener('mouseup',   _onDragEnd);
        });
        dotRow.appendChild(selbox);
        container.appendChild(dotRow);
    }

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
            const dom = _dominantId ? DataCatalog.byId(_dominantId) : null;
            beforeHr = (dom && dom.time_range_hr) ? Math.min(dom.time_range_hr, 48) : 24;
            afterHr  = (dom && dom.has_forecast_hour && dom.max_forecast_hr) ? dom.max_forecast_hr : 0;
        }
        _overlay.querySelector('#lm-ri-date').value =
            `${center.getUTCFullYear()}-${pad(center.getUTCMonth()+1)}-${pad(center.getUTCDate())}`;
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

        _overlay.querySelector('#lm-ri-modal').style.display = 'none';
        _updateSliderMax();
        _recomputeSelection();
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

    // ------------------------------------------------------------------
    // Open / close
    // ------------------------------------------------------------------
    function _close() {
        if (_overlay) _overlay.style.display = 'none';
    }

    function _handleApply() {
        // Use probed valid times; falls back to empty array if probe hasn't completed yet.
        const frames = _probedFrames.map(f => f.valid);
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

window.LayerManager = LayerManager;
