import * as PanelManager from '../src/PanelManager.js';
import { getActiveGroups, getViewsByGroup, VIEW_REGISTRY } from '../src/config/views.js';

window.addEventListener('load', () => {
    const map = new maplibregl.Map({
        container: 'map',
        style:     'http://localhost:8080/style.json',
        center:    [-97.5, 38.5],
        zoom:      4,
    });

    map.on('load', async () => {
        map.setProjection({ type: 'globe' });

        PanelManager.init(map);

        // ── Wire up callbacks ─────────────────────────────────────────────
        PanelManager.setCallbacks({

            onLoadStart() {
                document.querySelector('#spinner')?.classList.remove('hidden');
            },

            onLoadEnd() {
                document.querySelector('#spinner')?.classList.add('hidden');
            },

            onLoadError(err) {
                document.querySelector('#spinner')?.classList.add('hidden');
                console.error('Load error:', err);
            },

            // Called whenever the active time changes on any slot.
            // dominantKey    = the dominant source's current key
            // validTimeLabel = human-readable time string
            // keysSummary    = { slotId: matchedKey } for all slots
            onTimeChange(dominantKey, validTimeLabel, keysSummary) {
                document.querySelector('#time-label').textContent = validTimeLabel ?? dominantKey;

                // Update the fhr slider to reflect the dominant key
                const allKeys = PanelManager.getDominantKeys();
                const idx     = allKeys.indexOf(dominantKey);
                if (idx >= 0) {
                    document.querySelector('#fhr-slider').value = idx;
                }

                // Update the slot status panel to show matched times
                _updateSlotPanel(PanelManager.getSlots());
            },

            // Called whenever a slot is added or removed
            onSlotsChanged(slots) {
                _updateSlotPanel(slots);
            },

            // Called when a slot's colorbars are available
            onColorbarsChanged(slotId, svgs) {
                _updateColorbarPanel();
            },
        });

        // ── Build the source panel UI ─────────────────────────────────────
        _buildSourcePanel();

        // ── Set up keyboard time stepping ─────────────────────────────────
        document.addEventListener('keydown', e => {
            if (e.key === 'ArrowRight' || e.key === '.') PanelManager.stepForward();
            if (e.key === 'ArrowLeft'  || e.key === ',') PanelManager.stepBackward();
        });

        // ── fhr slider ���───────────────────────────────────────────────────
        document.querySelector('#fhr-slider').addEventListener('input', e => {
            const keys = PanelManager.getDominantKeys();
            const key  = keys[parseInt(e.target.value, 10)];
            if (key) PanelManager.setKey(key);
        });

        // ── Mouse readout — samples ALL visible slots ─────────────────────
        map.on('mousemove', ev => {
            const { lng, lat } = ev.lngLat.wrap();
            let text = `${lat.toFixed(2)}°N  ${lng.toFixed(2)}°E`;

            const samples = PanelManager.sampleAt(lng, lat);
            for (const [slotId, sample] of Object.entries(samples)) {
                if (sample) {
                    const vals = Object.entries(sample)
                        .map(([k, v]) => Array.isArray(v)
                            ? `${k}: ${v[0].toFixed(0)}°/${v[1].toFixed(0)}kts`
                            : `${k}: ${v.toFixed(1)}`)
                        .join(' ');
                    text += `  |  [${slotId}] ${vals}`;
                }
            }
            document.querySelector('#readout').textContent = text;
        });

        // ── Load the default blended scene ───────────────────────────────
        // Example: MRMS radar (background) + MSLP analysis + METAR obs
        await PanelManager.addSlot({
            slotId:     'radar',
            viewId:     'mrms_cref',
            zOrder:     0,          // bottom — raster background
            preloadAll: false,      // MRMS is obs-time, no fhr loop needed
        });

        await PanelManager.addSlot({
            slotId:     'analysis',
            viewId:     'rap_mslp',
            zOrder:     1,          // middle — gridded analysis fields
            preloadAll: true,       // preload all hours for fast looping
            dominant:   true,       // RAP analysis drives the time loop
        });

        await PanelManager.addSlot({
            slotId:     'obs',
            viewId:     'surface_obs_standard',
            zOrder:     2,          // top — station plots above everything
            preloadAll: false,
        });
    });
});

// ─── Source panel (add/remove/configure slots) ────────────────────────────────

function _buildSourcePanel() {
    const panel = document.querySelector('#source-panel');
    if (!panel) return;

    // "Add source" row
    const addRow = document.createElement('div');
    addRow.className = 'source-add-row';

    const slotIdInput   = document.createElement('input');
    slotIdInput.placeholder = 'slot name (e.g. radar)';
    slotIdInput.className   = 'source-input';

    const groupSel  = document.createElement('select');
    groupSel.className = 'source-select';
    getActiveGroups().forEach(g => {
        const opt = document.createElement('option');
        opt.value       = g.id;
        opt.textContent = g.label;
        groupSel.appendChild(opt);
    });

    const productSel = document.createElement('select');
    productSel.className = 'source-select';

    const zOrderSel = document.createElement('select');
    zOrderSel.className = 'source-select';
    [['0 — Background (Raster)', 0], ['1 — Analysis/Model', 1], ['2 — Observations', 2]]
        .forEach(([label, val]) => {
            const opt = document.createElement('option');
            opt.value       = val;
            opt.textContent = label;
            zOrderSel.appendChild(opt);
        });

    const dominantChk   = document.createElement('input');
    dominantChk.type    = 'checkbox';
    dominantChk.title   = 'Set as dominant (loop-driving) source';

    const preloadChk    = document.createElement('input');
    preloadChk.type     = 'checkbox';
    preloadChk.title    = 'Preload all forecast hours';

    const addBtn = document.createElement('button');
    addBtn.textContent  = '+ Add';
    addBtn.className    = 'source-btn';
    addBtn.onclick = async () => {
        const slotId = slotIdInput.value.trim();
        const viewId = productSel.value;
        if (!slotId || !viewId) return;

        await PanelManager.addSlot({
            slotId,
            viewId,
            zOrder:     parseInt(zOrderSel.value, 10),
            preloadAll: preloadChk.checked,
            dominant:   dominantChk.checked,
        });
        slotIdInput.value = '';
    };

    // Populate products when group changes
    function refreshProducts() {
        const views = getViewsByGroup(groupSel.value);
        productSel.innerHTML = views
            .map(v => `<option value="${v.id}">${v.label}</option>`)
            .join('');
    }
    groupSel.addEventListener('change', refreshProducts);
    refreshProducts();

    addRow.append(slotIdInput, groupSel, productSel, zOrderSel,
                  dominantChk, document.createTextNode(' Dominant'),
                  preloadChk,  document.createTextNode(' Preload'),
                  addBtn);
    panel.appendChild(addRow);
}

// ─── Slot status panel (shows matched times, visible toggle, remove button) ───

function _updateSlotPanel(slots) {
    const container = document.querySelector('#slot-list');
    if (!container) return;

    container.innerHTML = '';

    slots.forEach(slot => {
        const row = document.createElement('div');
        row.className = `slot-row ${slot.dominant ? 'slot-dominant' : ''}`;

        const label = document.createElement('span');
        label.className   = 'slot-label';
        label.textContent = `[${slot.slotId}] ${slot.label}`;

        const timeLabel = document.createElement('span');
        timeLabel.className   = 'slot-time';
        timeLabel.textContent = slot.currentKey
            ? (slot.dominant ? `▶ F${slot.currentKey}` : `⇒ F${slot.currentKey}`)
            : '—';

        const visBtn = document.createElement('button');
        visBtn.textContent  = slot.visible ? '👁' : '👁‍🗨';
        visBtn.className    = 'slot-btn';
        visBtn.title        = slot.visible ? 'Hide layer' : 'Show layer';
        visBtn.onclick = () => PanelManager.setSlotVisible(slot.slotId, !slot.visible);

        const domBtn = document.createElement('button');
        domBtn.textContent  = '★';
        domBtn.className    = `slot-btn ${slot.dominant ? 'slot-btn-active' : ''}`;
        domBtn.title        = 'Set as dominant source';
        domBtn.disabled     = slot.dominant;
        domBtn.onclick = () => PanelManager.setDominantSlot(slot.slotId);

        const rmBtn = document.createElement('button');
        rmBtn.textContent   = '✕';
        rmBtn.className     = 'slot-btn slot-btn-remove';
        rmBtn.title         = 'Remove this source';
        rmBtn.onclick = () => PanelManager.removeSlot(slot.slotId);

        row.append(label, timeLabel, visBtn, domBtn, rmBtn);
        container.appendChild(row);
    });
}

// ─── Colorbar panel (one colorbar per visible slot) ──────────────────────────

function _updateColorbarPanel() {
    const container = document.querySelector('#colorbar');
    const panel     = document.querySelector('#colorbar-panel');
    if (!container || !panel) return;

    container.innerHTML = '';
    let hasAny = false;

    PanelManager.getSlots().forEach(slot => {
        if (!slot.visible) return;
        const layerSet = PanelManager._slots?.get(slot.slotId)?.layerSet;
        if (!layerSet?.colorbars?.length) return;

        layerSet.colorbars.forEach(svg => {
            container.appendChild(svg);
            hasAny = true;
        });
    });

    panel.classList.toggle('hidden', !hasAny);
}
