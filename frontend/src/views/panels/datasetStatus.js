import * as CatalogClient from '../../services/api/catalogClient.js';

const REFRESH_MS = 60_000;
let panel;
let timer;

const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function ageLabel(minutes) {
    if (minutes == null) return '—';
    if (minutes < 60) return `${Math.round(minutes)}m`;
    if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
    return `${(minutes / 1440).toFixed(1)}d`;
}

function render(snapshot) {
    const summary = snapshot.summary;
    const button = document.querySelector('#btn-dataset-status');
    const problems = summary.stale + summary.empty + summary.unavailable;
    button.className = `toolbar-btn dataset-status-${problems ? 'warning' : 'healthy'}`;
    button.title = `Datasets: ${summary.healthy} healthy, ${problems} need attention`;
    button.innerHTML = `<span class="dataset-status-dot"></span><span class="dataset-status-count">${problems}</span>`;

    panel.querySelector('.ds-status-summary').innerHTML =
        `<span class="healthy">${summary.healthy} healthy</span>` +
        `<span class="stale">${summary.stale} stale</span>` +
        `<span class="empty">${summary.empty} empty</span>` +
        `<span class="unavailable">${summary.unavailable} unavailable</span>`;
    panel.querySelector('.ds-status-checked').textContent =
        `Checked ${new Date(snapshot.checked_at).toLocaleString()}`;
    panel.querySelector('tbody').innerHTML = snapshot.sources.map(source => `
      <tr data-status="${escapeHtml(source.status)}">
        <td><span class="status-pill ${escapeHtml(source.status)}">${escapeHtml(source.status)}</span></td>
        <td><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.source_id)}</small></td>
        <td>${ageLabel(source.age_minutes)}<small>limit ${ageLabel(source.expected_max_age_minutes)}</small></td>
        <td>${escapeHtml(source.latest_cycle || source.latest_time || '—')}</td>
        <td class="status-message" title="${escapeHtml(source.message || '')}">${escapeHtml(source.message || '—')}</td>
      </tr>`).join('');
}

async function refresh(force = false) {
    const error = panel.querySelector('.ds-status-error');
    const refreshButton = panel.querySelector('#ds-status-refresh');
    refreshButton.disabled = true;
    error.textContent = '';
    try {
        render(await CatalogClient.getDatasetStatus({ refresh: force }));
    } catch (err) {
        error.textContent = `Status check failed: ${err.message}`;
        document.querySelector('#btn-dataset-status').classList.add('dataset-status-warning');
    } finally {
        refreshButton.disabled = false;
    }
}

export const DatasetStatus = {
    init() {
        panel = document.createElement('section');
        panel.id = 'dataset-status-panel';
        panel.className = 'hidden';
        panel.innerHTML = `
          <header><div><h2>Dataset Status</h2><div class="ds-status-checked">Not checked</div></div>
            <div><button id="ds-status-refresh">Refresh</button><button id="ds-status-close" aria-label="Close">×</button></div>
          </header>
          <div class="ds-status-summary"></div><div class="ds-status-error"></div>
          <div class="ds-status-table-wrap"><table><thead><tr>
            <th>Status</th><th>Dataset</th><th>Age</th><th>Latest cycle/time</th><th>Message</th>
          </tr></thead><tbody></tbody></table></div>`;
        document.body.appendChild(panel);
        panel.querySelector('#ds-status-close').addEventListener('click', () => this.close());
        panel.querySelector('#ds-status-refresh').addEventListener('click', () => refresh(true));
        refresh();
        timer = window.setInterval(() => refresh(), REFRESH_MS);
    },
    toggle() {
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        if (opening) refresh();
        return opening;
    },
    close() {
        panel.classList.add('hidden');
        document.querySelector('#btn-dataset-status')?.classList.remove('active');
    },
    destroy() {
        window.clearInterval(timer);
        panel?.remove();
    },
};
