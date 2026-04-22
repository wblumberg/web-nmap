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
const fmtTemp = val => isMissing(val) ? '' : Math.round(val).toString();

// Dewpoint: same as temperature
const fmtDwpt = fmtTemp;

// MSLP: WMO 3-digit encoding — show last 3 digits of (mb * 10), drop leading digit
// e.g. 1013.2 mb → "132",  982.4 mb → "824",  1001.8 mb → "018"
const fmtMSLP = val => {
    if (isMissing(val)) return '';
    const encoded = Math.round(val * 10) % 1000;
    return encoded.toString().padStart(3, '0');
};

// Altimeter setting: show as e.g. "29.92" → "992" (drop leading "2" or "3")
const fmtAlti = val => {
    if (isMissing(val)) return '';
    const encoded = Math.round(val * 100) % 1000;
    return encoded.toString().padStart(3, '0');
};

// Visibility: show to 1 decimal place, blank if missing
const fmtVsby = val => isMissing(val) ? '' : val.toFixed(1);

// Precipitation: show to 2 decimal places, blank if zero or missing
const fmtPrecip = val => (isMissing(val) || val === 0) ? '' : val.toFixed(2);

// Generic number to 1 decimal place
const fmtNum1 = val => isMissing(val) ? '' : val.toFixed(1);

// Station ID: pass through or blank
const fmtId = val => val === null ? '' : String(val);

// --- Shared unit conversions and chaining functions
const pipe = (...fns) => val =>
    fns.reduce((v, fn) => fn(v), val);

const isMissing = val => val === null || isNaN(val);
const safe = fn => val => isMissing(val) ? null : fn(val);

// Temperature
const cToF = safe(c => (c * 9 / 5) + 32);
const fToC = safe(f => (f - 32) * 5 / 9);

// Wind
const ktToMs = safe(kt => kt * 0.514444);
const msToKt = safe(ms => ms / 0.514444);

// Distance / height
const mToFt = safe(m => m * 3.28084);
const ftToM = safe(ft => ft / 3.28084);

// Length
const inToCm = safe(inches => inches * 2.54);
const cmToIn = safe(cm => cm / 2.54);

// Pressure
const mbToInHg = safe(mb => mb * 0.02953);
const inHgToMb = safe(inHg => inHg / 0.02953);

/**
 * Convert a GEMPAK wnum (WMO present weather code 00–99) to an SPSymbol
 * string understood by autumnplot-gl's StationPlot.
 * Returns null for codes with no meaningful visual representation.
 */
function wnumToSymbol(wnum) {
    // Index = wnum value.  null = no symbol (clear / no present weather).
    const TABLE = [
        // 00    01    02    03    04     05    06     07       08    09
        null, null, null, null, 'fu', 'hz', 'du', 'drdu', 'po', 'vcds',
        // 10    11      12      13      14        15      16      17      18    19
        'br', 'prfg', 'mifg', 'thdr', 'virga', 'vcsh', 'vcsh', 'vcts', 'sq', 'fc',
        // 20     21     22     23       24       25       26       27       28    29
        '-dz', '-ra', '-sn', '-rasn', '-fzdz', '-shra', '-shsn', '-shgr', 'fg', 'ts',
        // 30    31    32    33     34     35     36      37       38      39
        'ds', 'ds', 'ds', '+ds', '+ds', '+ds', 'drsn', '+drsn', 'blsn', '+blsn',
        // 40      41      42    43    44    45    46    47    48      49
        'vcfg', 'bcfg', 'fg', 'fg', 'fg', 'fg', 'fg', 'fg', 'fzfg', 'fzfg',
        // 50     51     52    53    54     55     56       57      58       59
        '-dz', '-dz', 'dz', 'dz', '+dz', '+dz', '-fzdz', 'fzdz', '-dzra', 'dzra',
        // 60     61     62    63    64     65     66       67      68       69
        '-ra', '-ra', 'ra', 'ra', '+ra', '+ra', '-fzra', 'fzra', '-rasn', 'rasn',
        // 70     71     72    73    74     75     76    77    78    79
        '-sn', '-sn', 'sn', 'sn', '+sn', '+sn', 'ic', 'sg', 'ic', 'pl',
        // 80       81      82       83          84          85       86       87       88      89
        '-shra', 'shra', '+shra', '-shrasn', 'shrasn', '-shsn', 'shsn', '-shgs', 'shgs', '-shgr',
        // 90      91      92      93      94      95      96      97       98      99
        'shgr', 'tsra', 'tsra', 'tssn', 'tssn', 'tsra', 'tsgr', '+tsra', 'tsds', '+tsgr',
    ];
    if (wnum == null || isNaN(wnum) || wnum < 0 || wnum > 99) return null;
    return TABLE[Math.round(wnum)] ?? null;
}

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
        thin_fac = 8,
        font_size = 14,
        font_face = 'Trebuchet MS',
        // If you have a local glyph server, set this; otherwise apgl uses
        // the map style's glyphs URL automatically
        font_url_template = 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
    } = opts;

    const grid = new apgl.UnstructuredGrid(obsJson.map(o => o.coord));
    const field = new apgl.RawObsField(grid, obsJson.map(o => o.data));
    const plot = new apgl.StationPlot(field, {
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
        label: 'Standard Model',
        group: 'point',
        available_for: ['SAO'],
        data_keys: ['tmpc', 'dwpc', 'sknt', 'drct', 'skyc', 'wnum', 'pmsl', 'station_id'],

        make_layers(data, _grid) {
            const KEYS = ['tmpc', 'dwpc', 'sknt', 'drct', 'skyc', 'wnum', 'pmsl', 'station_id'];
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                d.wind = (d.sknt != null && d.drct != null)
                    ? [d.sknt, d.drct]
                    : [null, null];
                d.preswx = wnumToSymbol(d.wnum);
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });
            const layer = buildObsLayer(
                'sfc_obs_standard',
                obsJson,
                {
                    // Air temperature (°F) upper-left
                    tmpc: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: pipe(cToF, fmtTemp), halo: false
                    },

                    // Dewpoint (°F) lower-left
                    dwpc: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: pipe(cToF, fmtDwpt), halo: false
                    },

                    // Upper-right: station ID, white
                    station_id: { type: 'string', pos: 'lr', color: '#9f5e5e', halo: false },

                    // Lower-center: MSL pressure (3-digit WMO encoding), white
                    pmsl: {
                        type: 'number', pos: 'ur', color: '#fffb06',
                        formatter: fmtMSLP, halo: false
                    },

                    // Center-left: present weather symbol, magenta
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff', halo: false },

                    // Center: sky cover symbol (overlaid on wind barb origin)
                    skyc: { type: 'symbol', pos: 'c' },

                    // Center: wind barb, white
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 14 }
            );

            return {
                layers: [layer],
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

    'temp_dwpt_wind_simple': {
        label: 'Simple',
        group: 'point',
        available_for: ['SAO'],
        data_keys: ['tmpc', 'dwpc', 'sknt', 'drct'],

        make_layers(data, _grid) {
            const KEYS = ['tmpc', 'dwpc', 'sknt', 'drct'];
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                d.wind = (d.sknt != null && d.drct != null)
                    ? [d.sknt, d.drct]
                    : [null, null];
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });
            const layer = buildObsLayer(
                'sfc_obs',
                obsJson,
                {
                    tmpf: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },
                    dwpf: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
                },
                { thin_fac: 8, font_size: 14 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Temperature / dewpoint only
    // Minimal model — useful as a background field overlay or at high zoom.
    // ════════════════════════════════════════════════════════════════════════

    'color_temp': {
        label: 'Only Colored Temperatures',
        group: 'point',
        available_for: ['SAO','SHIP'],
        data_keys: ['tmpc'],

        make_layers(data, _grid) {
            const KEYS = ['tmpc'];
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                d.tmpf = (d.tmpc != null) ? (9./5.) * d.tmpc + 32 : null;  // convert to °F for coloring
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });
            const layer = buildObsLayer(
                'sfc_obs',
                obsJson,
                {
                    tmpf: {
                        type: 'number', pos: 'c', cmap: apgl.colormaps.pw_t2m,
                        formatter: fmtTemp, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(apgl.colormaps.pw_t2m, {label: "Temperature (F)", fontface: 'Trebuchet MS',
                                                            ticks: [-60, -40, -20, 0, 20, 40, 60, 80, 100, 120],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },

    'color_dewpoint': {
        label: 'Only Colored Dewpoint',
        group: 'point',
        available_for: ['SAO','SHIP'],
        data_keys: ['dwpc'],

        make_layers(data, _grid) {
            const KEYS = ['dwpc'];
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                d.dwpf = (d.dwpc != null) ? (9./5.) * d.dwpc + 32 : null;  // convert to °F for coloring
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });
            const layer = buildObsLayer(
                'sfc_obs',
                obsJson,
                {
                    dwpf: {
                        type: 'number', pos: 'c', cmap: apgl.colormaps.pw_td2m,
                        formatter: fmtDwpt, halo: false,
                    },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(apgl.colormaps.pw_td2m, {label: "Dewpoint (F)", fontface: 'Trebuchet MS',
                                                            ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },

    'severe_stn_diagram': {
        label: 'Severe Wx WV',
        group: 'point',
        available_for: ['SAO'],
        data_keys: ['tmpc', 'dwpc', 'sknt', 'drct'],

        make_layers(data, _grid) {
            const KEYS = ['tmpc', 'dwpc', 'sknt', 'drct'];
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                d.dwpf = (d.dwpc != null) ? (9./5.) * d.dwpc + 32 : null;  // convert to °F for coloring
                d.wind = (d.sknt != null && d.drct != null)
                    ? [d.sknt, d.drct]
                    : [null, null];
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });
            const layer = buildObsLayer(
                'sfc_obs',
                obsJson,
                {
                    tmpc: {
                        type: 'number', pos: 'ul', color: '#ca5252',
                        formatter: pipe(cToF, fmtTemp), halo: false
                    },
                    dwpf: {
                        type: 'number', pos: 'll', cmap: apgl.colormaps.pw_td2m,
                        formatter: fmtDwpt, halo: false,
                    },
                    wind: { type: 'barb', pos: 'c', color: '#a2d5daec' },
                },
                { thin_fac: 12, font_size: 14 }
            );
            const temp_cbar = apgl.makeColorBar(apgl.colormaps.pw_td2m, {label: "Dewpoint (F)", fontface: 'Trebuchet MS',
                                                            ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80],
                                                            orientation: 'horizontal', tick_direction: 'bottom'});
            return { layers: [layer], colorbar: [temp_cbar], sampler: null };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Metric temperature / dewpoint model (°C)
    // For users working in SI units.
    // ════════════════════════════════════════════════════════════════════════

    'surface_obs_metric': {
        label: 'Surface Obs — Metric (°C)',
        group: 'point',
        available_for: ['SURFACE_OBS'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_metric',
                data.obs_json,
                {
                    tmpc: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },
                    dwpc: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },
                    pmsl: {
                        type: 'number', pos: 'lc', color: '#ffffff',
                        formatter: fmtMSLP
                    },
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },
                    skyc: { type: 'symbol', pos: 'c' },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
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
        label: 'Surface Obs — Pressure',
        group: 'point',
        available_for: ['SURFACE_OBS'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_pressure',
                data.obs_json,
                {
                    tmpf: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },
                    dwpf: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },

                    // Lower-center: MSLP in WMO 3-digit encoding, yellow
                    pmsl: {
                        type: 'number', pos: 'lc', color: '#ffff00',
                        formatter: fmtMSLP
                    },

                    // Upper-center: altimeter setting (3-digit), cyan
                    alti: {
                        type: 'number', pos: 'uc', color: '#00ffff',
                        formatter: fmtAlti
                    },

                    skyc: { type: 'symbol', pos: 'c' },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
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
        label: 'Surface Obs — Wind / Sky Cover',
        group: 'point',
        available_for: ['SURFACE_OBS'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_wind',
                data.obs_json,
                {
                    skyc: { type: 'symbol', pos: 'c' },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
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
        label: 'Surface Obs — Aviation (Vis / Wx)',
        group: 'point',
        available_for: ['SURFACE_OBS'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_aviation',
                data.obs_json,
                {
                    // Upper-left: temperature (°F)
                    tmpf: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },

                    // Lower-left: dewpoint (°F)
                    dwpf: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },

                    // Upper-right: visibility (miles), orange
                    vsby: {
                        type: 'number', pos: 'ur', color: '#ff8800',
                        formatter: fmtVsby
                    },

                    // Center-left: present weather symbol, magenta
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },

                    // Center: sky cover + wind barb
                    skyc: { type: 'symbol', pos: 'c' },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
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
        label: 'Surface Obs — Precipitation',
        group: 'point',
        available_for: ['SURFACE_OBS'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_precip',
                data.obs_json,
                {
                    tmpf: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },
                    dwpf: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },

                    // Lower-right: 1-hour precip (inches), cyan
                    // Blank when zero — avoids cluttering the display
                    p01i: {
                        type: 'number', pos: 'lr', color: '#00ffff',
                        formatter: fmtPrecip
                    },

                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },
                    skyc: { type: 'symbol', pos: 'c' },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
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
        label: 'Surface Obs — Full Synoptic',
        group: 'point',
        available_for: ['SURFACE_OBS'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'sfc_obs_full',
                data.obs_json,
                {
                    // All 9 positions populated
                    tmpf: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },
                    dwpf: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },
                    id: {
                        type: 'string', pos: 'ur', color: '#ffffff',
                        formatter: fmtId
                    },
                    pmsl: {
                        type: 'number', pos: 'lc', color: '#ffff00',
                        formatter: fmtMSLP
                    },
                    vsby: {
                        type: 'number', pos: 'cr', color: '#ff8800',
                        formatter: fmtVsby
                    },
                    preswx: { type: 'symbol', pos: 'cl', color: '#ff00ff' },
                    skyc: { type: 'symbol', pos: 'c' },
                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
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
        label: 'Mesonet — Standard',
        group: 'point',
        available_for: ['MESONET'],
        data_keys: ['obs_json'],

        make_layers(data, _grid) {
            const layer = buildObsLayer(
                'mesonet_standard',
                data.obs_json,
                {
                    tmpf: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: fmtTemp
                    },
                    dwpf: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: fmtDwpt
                    },
                    wind: { type: 'barb', pos: 'c', color: '#ffff00' },
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

    'air_sea_obs': {
        label: 'Air-Sea Interactions',
        group: 'point',
        available_for: ['SHIP'],
        // Only request the fields the SPConfig below actually uses.
        // The backend filters the PointResponse to these keys, keeping
        // the protobuf payload small across large ship datasets.
        data_keys: ['tmpc', 'dwpc', 'sstc', 'whgt', 'sped', 'drct', 'skyc'],

        make_layers(data, _grid) {
            // The DB stores wind speed and direction as separate fields (sknt, drct).
            // autumnplot-gl's barb renderer expects a single `wind: [speed_kts, dir_deg]`
            // array per observation, so we assemble it here before handing off to
            // buildObsLayer.  Both components must be non-null for the barb to render;
            // if either is missing the barb is suppressed (null → blank).
            //
            // We also normalize every entry so that all data_keys are explicitly
            // present (as null if absent from the DB row) rather than undefined.
            // StationPlot rejects undefined as non-scalar and would throw.
            const KEYS = ['tmpc', 'dwpc', 'sstc', 'whgt', 'sped', 'drct', 'skyc'];
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of KEYS) {
                    if (!(k in d)) d[k] = null;
                }
                d.wind = (msToKt(d.sped) != null && d.drct != null)
                    ? [msToKt(d.sped), d.drct]
                    : [null, null];
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            //console.log(`Building marine_obs layer with ${obsJson.length} points`);
            //const nullCounts = {};
            //for (const k of [...KEYS, 'wind']) {
            //    nullCounts[k] = obsJson.filter(o =>
            //        o.data[k] === null || (Array.isArray(o.data[k]) && o.data[k][0] === null)
            //    ).length;
            //}
            //console.table(
            //    Object.fromEntries(
            //        Object.entries(nullCounts).map(([k, n]) => [k, {
            //            null_count: n,
            //            non_null:   obsJson.length - n,
            //            pct_null:   `${(n / obsJson.length * 100).toFixed(1)}%`,
            //        }])
            //    )
            //);

            const layer = buildObsLayer(
                'marine_obs',
                obsJson,
                {
                    // Air temperature (°F) upper-left
                    tmpc: {
                        type: 'number', pos: 'ul', color: '#cc0000',
                        formatter: pipe(cToF, fmtTemp), halo: false
                    },

                    // Dewpoint (°F) lower-left
                    dwpc: {
                        type: 'number', pos: 'll', color: '#00aa00',
                        formatter: pipe(cToF, fmtDwpt), halo: false
                    },

                    // Water temperature (°F) upper-right, teal
                    // Key name 'sstc' — must be present in obs JSON data
                    sstc: {
                        type: 'number', pos: 'ur', color: '#00cccc',
                        formatter: pipe(cToF, fmtTemp), halo: false
                    },

                    // Significant wave height (ft) lower-right, orange
                    // Key name 'whgt'
                    whgt: {
                        type: 'number', pos: 'lr', color: '#ff8800',
                        formatter: fmtNum1, halo: false
                    },

                    wind: { type: 'barb', pos: 'c', color: '#ffffff' },
                    skyc: { type: 'symbol', pos: 'c', halo: false },
                },
                // Buoys are sparse — lower thin_fac than surface obs
                { thin_fac: 8, font_size: 13 }
            );
            return { layers: [layer], colorbar: [], sampler: null };
        },
    },


    'strikes_by_age': {
        label: 'Strikes By Age',
        group: 'misc',
        available_for: ['LIGHTNING'],
        // Request only the fields we need from the backend
        data_keys: ['age_minutes', 'peak_current', 'polarity'],

        make_layers(data, _grid) {
            const strike_age_levels = [0, 5, 10, 15, 20, 30, 45, 60];
            const strike_age_colors = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];
            const strike_age_cmap = new apgl.ColorMap(strike_age_levels, strike_age_colors, {overflow_color: '#4d0014'});

            // Normalize incoming obs JSON and ensure keys exist
            const obsJson = (data.obs_json || []).map(o => {
                const d = { ...o.data };
                for (const k of ['age_minutes', 'peak_current', 'polarity']) {
                    if (!(k in d)) d[k] = null;
                }
                return { coord: o.coord, valid_time: o.valid_time, data: d };
            });

            // Helper to extract lon/lat from either {lon,lat} or [lon,lat]
            const getLonLat = coord => {
                if (!coord) return [null, null];
                if (Array.isArray(coord)) return [coord[0], coord[1]];
                return [coord.lon ?? null, coord.lat ?? null];
            };

            // Build strikes array from obsJson, skipping entries without age/coord
            const strikes = obsJson
                .map(o => {
                    const [lon, lat] = getLonLat(o.coord);
                    const age = o.data.age_minutes;
                    if (lon == null || lat == null || age == null) return null;
                    // polarity may be provided or derived from peak_current sign
                    let pol = null;
                    if (o.data.polarity != null) pol = String(o.data.polarity);
                    else if (o.data.peak_current != null) pol = (o.data.peak_current > 0) ? '+' : (o.data.peak_current < 0 ? '-' : '');
                    else pol = '';
                    return { lon, lat, polarity: pol, age };
                })
                .filter(x => x !== null);

            // Create geometry feature
            const strike_feature = {
                geometry: {
                    type: 'MultiPoint',
                    coordinates: strikes.map(s => [s.lon, s.lat])
                },
                text: strikes.map(s => s.polarity || ''),
                data: strikes.map(s => s.age),
                style: {
                    text_cmap: strike_age_cmap,
                    text_halo: true,
                    text_halo_color: '#000000',
                    text_font_size: 18
                }
            };

            const geometry = new apgl.GeometryComponent([strike_feature]);
            const geom_layer = new apgl.PlotLayer('lightning-strikes', geometry);

            const cbar = apgl.makeColorBar(strike_age_cmap, {
                label: 'Strike Age (min)',
                fontface: 'Trebuchet MS',
                ticks: strike_age_levels,
                orientation: 'horizontal',
                tick_direction: 'bottom'
            });

            return { layers: [geom_layer], colorbar: [cbar], sampler: null };
        },
    },


};
