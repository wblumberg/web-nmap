/**
 * dataProducts/alerts.js — NWS Watch / Warning / Advisory Products
 *
 * Uses autumnplot-gl's GeometryComponent to render NWS VTEC alert polygons
 * as a native WebGL layer alongside other data products.
 *
 * ─── Data contract ───────────────────────────────────────────────────────────
 *
 * Each entry's `data_keys` is an array of VTEC phenomenon slugs, e.g.:
 *   ['flash_flood']              → single-phen product
 *   ['flash_flood', 'areal_flood', 'river_flood'] → multi-phen product
 *   ['_all']                     → all phenomena for the source's sig level
 *
 * `_loadGeometrySource` in appController.js fetches one GeoJSON
 * FeatureCollection per slug via:
 *   GET /api/v1/geometries/{WARNINGS|WATCHES|ADVISORIES}/features?at=<ISO>&phen=<slug>
 * (omits `phen` when slug is '_all')
 *
 * make_layers() receives:
 *   data.flash_flood  → GeoJSON FeatureCollection
 *   data._all         → GeoJSON FeatureCollection (all phen)
 *
 * GeoJSON feature properties (from alerts_sql.py):
 *   phen, significance, action, start_utc, end_utc, office, etn, counties
 *
 * ─── Color scheme ────────────────────────────────────────────────────────────
 * NWS standard VTEC phenomenon colors keyed by 2-letter VTEC code.
 */

// ─── VTEC phen code → NWS standard fill / outline colors ─────────────────────
const VTEC_COLORS = {
    'TO': { fill: '#ff0000', outline: '#ff0000' },   // Tornado
    'SV': { fill: '#ffa500', outline: '#ffa500' },   // Severe Thunderstorm
    'FF': { fill: '#00ff00', outline: '#228b22' },   // Flash Flood
    'FA': { fill: '#7cfc00', outline: '#228b22' },   // Areal Flood
    'FL': { fill: '#00ff7f', outline: '#2e8b57' },   // River Flood
    'WS': { fill: '#ff69b4', outline: '#ff69b4' },   // Winter Storm
    'WW': { fill: '#7b68ee', outline: '#7b68ee' },   // Winter Weather
    'BZ': { fill: '#ff4500', outline: '#ff4500' },   // Blizzard
    'IS': { fill: '#8b008b', outline: '#8b008b' },   // Ice Storm
    'HS': { fill: '#6495ed', outline: '#6495ed' },   // Heavy Snow
    'LE': { fill: '#87cefa', outline: '#87cefa' },   // Lake Effect Snow
    'ZR': { fill: '#da70d6', outline: '#da70d6' },   // Freezing Rain
    'HW': { fill: '#daa520', outline: '#daa520' },   // High Wind
    'WI': { fill: '#d2b48c', outline: '#d2b48c' },   // Wind
    'EW': { fill: '#ff8c00', outline: '#ff8c00' },   // Extreme Wind
    'FZ': { fill: '#483d8b', outline: '#6495ed' },   // Freeze
    'HZ': { fill: '#9400d3', outline: '#9400d3' },   // Hard Freeze
    'FR': { fill: '#6495ed', outline: '#add8e6' },   // Frost
    'FW': { fill: '#ff1493', outline: '#ff1493' },   // Fire Weather (Red Flag)
    'FG': { fill: '#708090', outline: '#708090' },   // Dense Fog
    'SM': { fill: '#f5deb3', outline: '#c2a96d' },   // Dense Smoke
    'EH': { fill: '#c71585', outline: '#c71585' },   // Excessive Heat
    'HT': { fill: '#ff7f50', outline: '#ff7f50' },   // Heat
    'CF': { fill: '#6495ed', outline: '#4169e1' },   // Coastal Flood
    'SU': { fill: '#ba55d3', outline: '#ba55d3' },   // High Surf
    'DS': { fill: '#ffe4c4', outline: '#deb887' },   // Dust Storm
    'AS': { fill: '#808000', outline: '#808000' },   // Air Stagnation
    'HU': { fill: '#dc143c', outline: '#dc143c' },   // Hurricane
    'TY': { fill: '#dc143c', outline: '#dc143c' },   // Typhoon
    'TR': { fill: '#b22222', outline: '#b22222' },   // Tropical Storm
    '__default__': { fill: '#aaaaaa', outline: '#ffffff' },
};

// ─── Slug → 2-letter VTEC code ───────────────────────────────────────────────
// Mirrors ALERT_PHEN_LABELS from alerts_sql.py (lowercase + underscores).
const PHEN_SLUG_TO_CODE = {
    'tornado':              'TO',
    'severe_thunderstorm':  'SV',
    'flash_flood':          'FF',
    'areal_flood':          'FA',
    'river_flood':          'FL',
    'winter_storm':         'WS',
    'winter_weather':       'WW',
    'blizzard':             'BZ',
    'ice_storm':            'IS',
    'heavy_snow':           'HS',
    'lake_effect_snow':     'LE',
    'freezing_rain':        'ZR',
    'high_wind':            'HW',
    'wind':                 'WI',
    'extreme_wind':         'EW',
    'freeze':               'FZ',
    'hard_freeze':          'HZ',
    'frost':                'FR',
    'fire_weather':         'FW',
    'dense_fog':            'FG',
    'dense_smoke':          'SM',
    'excessive_heat':       'EH',
    'heat':                 'HT',
    'coastal_flood':        'CF',
    'high_surf':            'SU',
    'dust_storm':           'DS',
    'air_stagnation':       'AS',
    'hurricane':            'HU',
    'typhoon':              'TY',
    'tropical_storm':       'TR',
};

const PHEN_LABELS = {
    'TO': 'Tornado',
    'SV': 'Severe Thunderstorm',
    'FF': 'Flash Flood',
    'FA': 'Areal Flood',
    'FL': 'River Flood',
    'WS': 'Winter Storm',
    'WW': 'Winter Weather',
    'BZ': 'Blizzard',
    'IS': 'Ice Storm',
    'HS': 'Heavy Snow',
    'LE': 'Lake Effect Snow',
    'ZR': 'Freezing Rain',
    'HW': 'High Wind',
    'WI': 'Wind',
    'EW': 'Extreme Wind',
    'FZ': 'Freeze',
    'HZ': 'Hard Freeze',
    'FR': 'Frost',
    'FW': 'Fire Weather',
    'FG': 'Dense Fog',
    'SM': 'Dense Smoke',
    'EH': 'Excessive Heat',
    'HT': 'Heat',
    'CF': 'Coastal Flood',
    'SU': 'High Surf',
    'DS': 'Dust Storm',
    'AS': 'Air Stagnation',
    'HU': 'Hurricane',
    'TY': 'Typhoon',
    'TR': 'Tropical Storm',
};

const SIG_LABELS = { 'W': 'Warning', 'A': 'Watch', 'Y': 'Advisory' };

// ─── Per-frame sampler factory ───────────────────────────────────────────────
//
// Each call to _makeLayers() returns a NEW sampler closure that captures the
// specific GeometryComponent built for that frame.  layerBuilder.js tracks
// one sampler per key so _activeSampler is always swapped to match the
// currently-displayed frame when the user steps through time.
function _makeSampler(comp) {
    return function _alertSampler(lon, lat) {
        if (!comp?.queryPoint) return null;
        const hits = comp.queryPoint(lon, lat);
        if (!hits.length) return null;

        const labels = hits.map(f => {
            const p = f.properties ?? {};
            const phenLabel = PHEN_LABELS[p.phen] ?? p.phen ?? '?';
            const sigLabel  = SIG_LABELS[p.significance] ?? '';
            const offices   = Array.isArray(p.offices) ? p.offices.join('/') : (p.office ?? '');
            const etn       = p.etn ? `#${p.etn}` : '';
            return offices
                ? `${phenLabel} ${sigLabel} (${offices} ${etn})`
                : `${phenLabel} ${sigLabel} ${etn}`;
        });

        return { Alert: labels.join(' | ') };
    };
}

function _vtecColor(phenCode) {
    return VTEC_COLORS[phenCode] ?? VTEC_COLORS['__default__'];
}

function _slugColor(slug) {
    return _vtecColor(PHEN_SLUG_TO_CODE[slug]);
}

// ─── GeoJSON → GeometryFeature[] ─────────────────────────────────────────────
//
// Convert a GeoJSON FeatureCollection of alert polygons into the
// GeometryFeature[] shape expected by apgl.GeometryComponent.
//
// Color priority:
//   1. Use the feature's `phen` property (2-letter VTEC code) when present
//      (works for '_all' queries that contain mixed phenomena).
//   2. Fall back to the product slug's color (single-phen products).
//
function _fcToGeomFeatures(fc, fallbackSlug = null) {
    if (!fc?.features?.length) return [];

    return fc.features.flatMap(f => {
        if (!f.geometry) return [];

        const phen   = f.properties?.phen;
        const colors = phen ? _vtecColor(phen) : _slugColor(fallbackSlug);

        return [{
            geometry:   f.geometry,
            properties: f.properties ?? {},
            style: {
                fill_color:      colors.fill,
                fill_opacity:    0,
                outline_color:   colors.outline,
                outline_width:   2,
                outline_opacity: 1.0,
                outline_style:   '-',
            },
        }];
    });
}

// ─── Layer factory ────────────────────────────────────────────────────────────
//
// Given the data object and a list of slugs (data_keys), combine all
// FeatureCollections into a single GeometryComponent PlotLayer.
//
function _makeLayer(layerId, data, slugs) {
    const features = slugs.flatMap(slug =>
        _fcToGeomFeatures(
            data[slug] ?? { type: 'FeatureCollection', features: [] },
            slug,
        )
    );
    return new apgl.GeometryComponent(features);
}

// ─── Shared make_layers helper ────────────────────────────────────────────────
function _makeLayers(layerId, data, slugs) {
    // Build the component for this specific frame and capture it in the sampler
    // closure so that layerBuilder.js can track one sampler per key.
    const geomComp = _makeLayer(layerId, data, slugs);
    return {
        layers:   [new apgl.PlotLayer(layerId, geomComp)],
        colorbar: [],
        sampler:  _makeSampler(geomComp),
    };
}

// ─── Product registry ─────────────────────────────────────────────────────────
export default {

    // ══════════════════════════════════════════════════════════════════════
    // WARNINGS (VTEC significance = W)
    // Source: GET /api/v1/geometries/WARNINGS/features?at=<ISO>&phen=<slug>
    // ══════════════════════════════════════════════════════════════════════

    'warnings_all': {
        label:         'All Active Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['_all'],
        make_layers(data, _grid) { return _makeLayers('warnings_all',  data, ['_all']); },
    },

    'warnings_tornado': {
        label:         'Tornado Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['tornado'],
        make_layers(data, _grid) { return _makeLayers('warnings_to',   data, ['tornado']); },
    },

    'warnings_severe_thunderstorm': {
        label:         'Severe Thunderstorm Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['severe_thunderstorm'],
        make_layers(data, _grid) { return _makeLayers('warnings_sv',   data, ['severe_thunderstorm']); },
    },

    'warnings_convective': {
        label:         'Tornado + Severe Thunderstorm Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['tornado', 'severe_thunderstorm'],
        make_layers(data, _grid) { return _makeLayers('warnings_convective', data, ['tornado', 'severe_thunderstorm']); },
    },

    'warnings_flash_flood': {
        label:         'Flash Flood Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['flash_flood'],
        make_layers(data, _grid) { return _makeLayers('warnings_ff',   data, ['flash_flood']); },
    },

    'warnings_flood': {
        label:         'Flood Warnings (Flash + Areal + River)',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['flash_flood', 'areal_flood', 'river_flood'],
        make_layers(data, _grid) { return _makeLayers('warnings_flood', data, ['flash_flood', 'areal_flood', 'river_flood']); },
    },

    'warnings_winter': {
        label:         'Winter Storm / Blizzard / Ice Storm Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['winter_storm', 'blizzard', 'ice_storm', 'heavy_snow'],
        make_layers(data, _grid) { return _makeLayers('warnings_winter', data, ['winter_storm', 'blizzard', 'ice_storm', 'heavy_snow']); },
    },

    'warnings_freeze': {
        label:         'Freeze / Hard Freeze / Frost Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['freeze', 'hard_freeze', 'frost'],
        make_layers(data, _grid) { return _makeLayers('warnings_freeze', data, ['freeze', 'hard_freeze', 'frost']); },
    },

    'warnings_wind': {
        label:         'High Wind / Extreme Wind Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['high_wind', 'extreme_wind'],
        make_layers(data, _grid) { return _makeLayers('warnings_wind', data, ['high_wind', 'extreme_wind']); },
    },

    'warnings_fire_weather': {
        label:         'Red Flag Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['fire_weather'],
        make_layers(data, _grid) { return _makeLayers('warnings_fw',  data, ['fire_weather']); },
    },

    'warnings_fog': {
        label:         'Dense Fog / Dense Smoke Warnings',
        group:         'alerts',
        available_for: ['WARNINGS'],
        data_keys:     ['dense_fog', 'dense_smoke'],
        make_layers(data, _grid) { return _makeLayers('warnings_fog', data, ['dense_fog', 'dense_smoke']); },
    },

    // ══════════════════════════════════════════════════════════════════════
    // WATCHES (VTEC significance = A)
    // Source: GET /api/v1/geometries/WATCHES/features?at=<ISO>&phen=<slug>
    // ══════════════════════════════════════════════════════════════════════

    'watches_all': {
        label:         'All Active Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['_all'],
        make_layers(data, _grid) { return _makeLayers('watches_all',  data, ['_all']); },
    },

    'watches_tornado': {
        label:         'Tornado Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['tornado'],
        make_layers(data, _grid) { return _makeLayers('watches_to',   data, ['tornado']); },
    },

    'watches_severe_thunderstorm': {
        label:         'Severe Thunderstorm Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['severe_thunderstorm'],
        make_layers(data, _grid) { return _makeLayers('watches_sv',   data, ['severe_thunderstorm']); },
    },

    'watches_convective': {
        label:         'Tornado + Severe Thunderstorm Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['tornado', 'severe_thunderstorm'],
        make_layers(data, _grid) { return _makeLayers('watches_convective', data, ['tornado', 'severe_thunderstorm']); },
    },

    'watches_flood': {
        label:         'Flash Flood / Flood Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['flash_flood', 'areal_flood', 'river_flood'],
        make_layers(data, _grid) { return _makeLayers('watches_flood', data, ['flash_flood', 'areal_flood', 'river_flood']); },
    },

    'watches_winter': {
        label:         'Winter Storm / Blizzard Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['winter_storm', 'blizzard'],
        make_layers(data, _grid) { return _makeLayers('watches_winter', data, ['winter_storm', 'blizzard']); },
    },

    'watches_fire_weather': {
        label:         'Fire Weather Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['fire_weather'],
        make_layers(data, _grid) { return _makeLayers('watches_fw',  data, ['fire_weather']); },
    },

    'watches_wind': {
        label:         'High Wind Watches',
        group:         'alerts',
        available_for: ['WATCHES'],
        data_keys:     ['high_wind'],
        make_layers(data, _grid) { return _makeLayers('watches_wind', data, ['high_wind']); },
    },

    // ══════════════════════════════════════════════════════════════════════
    // ADVISORIES (VTEC significance = Y)
    // Source: GET /api/v1/geometries/ADVISORIES/features?at=<ISO>&phen=<slug>
    // ══════════════════════════════════════════════════════════════════════

    'advisories_all': {
        label:         'All Active Advisories',
        group:         'alerts',
        available_for: ['ADVISORIES'],
        data_keys:     ['_all'],
        make_layers(data, _grid) { return _makeLayers('advisories_all',    data, ['_all']); },
    },

    'advisories_winter_weather': {
        label:         'Winter Weather Advisory',
        group:         'alerts',
        available_for: ['ADVISORIES'],
        data_keys:     ['winter_weather'],
        make_layers(data, _grid) { return _makeLayers('advisories_ww',     data, ['winter_weather']); },
    },

    'advisories_freeze': {
        label:         'Freeze / Frost Advisory',
        group:         'alerts',
        available_for: ['ADVISORIES'],
        data_keys:     ['freeze', 'frost'],
        make_layers(data, _grid) { return _makeLayers('advisories_freeze', data, ['freeze', 'frost']); },
    },

    'advisories_fog': {
        label:         'Dense Fog Advisory',
        group:         'alerts',
        available_for: ['ADVISORIES'],
        data_keys:     ['dense_fog'],
        make_layers(data, _grid) { return _makeLayers('advisories_fg',     data, ['dense_fog']); },
    },

    'advisories_wind': {
        label:         'Wind Advisory',
        group:         'alerts',
        available_for: ['ADVISORIES'],
        data_keys:     ['wind'],
        make_layers(data, _grid) { return _makeLayers('advisories_wi',     data, ['wind']); },
    },

    'advisories_heat': {
        label:         'Heat / Excessive Heat Advisory',
        group:         'alerts',
        available_for: ['ADVISORIES'],
        data_keys:     ['heat', 'excessive_heat'],
        make_layers(data, _grid) { return _makeLayers('advisories_heat',   data, ['heat', 'excessive_heat']); },
    },
};
