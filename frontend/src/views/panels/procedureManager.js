import {
    deleteProcedure,
    getActiveProcedureId,
    getProcedure,
    importProcedure,
    listProcedures,
    procedureExportJSON,
    saveProcedure,
    setActiveProcedureId,
} from '../../services/procedureStore.js';

export const ProcedureManager = (() => {
    let panel = null;
    let captureProcedure = null;
    let loadProcedure = null;
    let selectedId = null;

    function setStatus(message, isError = false) {
        const status = panel?.querySelector('#proc-status');
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('error', isError);
    }

    function selectedRecord() {
        return selectedId ? getProcedure(selectedId) : null;
    }

    function syncEditor(record) {
        panel.querySelector('#proc-name').value = record?.name || '';
        panel.querySelector('#proc-description').value = record?.description || '';
    }

    function renderList() {
        const records = listProcedures();
        if (selectedId && !records.some(record => record.id === selectedId)) selectedId = null;
        if (!selectedId) selectedId = getActiveProcedureId() || records[0]?.id || null;
        const list = panel.querySelector('#proc-list');
        list.innerHTML = '';
        if (!records.length) {
            const empty = document.createElement('li');
            empty.className = 'proc-empty';
            empty.textContent = 'No saved procedures yet.';
            list.appendChild(empty);
        }
        records.forEach(record => {
            const item = document.createElement('li');
            item.className = 'proc-item' + (record.id === selectedId ? ' selected' : '');
            item.tabIndex = 0;
            const name = document.createElement('strong');
            name.textContent = record.name;
            const meta = document.createElement('span');
            const sourceCount = record.definition?.display?.sources?.length || 0;
            const autoUpdate = record.definition?.runtime?.autoUpdate ? ' · auto-update' : '';
            meta.textContent = `${sourceCount} ${sourceCount === 1 ? 'source' : 'sources'}${autoUpdate} · ${new Date(record.updatedAt).toLocaleString()}`;
            item.append(name, meta);
            const select = () => {
                selectedId = record.id;
                setActiveProcedureId(record.id);
                syncEditor(record);
                renderList();
                setStatus('');
            };
            item.addEventListener('click', select);
            item.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    select();
                }
            });
            list.appendChild(item);
        });
        const hasSelection = Boolean(selectedRecord());
        ['#proc-update', '#proc-load', '#proc-export', '#proc-delete'].forEach(selector => {
            panel.querySelector(selector).disabled = !hasSelection;
        });
        if (hasSelection) syncEditor(selectedRecord());
    }

    async function saveCurrent(asNew) {
        try {
            setStatus('Capturing current map configuration…');
            const definition = await captureProcedure();
            const record = saveProcedure({
                id: asNew ? null : selectedId,
                name: panel.querySelector('#proc-name').value,
                description: panel.querySelector('#proc-description').value,
                definition,
            });
            selectedId = record.id;
            renderList();
            setStatus(`Saved “${record.name}” in this browser.`);
        } catch (error) {
            setStatus(error.message || String(error), true);
        }
    }

    async function loadSelected() {
        const record = selectedRecord();
        if (!record) return;
        try {
            setStatus(`Loading “${record.name}”…`);
            panel.querySelector('#proc-load').disabled = true;
            await loadProcedure(record.definition);
            setActiveProcedureId(record.id);
            setStatus(`Loaded “${record.name}”.`);
        } catch (error) {
            setStatus(error.message || String(error), true);
        } finally {
            panel.querySelector('#proc-load').disabled = false;
        }
    }

    function exportSelected() {
        const record = selectedRecord();
        if (!record) return;
        const blob = new Blob([procedureExportJSON(record)], {type: 'application/json'});
        const link = document.createElement('a');
        const safeName = record.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'procedure';
        link.href = URL.createObjectURL(blob);
        link.download = `${safeName}.nmap-procedure.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    function buildDOM() {
        panel = document.createElement('section');
        panel.id = 'procedure-manager';
        panel.className = 'hidden';
        panel.innerHTML = `
          <header>
            <div><h2>Procedures</h2><span>Saved persistently in this browser</span></div>
            <button id="proc-close" type="button" aria-label="Close">&times;</button>
          </header>
          <div class="proc-editor">
            <label>Name<input id="proc-name" type="text" placeholder="Water Vapor and 500-mb Heights"></label>
            <label>Description<textarea id="proc-description" rows="2" placeholder="Optional notes"></textarea></label>
            <div class="proc-save-actions">
              <button id="proc-save-new" type="button">Save New</button>
              <button id="proc-update" type="button">Update Selected</button>
            </div>
          </div>
          <div class="proc-library-title">Saved procedures</div>
          <ul id="proc-list"></ul>
          <div class="proc-actions">
            <button id="proc-load" type="button">Load</button>
            <button id="proc-export" type="button">Export</button>
            <button id="proc-import" type="button">Import</button>
            <button id="proc-delete" type="button" class="danger">Delete</button>
          </div>
          <input id="proc-import-file" type="file" accept="application/json,.json" hidden>
          <div id="proc-status" role="status"></div>`;
        document.body.appendChild(panel);

        panel.querySelector('#proc-close').addEventListener('click', close);
        panel.querySelector('#proc-save-new').addEventListener('click', () => saveCurrent(true));
        panel.querySelector('#proc-update').addEventListener('click', () => saveCurrent(false));
        panel.querySelector('#proc-load').addEventListener('click', loadSelected);
        panel.querySelector('#proc-export').addEventListener('click', exportSelected);
        panel.querySelector('#proc-import').addEventListener('click', () =>
            panel.querySelector('#proc-import-file').click());
        panel.querySelector('#proc-import-file').addEventListener('change', async event => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
                const record = importProcedure(await file.text());
                selectedId = record.id;
                renderList();
                setStatus(`Imported “${record.name}”.`);
            } catch (error) {
                setStatus(`Import failed: ${error.message || error}`, true);
            } finally {
                event.target.value = '';
            }
        });
        panel.querySelector('#proc-delete').addEventListener('click', () => {
            const record = selectedRecord();
            if (!record || !window.confirm(`Delete the saved procedure “${record.name}”?`)) return;
            deleteProcedure(record.id);
            selectedId = null;
            syncEditor(null);
            renderList();
            setStatus(`Deleted “${record.name}”.`);
        });
    }

    function init(options) {
        captureProcedure = options.captureProcedure;
        loadProcedure = options.loadProcedure;
        if (!panel) buildDOM();
        selectedId = getActiveProcedureId();
        renderList();
    }

    function toggle() {
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        if (opening) renderList();
        return opening;
    }

    function close() {
        panel?.classList.add('hidden');
        document.querySelector('#btn-procedures')?.classList.remove('active');
    }

    return {init, toggle, close};
})();
