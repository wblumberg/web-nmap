/**
 * products/point.js — Point Data Products
 *
 * Analogous to the station model definitions in NMAP2's prmlst.tbl,
 * each entry here defines a named "station model" — the layout and
 * styling of elements drawn at each observation point on the map.
 *
 *
 * TODO: Eventually include things like local storm reports, vad winds, etc.
 *
 * ─── How the data contract works ───────────────────────────────────────────
 *
 * The compressed JSON for surface obs is expected to be an array of objects,
 * each with this shape (fields may be null if missing):
 *
 *   {
 *     coord: { lon: number, lat: number },
 *     data: {
 *       // Scalars (type: 'number' in SPConfig)
 *       tmpf:   number | null,   // temperature (°F)
 *       dwpf:   number | null,   // dewpoint (°F)
 *       tmpc:   number | null,   // temperature (°C)
 *       dwpc:   number | null,   // dewpoint (°C)
 *       pmsl:   number | null,   // mean sea-level pressure (mb, last 3 digits, e.g. 982.3 → 823)
 *       alti:   number | null,   // altimeter setting (inHg, e.g. 29.92)
 *       vsby:   number | null,   // visibility (miles)
 *       tmpf_6h_max: number | null,  // 6-hour max temperature (°F)
 *       tmpf_6h_min: number | null,  // 6-hour min temperature (°F)
 *       p01i:   number | null,   // 1-hour precip (inches)
 *
 *       // Strings (type: 'string' in SPConfig)
 *       id:     string | null,   // station identifier (ICAO or METAR)
 *
 *       // Vectors: [speed, direction] (type: 'barb' in SPConfig)
 *       // autumnplot-gl's getVector() interprets these as [wspd_kts, wdir_deg]
 *       wind:   [number, number] | null,  // [wind speed (kts), wind direction (deg)]
 *
 *       // Symbols (type: 'symbol' in SPConfig)
 *       // Values must be valid SPSymbol strings (see autumnplot-gl StationPlot.ts)
 *       skyc:   SPSymbol | null,  // sky cover ('0/8' through '8/8', 'obsc', etc.)
 *       preswx: SPSymbol | null,  // present weather ('ra', 'sn', 'ts', etc.)
 *     }
 *   }
 *
 * ─── Station plot position reference ───────────────────────────────────────
 *
 *   ul ── uc ── ur
 *   |             |
 *   cl ──  c ── cr      ← wind barb always at 'c'
 *   |             |         sky cover symbol overlaid at 'c'
 *   ll ── lc ── lr
 *
 *   Standard NMAP2 / WMO layout:
 *     ul = temperature          ur = station id / dewpoint depression
 *     ll = dewpoint             lr = present weather code string
 *     cl = present weather sym  cr = (unused / visibility)
 *     lc = sea-level pressure   uc = cloud cover (alt. position)
 *      c = sky cover symbol + wind barb
 *
 * ─── thin_fac guidance ─────────────────────────────────────────────────────
 *
 *   thin_fac controls how aggressively stations are thinned at low zoom.
 *   Must be a power of 2. Higher = more thinning = fewer stations visible
 *   at continental scale.
 *     4  = very dense (ASOS-only networks)
 *     8  = standard surface obs (ASOS + AWOS)
 *     16 = sparse (buoys, ships, mesonet with many stations)
 */

// ─── Shared formatter helpers ─────────────────────────────────────────────────

// Temperature: round to integer, blank if missing
const fmtTemp    = val => val === null || isNaN(val) ? '' : Math.round(val).toString();

// Dewpoint: same as temperature
const fmtDwpt    = val => val === null || isNaN(val) ? '' : Math.round(val).toString();

// MSLP: WMO 3-digit encoding — show last 3 digits of (mb * 10), drop leading digit
// e.g. 1013.2 mb → "132",  982.4 mb → "824",  1001.8 mb → "018"
const fmtMSLP    = val => {
    if (val === null || isNaN(val)) return '';
    // val expected in mb (e.g. 1013.2)
    const encoded = Math.round(val * 10) % 1000;
    return encoded.toString().padStart(3, '0');
};

// Altimeter setting: show as e.g. "29.92" → "992" (drop leading "2" or "3")
const fmtAlti    = val => {
    if (val === null || isNaN(val)) return '';
    const encoded = Math.round(val * 100) % 1000;
    return encoded.toString().padStart(3, '0');
};

// Visibility: show to 1 decimal place, blank if missing
const fmtVsby    = val => val === null || isNaN(val) ? '' : val.toFixed(1);

// Precipitation: show to 2 decimal places, blank if zero or missing
const fmtPrecip  = val => (val === null || isNaN(val) || val === 0) ? '' : val.toFixed(2);

// Generic number to 1 decimal place
const fmtNum1    = val => val === null || isNaN(val) ? '' : val.toFixed(1);

// Station ID: pass through or blank
const fmtId      = val => val === null ? '' : String(val);


// ─── Shared layer builder ─────────────────────────────────────────────────────
//
// All point products share the same build pattern:
//   1. Construct UnstructuredGrid from obs coordinates
//   2. Construct RawObsField from obs data arrays
//   3. Construct StationPlot with the model's SPConfig
//   4. Wrap in a PlotLayer
//
// This helper encapsulates that pattern so each product definition stays
// focused purely on the station model config (SPConfig).
//
function buildObsLayer(layerId, obsJson, spConfig, opts = {}) {
    const {
        thin_fac   = 8,
        font_size  = 14,
        font_face  = 'Trebuchet MS',
        // If you have a local glyph server, set this; otherwise apgl uses
        // the map style's glyphs URL automatically
        font_url_template = 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
    } = opts;

    const grid  = new apgl.UnstructuredGrid(obsJson.map(o => o.coord));
    const field = new apgl.RawObsField(grid, obsJson.map(o => o.data));
    const plot  = new apgl.StationPlot(field, {
        config: spConfig,
        thin_fac,
        font_size,
        font_face,
        font_url_template,
    });

    return new apgl.PlotLayer(layerId, plot);
}


// ─── Product definitions ──────────────────────────────────────────────────────

export default {

    // ════════════════════════════════════════════════════════════════════════
    // Standard surface model
    // Matches the classic NMAP2 / WMO synoptic station model layout.
    //
    //   tmpf ──── id
    //    |   skyc  |
    //   dwpf ── pmsl
    //
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_standard': {
        label:       'Surface Obs — Standard Model',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_standard',
                data.obs_json,
                {
                    // Upper-left: temperature (°F), red
                    tmpf:   { type: 'number',  pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },

                    // Lower-left: dewpoint (°F), green
                    dwpf:   { type: 'number',  pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },

                    // Upper-right: station ID, white
                    id:     { type: 'string',  pos: 'ur', color: '#ffffff' },

                    // Lower-center: MSL pressure (3-digit WMO encoding), white
                    pmsl:   { type: 'number',  pos: 'lc', color: '#ffffff',
                              formatter: fmtMSLP },

                    // Center-left: present weather symbol, magenta
                    preswx: { type: 'symbol',  pos: 'cl', color: '#ff00ff' },

                    // Center: sky cover symbol (overlaid on wind barb origin)
                    skyc:   { type: 'symbol',  pos: 'c' },

                    // Center: wind barb, white
                    wind:   { type: 'barb',    pos: 'c',  color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 14 }
            );

            return {
                layers:   [layer],
                colorbar: [],
                // Point data sampler: find nearest station to cursor
                // (autumnplot-gl UnstructuredGrid does nearest-neighbor lookup)
                sampler: null,
            };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Temperature / dewpoint only
    // Minimal model — useful as a background field overlay or at high zoom.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_temp_dwpt': {
        label:       'Surface Obs — Temp / Dewpoint',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_tempdwpt',
                data.obs_json,
                {
                    tmpf:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },
                    dwpf:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },
                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                    skyc:   { type: 'symbol', pos: 'c' },
                },
                { thin_fac: 8, font_size: 14 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Metric temperature / dewpoint model (°C)
    // For users working in SI units.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_metric': {
        label:       'Surface Obs — Metric (°C)',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_metric',
                data.obs_json,
                {
                    tmpc:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },
                    dwpc:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },
                    pmsl:   { type: 'number', pos: 'lc', color: '#ffffff',
                              formatter: fmtMSLP },
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },
                    skyc:   { type: 'symbol', pos: 'c' },
                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 14 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Pressure / altimeter model
    // Shows MSLP and altimeter setting — useful for synoptic analysis.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_pressure': {
        label:       'Surface Obs — Pressure',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_pressure',
                data.obs_json,
                {
                    tmpf:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },
                    dwpf:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },

                    // Lower-center: MSLP in WMO 3-digit encoding, yellow
                    pmsl:   { type: 'number', pos: 'lc', color: '#ffff00',
                              formatter: fmtMSLP },

                    // Upper-center: altimeter setting (3-digit), cyan
                    alti:   { type: 'number', pos: 'uc', color: '#00ffff',
                              formatter: fmtAlti },

                    skyc:   { type: 'symbol', pos: 'c' },
                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 14 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Wind / sky cover only
    // Very sparse model — useful as a wind analysis overlay.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_wind': {
        label:       'Surface Obs — Wind / Sky Cover',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_wind',
                data.obs_json,
                {
                    skyc:  { type: 'symbol', pos: 'c' },
                    wind:  { type: 'barb',   pos: 'c', color: '#ffffff' },
                },
                // Lower thin_fac = more stations visible at continental scale
                // appropriate since this is a sparse model with few elements
                { thin_fac: 4, font_size: 14 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Visibility / present weather model
    // Useful for IFR/MVFR analysis and winter weather events.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_aviation': {
        label:       'Surface Obs — Aviation (Vis / Wx)',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_aviation',
                data.obs_json,
                {
                    // Upper-left: temperature (°F)
                    tmpf:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },

                    // Lower-left: dewpoint (°F)
                    dwpf:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },

                    // Upper-right: visibility (miles), orange
                    vsby:   { type: 'number', pos: 'ur', color: '#ff8800',
                              formatter: fmtVsby },

                    // Center-left: present weather symbol, magenta
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },

                    // Center: sky cover + wind barb
                    skyc:   { type: 'symbol', pos: 'c' },
                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 13 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Precipitation model
    // Shows 1-hour precip accumulation — useful during active weather events.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_precip': {
        label:       'Surface Obs — Precipitation',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_precip',
                data.obs_json,
                {
                    tmpf:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },
                    dwpf:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },

                    // Lower-right: 1-hour precip (inches), cyan
                    // Blank when zero — avoids cluttering the display
                    p01i:   { type: 'number', pos: 'lr', color: '#00ffff',
                              formatter: fmtPrecip },

                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },
                    skyc:   { type: 'symbol', pos: 'c' },
                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 14 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Full synoptic model
    // Shows all available fields — use at high zoom (city/county scale).
    // High thin_fac needed because of dense layout.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_full_synoptic': {
        label:       'Surface Obs — Full Synoptic',
        group:       'point',
        available_for: ['SURFACE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_full',
                data.obs_json,
                {
                    // All 9 positions populated
                    tmpf:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },
                    dwpf:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },
                    id:     { type: 'string', pos: 'ur', color: '#ffffff',
                              formatter: fmtId },
                    pmsl:   { type: 'number', pos: 'lc', color: '#ffff00',
                              formatter: fmtMSLP },
                    vsby:   { type: 'number', pos: 'cr', color: '#ff8800',
                              formatter: fmtVsby },
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },
                    skyc:   { type: 'symbol', pos: 'c' },
                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                },
                // Higher thin_fac for the densest model to avoid overlap
                { thin_fac: 16, font_size: 13 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Mesonet model
    // For high-density mesonet networks (Oklahoma Mesonet, etc.) where
    // stations are closer together and thin_fac must be larger.
    // Uses 2m T/Td in °F + wind + sky cover only.
    // ════════════════════════════════════════════════════════════════════════

    'mesonet_standard': {
        label:       'Mesonet — Standard',
        group:       'point',
        available_for: ['MESONET'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'mesonet_standard',
                data.obs_json,
                {
                    tmpf:  { type: 'number', pos: 'ul', color: '#cc0000',
                             formatter: fmtTemp },
                    dwpf:  { type: 'number', pos: 'll', color: '#00aa00',
                             formatter: fmtDwpt },
                    wind:  { type: 'barb',   pos: 'c',  color: '#ffff00' },
                },
                // Aggressive thinning for high-density networks
                { thin_fac: 16, font_size: 12 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Buoy / marine model
    // Buoys report wave height and water temperature in addition to standard
    // met variables — shown in non-standard positions.
    // ═══════���════════════════════════════════════════════════════════════════

    'marine_obs': {
        label:       'Marine Obs — Buoys / Ships',
        group:       'point',
        available_for: ['MARINE_OBS'],
        data_keys:   ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'marine_obs',
                data.obs_json,
                {
                    // Air temperature (°F) upper-left
                    tmpf:   { type: 'number', pos: 'ul', color: '#cc0000',
                              formatter: fmtTemp },

                    // Dewpoint (°F) lower-left
                    dwpf:   { type: 'number', pos: 'll', color: '#00aa00',
                              formatter: fmtDwpt },

                    // Water temperature (°F) upper-right, teal
                    // Key name 'wtmp' — must be present in obs JSON data
                    wtmp:   { type: 'number', pos: 'ur', color: '#00cccc',
                              formatter: fmtTemp },

                    // Significant wave height (ft) lower-right, orange
                    // Key name 'wvht'
                    wvht:   { type: 'number', pos: 'lr', color: '#ff8800',
                              formatter: fmtNum1 },

                    wind:   { type: 'barb',   pos: 'c',  color: '#ffffff' },
                    skyc:   { type: 'symbol', pos: 'c' },
                },
                // Buoys are sparse — lower thin_fac than surface obs
                { thin_fac: 4, font_size: 13 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

};
