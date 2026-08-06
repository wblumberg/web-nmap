const STORAGE_KEY = 'nmap.basemap-style.v1';

const PROJECTIONS = Object.freeze([
    {
        value: 'globe',
        label: 'Adaptive globe',
        description: 'A globe at regional zooms that transitions to Mercator when zoomed in.',
    },
    {
        value: 'mercator',
        label: 'Web Mercator',
        description: 'A flat, rectangular map at every zoom level.',
    },
    {
        value: 'vertical-perspective',
        label: 'Fixed globe',
        description: 'A perspective globe that remains spherical at every zoom level.',
    },
]);
const PROJECTION_VALUES = new Set(PROJECTIONS.map(({ value }) => value));
const appliedProjections = new WeakMap();

const DEFAULT_CONFIG = Object.freeze({
    projection: 'globe',
    backgroundColor: '#000000',
    layers: {
        land:       { visible: true,  color: '#000000', opacity: 1 },
        coastline:  { visible: true,  color: '#ffffff', opacity: 1, width: 4 },
        countries:  { visible: true,  color: '#333333', opacity: 1, width: 2 },
        states:     { visible: true,  color: '#ffffff', opacity: 1, width: 1.5 },
        counties:   { visible: true,  color: '#333333', opacity: 1, width: 1.5 },
        majorRoads: { visible: false, color: '#f5c542', opacity: 0.9, width: 1.5 },
        minorRoads: { visible: false, color: '#6574cd', opacity: 0.75, width: 1 },
        places:     { visible: false, color: '#ffffff', opacity: 1, size: 13 },
    },
});

const CONTROLS = [
    { key: 'land',       label: 'Land', type: 'fill' },
    { key: 'coastline',  label: 'Coastlines', type: 'line' },
    { key: 'countries',  label: 'Country boundaries', type: 'line' },
    { key: 'states',     label: 'States / provinces', type: 'line' },
    { key: 'counties',   label: 'Counties', type: 'line' },
    { key: 'majorRoads', label: 'Major highways', type: 'line' },
    { key: 'minorRoads', label: 'Secondary highways', type: 'line' },
    { key: 'places',     label: 'Places', type: 'symbol' },
];

function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function loadConfig() {
    const defaults = cloneDefaults();
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (!saved || typeof saved !== 'object') return defaults;
        if (PROJECTION_VALUES.has(saved.projection)) {
            defaults.projection = saved.projection;
        }
        if (typeof saved.backgroundColor === 'string') {
            defaults.backgroundColor = saved.backgroundColor;
        }
        for (const key of Object.keys(defaults.layers)) {
            if (saved.layers?.[key] && typeof saved.layers[key] === 'object') {
                Object.assign(defaults.layers[key], saved.layers[key]);
            }
        }
    } catch (_) {
        // Invalid or unavailable local storage should never prevent map startup.
    }
    return defaults;
}

function saveConfig(config) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); }
    catch (_) { /* private browsing / storage quota */ }
}

function setVisibility(map, ids, visible) {
    for (const id of ids) {
        if (map.getLayer(id)) {
            map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
        }
    }
}

function setPaint(map, id, property, value) {
    if (map.getLayer(id)) map.setPaintProperty(id, property, value);
}

function applyLine(map, ids, config) {
    setVisibility(map, ids, config.visible);
    for (const id of ids) {
        setPaint(map, id, 'line-color', config.color);
        setPaint(map, id, 'line-opacity', config.opacity);
        setPaint(map, id, 'line-width', config.width);
    }
}

function applyConfig(map, config) {
    // `isStyleLoaded()` can briefly return false during projection setup even
    // though the style graph and its layers already exist. The setters below
    // are individually guarded by getLayer(), so the style itself is the
    // reliable readiness check here.
    if (!map?.getStyle?.()) return false;

    if (PROJECTION_VALUES.has(config.projection)
            && appliedProjections.get(map) !== config.projection) {
        map.setProjection({ type: config.projection });
        appliedProjections.set(map, config.projection);
    }

    setPaint(map, 'background', 'background-color', config.backgroundColor);

    const land = config.layers.land;
    setVisibility(map, ['lands'], land.visible);
    setPaint(map, 'lands', 'fill-color', land.color);
    setPaint(map, 'lands', 'fill-opacity', land.opacity);

    applyLine(map, ['coastline'], config.layers.coastline);
    applyLine(map, ['countries'], config.layers.countries);
    applyLine(map, ['states_provinces'], config.layers.states);
    applyLine(map, ['counties'], config.layers.counties);

    const major = config.layers.majorRoads;
    applyLine(map, ['major_highways'], major);
    setVisibility(map, ['major_highways_outline'], major.visible);
    setPaint(map, 'major_highways_outline', 'line-color', '#111118');
    setPaint(map, 'major_highways_outline', 'line-opacity', major.opacity * 0.85);
    setPaint(map, 'major_highways_outline', 'line-width', major.width + 3);

    const minor = config.layers.minorRoads;
    applyLine(map, ['secondary_highways'], minor);
    setVisibility(map, ['secondary_highways_outline'], minor.visible);
    setPaint(map, 'secondary_highways_outline', 'line-color', '#111118');
    setPaint(map, 'secondary_highways_outline', 'line-opacity', minor.opacity * 0.75);
    setPaint(map, 'secondary_highways_outline', 'line-width', minor.width + 2.5);

    const places = config.layers.places;
    setVisibility(map, ['places'], places.visible);
    setPaint(map, 'places', 'text-color', places.color);
    setPaint(map, 'places', 'text-opacity', places.opacity);
    if (map.getLayer('places')) map.setLayoutProperty('places', 'text-size', places.size);
    map.triggerRepaint();
    return true;
}

function controlMarkup(definition, config) {
    const widthControl = definition.type === 'line' ? `
        <label class="bm-field">Width
          <input data-property="width" type="range" min="0.5" max="6" step="0.25" value="${config.width}">
          <output data-output="width">${config.width}</output>
        </label>` : '';
    const sizeControl = definition.type === 'symbol' ? `
        <label class="bm-field">Size
          <input data-property="size" type="range" min="8" max="24" step="1" value="${config.size}">
          <output data-output="size">${config.size}</output>
        </label>` : '';
    return `
      <fieldset class="bm-layer" data-layer="${definition.key}">
        <legend>
          <label><input data-property="visible" type="checkbox" ${config.visible ? 'checked' : ''}>
          ${definition.label}</label>
        </legend>
        <div class="bm-layer-controls">
          <label class="bm-field bm-color">Color
            <input data-property="color" type="color" value="${config.color}">
          </label>
          <label class="bm-field">Opacity
            <input data-property="opacity" type="range" min="0" max="1" step="0.05" value="${config.opacity}">
            <output data-output="opacity">${config.opacity}</output>
          </label>
          ${widthControl}${sizeControl}
        </div>
      </fieldset>`;
}

export const BasemapStyleView = (() => {
    let map = null;
    let panel = null;
    let config = loadConfig();
    let styleLoadHandler = null;

    function render() {
        const enabled = Object.values(config.layers).filter(layer => layer.visible).length;
        const projection = PROJECTIONS.find(option => option.value === config.projection)
            || PROJECTIONS[0];
        panel.innerHTML = `
          <header>
            <div><h2>Basemap Style</h2><div class="bm-status-checked">Saved automatically in this browser</div></div>
            <div><button id="bm-reset" type="button">Reset</button><button id="bm-close" type="button" aria-label="Close">&times;</button></div>
          </header>
          <div class="bm-status-summary">
            <span class="enabled"><strong>${enabled}</strong> of ${CONTROLS.length} feature layers enabled</span>
            <span>Changes apply immediately</span>
          </div>
          <div class="bm-body">
            <label class="bm-projection">Map projection
              <select id="bm-projection">
                ${PROJECTIONS.map(option => `<option value="${option.value}" ${option.value === config.projection ? 'selected' : ''}>${option.label}</option>`).join('')}
              </select>
              <span id="bm-projection-description">${projection.description}</span>
            </label>
            <label class="bm-background">Ocean / background
              <input id="bm-background-color" type="color" value="${config.backgroundColor}">
            </label>
            ${CONTROLS.map(def => controlMarkup(def, config.layers[def.key])).join('')}
          </div>`;

        panel.querySelector('#bm-close').addEventListener('click', close);
        panel.querySelector('#bm-projection').addEventListener('change', event => {
            config.projection = event.target.value;
            const selected = PROJECTIONS.find(option => option.value === config.projection);
            panel.querySelector('#bm-projection-description').textContent = selected.description;
            commit();
        });
        panel.querySelector('#bm-background-color').addEventListener('input', event => {
            config.backgroundColor = event.target.value;
            commit();
        });
        panel.querySelectorAll('.bm-layer input').forEach(input => {
            input.addEventListener('input', event => {
                const fieldset = event.target.closest('.bm-layer');
                const property = event.target.dataset.property;
                const layerConfig = config.layers[fieldset.dataset.layer];
                layerConfig[property] = event.target.type === 'checkbox'
                    ? event.target.checked
                    : event.target.type === 'range'
                        ? Number(event.target.value)
                        : event.target.value;
                fieldset.querySelector(`[data-output="${property}"]`)?.replaceChildren(
                    String(layerConfig[property])
                );
                commit();
            });
        });
        panel.querySelector('#bm-reset').addEventListener('click', () => {
            config = cloneDefaults();
            saveConfig(config);
            render();
            applyConfig(map, config);
        });
    }

    function commit() {
        saveConfig(config);
        applyConfig(map, config);
        const enabled = Object.values(config.layers).filter(layer => layer.visible).length;
        const summary = panel?.querySelector('.bm-status-summary .enabled');
        if (summary) summary.innerHTML = `<strong>${enabled}</strong> of ${CONTROLS.length} feature layers enabled`;
    }

    function init(mapInstance) {
        if (map === mapInstance && panel) return;
        map = mapInstance;
        if (!panel) {
            panel = document.createElement('section');
            panel.id = 'basemap-style-panel';
            panel.className = 'hidden';
            document.body.appendChild(panel);
        }
        styleLoadHandler = () => {
            appliedProjections.delete(map);
            applyConfig(map, config);
        };
        map.on('style.load', styleLoadHandler);
        render();
        applyConfig(map, config);
        // MapLibre may finish projection/style reconciliation just after its
        // initial load callback. Reapply on the next frame so persisted values
        // cannot be replaced by that final startup pass.
        requestAnimationFrame(() => applyConfig(map, config));
    }

    function toggle() {
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        return opening;
    }

    function close() {
        panel?.classList.add('hidden');
        document.querySelector('#btn-basemap')?.classList.remove('active');
    }

    return { init, toggle, close };
})();

export { DEFAULT_CONFIG, PROJECTIONS, applyConfig };
