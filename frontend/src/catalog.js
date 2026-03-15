/**
 * catalog.js — Dataset Registry for web-nmap
 *
 * Analogous to GEMPAK's datatype.tbl.  This module provides:
 *
 *   DataRegistry  — links catalog IDs to their JavaScript makeLayers
 *                   implementations.  Call DataRegistry.register(id, fn)
 *                   from main.js for each implemented dataset.
 *
 *   DataCatalog   — loads and exposes the catalog.json metadata, and builds
 *                   the `views` map consumed by the map UI.
 *
 * Path-template tokens (used in catalog.json "path_template" fields):
 *   {YYYY}  — 4-digit year
 *   {YY}    — 2-digit year
 *   {MM}    — 2-digit month (01–12)
 *   {DD}    — 2-digit day (01–31)
 *   {DDD}   — 3-digit Julian day (001–366)
 *   {HH}    — 2-digit UTC hour (00–23)
 *   {mm}    — 2-digit minute (00–59)
 *   {ss}    — 2-digit second (00–59)
 *   {FFF}   — 3-digit forecast hour (000–384)
 *   {SITE}  — uppercase ICAO/WSR-88D site identifier (e.g. "KTLX")
 *   {REGION}— region code
 *
 * Category constants (matches "category" values in catalog.json):
 *   MODEL_DET     — deterministic model forecasts
 *   MODEL_ENS     — ensemble model forecasts
 *   ANALYSIS      — objective/gridded analyses
 *   SATELLITE     — satellite imagery
 *   RADAR_MOSAIC  — multi-site radar mosaics
 *   RADAR_NEXRAD  — single-site NEXRAD products
 *   OBS_UPPERAIR  — upper-air observations
 *   OBS_SURFACE   — surface observations
 *   MISC          — miscellaneous point/polygon datasets
 */

'use strict';

// ---------------------------------------------------------------------------
// Category constants
// ---------------------------------------------------------------------------
const DataCategory = Object.freeze({
    MODEL_DET:    'MODEL_DET',
    MODEL_ENS:    'MODEL_ENS',
    ANALYSIS:     'ANALYSIS',
    SATELLITE:    'SATELLITE',
    RADAR_MOSAIC: 'RADAR_MOSAIC',
    RADAR_NEXRAD: 'RADAR_NEXRAD',
    OBS_UPPERAIR: 'OBS_UPPERAIR',
    OBS_SURFACE:  'OBS_SURFACE',
    MISC:         'MISC',
});

const DataCategoryLabel = Object.freeze({
    MODEL_DET:    'Deterministic Models',
    MODEL_ENS:    'Ensemble Models',
    ANALYSIS:     'Analyses',
    SATELLITE:    'Satellite',
    RADAR_MOSAIC: 'Radar Mosaics',
    RADAR_NEXRAD: 'NEXRAD (Single Site)',
    OBS_UPPERAIR: 'Upper Air Observations',
    OBS_SURFACE:  'Surface Observations',
    MISC:         'Miscellaneous',
});

// ---------------------------------------------------------------------------
// DataRegistry — maps catalog IDs to makeLayers implementations
// ---------------------------------------------------------------------------
export const DataRegistry = (() => {
    const _handlers = {};

    return {
        /**
         * Register a makeLayers function for a catalog entry.
         * @param {string} id          - catalog entry id
         * @param {Function} makeLayers - async function () => { layers, colorbar?, sampler? }
         */
        register(id, makeLayers) {
            if (typeof makeLayers !== 'function') {
                console.warn(`DataRegistry.register: makeLayers for "${id}" is not a function`);
                return;
            }
            _handlers[id] = makeLayers;
        },

        /** Return the makeLayers function for an id, or null if unregistered. */
        get(id) {
            return _handlers[id] || null;
        },

        /** True if a makeLayers function has been registered for id. */
        has(id) {
            return id in _handlers;
        },

        /** Return an array of all registered IDs. */
        registeredIds() {
            return Object.keys(_handlers);
        },

        /**
         * Build the `views` map from a loaded catalog array.
         * Only entries where enabled===true AND a makeLayers is registered are included.
         *
         * @param {Object[]} catalogEntries - array parsed from catalog.json
         * @returns {Object} views map keyed by catalog id
         */
        buildViews(catalogEntries) {
            const views = {};
            for (const entry of catalogEntries) {
                if (!entry.enabled) continue;
                const makeLayers = _handlers[entry.id];
                if (!makeLayers) continue;

                views[entry.id] = {
                    // Display
                    name:        entry.name,
                    description: entry.description,
                    // Classification
                    category:    entry.category,
                    subcategory: entry.subcategory || null,
                    tags:        entry.tags || [],
                    // Temporal
                    temporal_frequency_min: entry.temporal_frequency_min,
                    time_range_hr:          entry.time_range_hr,
                    has_forecast_hour:      entry.has_forecast_hour,
                    // Access
                    path_template: entry.path_template,
                    data_format:   entry.data_format,
                    dtype:         entry.dtype,
                    // Spatial
                    grid:          entry.grid || null,
                    // UI
                    maxZoom: entry.max_zoom,
                    // Implementation
                    makeLayers,
                };
            }
            return views;
        },
    };
})();

// ---------------------------------------------------------------------------
// DataCatalog — async loader and helpers
// ---------------------------------------------------------------------------
export const DataCatalog = (() => {
    let _entries = [];

    return {
        /**
         * Fetch and parse catalog.json.  Must be awaited before calling
         * buildViews or any other query methods.
         *
         * @param {string} [url='data/catalog.json']
         */
        async load(url) {
            url = url || 'data/catalog.json';
            const resp = await fetch(url);
            if (!resp.ok) {
                throw new Error(`DataCatalog: failed to load catalog from "${url}" (${resp.status})`);
            }
            _entries = await resp.json();
            console.info(`DataCatalog: loaded ${_entries.length} entries from "${url}"`);
        },

        /** Return all catalog entries (may include unimplemented/disabled ones). */
        all() {
            return _entries.slice();
        },

        /** Return entries filtered by category. */
        byCategory(category) {
            return _entries.filter(e => e.category === category);
        },

        /** Return the entry for a given id, or null. */
        byId(id) {
            return _entries.find(e => e.id === id) || null;
        },

        /** Return entries whose tags include any of the provided search terms (case-insensitive). */
        search(terms) {
            const lower = (typeof terms === 'string' ? [terms] : terms)
                .map(t => t.toLowerCase());
            return _entries.filter(e =>
                lower.some(t =>
                    e.name.toLowerCase().includes(t) ||
                    e.description.toLowerCase().includes(t) ||
                    (e.tags || []).some(tag => tag.toLowerCase().includes(t))
                )
            );
        },

        /**
         * Expand a path_template string for a specific time and optional extras.
         *
         * @param {string} template - path template with tokens
         * @param {Date}   dt       - valid time (UTC)
         * @param {Object} [extra]  - additional replacements, e.g. { SITE: 'KTLX', FFF: '036' }
         * @returns {string}
         */
        expandPath(template, dt, extra) {
            if (!template) return null;
            const pad = (n, w) => String(n).padStart(w, '0');
            const jday = Math.floor((dt - new Date(dt.getUTCFullYear(), 0, 0)) / 86400000);

            let out = template
                .replace('{YYYY}', pad(dt.getUTCFullYear(), 4))
                .replace('{YY}',   pad(dt.getUTCFullYear() % 100, 2))
                .replace('{MM}',   pad(dt.getUTCMonth() + 1, 2))
                .replace('{DD}',   pad(dt.getUTCDate(), 2))
                .replace('{DDD}',  pad(jday, 3))
                .replace('{HH}',   pad(dt.getUTCHours(), 2))
                .replace('{mm}',   pad(dt.getUTCMinutes(), 2))
                .replace('{ss}',   pad(dt.getUTCSeconds(), 2));

            if (extra) {
                for (const [k, v] of Object.entries(extra)) {
                    out = out.replace(`{${k}}`, v);
                }
            }
            return out;
        },

        /** Build the views map — convenience wrapper around DataRegistry.buildViews. */
        buildViews() {
            return DataRegistry.buildViews(_entries);
        },
    };
})();

// Expose globals for use by main.js (plain-script environment)
window.DataCategory     = DataCategory;
window.DataCategoryLabel = DataCategoryLabel;
window.DataRegistry     = DataRegistry;
window.DataCatalog      = DataCatalog;
