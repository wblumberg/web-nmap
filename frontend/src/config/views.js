/**
 * views.js  (updated — no more hardcoded cycles, fhrs, or grid geometry)
 *
 * VIEW_REGISTRY now declares *intent*, not *state*.
 * DynamicViewManager.resolveView(viewId) fills in the live values at runtime.
 *
 * ─── New fields ───────────────────────────────────────────────────────────────
 *
 *   time_mode  : 'forecast' | 'analysis' | 'realtime' | 'static'
 *
 *   fhr_range  : Controls which forecast hours are loaded.  Options:
 *     'all'              → every fhr available on disk (recommended default)
 *     { min: 0, max: 24} → only fhrs 0 through 24
 *     [0, 6, 12, 18, 24] → explicit list; filtered to what's on disk
 *
 *   ── Removed fields ────────────────────────────────────────────────────────
 *   time.cycle        ← now fetched dynamically from /cycles/latest
 *   time.fhr          ← initial fhr; DVM sets it to fhrs[0]
 *   available_fhrs    ← now fetched from /cycles/{cycle}/fhrs
 *   maxZoom           ← kept (purely UI config, doesn't come from the API)
 *
 *   ── Grid info ─────────────────────────────────────────────────────────────
 *   Grid geometry (ni, nj, dx, dy, lat_min, lon_min, proj_params) is NO
 *   LONGER declared here.  DynamicViewManager fetches it from /grid_info
 *   and caches it.  GridFactory.makeApglGrid() builds the apgl Grid object.
 */

export const VIEW_REGISTRY = {

    // ── RAP ───────────────────────────────────────────────────────────────────

    'rap_mslp': {
        label      : 'RAP — MSLP + Wind',
        group      : 'basic',
        source_id  : 'RAP',
        product_id : 'mslp_wind',
        time_mode  : 'forecast',
        fhr_range  : 'all',         // every fhr on disk — DVM asks /fhrs
        maxZoom    : 7,
        var_map    : { 'mslp': 'PRMSL_meansealevel',
                       'u10':  'UGRD_10mAboveGround',
                       'v10':  'VGRD_10mAboveGround' },
    },

    'rap_t2m': {
        label      : 'RAP — 2m Temperature',
        group      : 'basic',
        source_id  : 'RAP',
        product_id : 't2m_fill',
        time_mode  : 'forecast',
        fhr_range  : 'all',
        maxZoom    : 7,
        var_map    : { 't2m': 'TMP_2mAboveGround' },
    },

    'rap_500mb': {
        label      : 'RAP — 500mb Height + Wind',
        group      : 'upper_air',
        source_id  : 'RAP',
        product_id : 'height_wind',
        time_mode  : 'forecast',
        fhr_range  : { min: 0, max: 21 },    // RAP only goes to 21h
        maxZoom    : 7,
        var_map    : { 'gh':  'HGT_isobaricInhPa',
                       'u':   'UGRD_isobaricInhPa',
                       'v':   'VGRD_isobaricInhPa' },
        level      : '500mb',
    },

    // ── GFS ───────────────────────────────────────────────────────────────────

    'gfs_mslp': {
        label      : 'GFS — MSLP',
        group      : 'basic',
        source_id  : 'GFS',
        product_id : 'mslp_contour',
        time_mode  : 'forecast',
        fhr_range  : 'all',          // GFS goes to 384h, show everything on disk
        maxZoom    : 6,
        var_map    : { 'mslp': 'PRMSL_meansealevel' },
    },

    'gfs_500mb': {
        label      : 'GFS — 500mb Heights',
        group      : 'upper_air',
        source_id  : 'GFS',
        product_id : 'height_wind',
        time_mode  : 'forecast',
        fhr_range  : { min: 0, max: 240 },   // first 10 days only
        maxZoom    : 6,
        var_map    : { 'gh': 'HGT_isobaricInhPa',
                       'u':  'UGRD_isobaricInhPa',
                       'v':  'VGRD_isobaricInhPa' },
        level      : '500mb',
    },

    // ── HRRR ─────────────────────────────────────────────────────────────────

    'hrrr_ref': {
        label      : 'HRRR — Composite Reflectivity',
        group      : 'raster',
        source_id  : 'HRRR',
        product_id : 'reflectivity_fill',
        time_mode  : 'forecast',
        fhr_range  : { min: 0, max: 18 },
        maxZoom    : 9,
        var_map    : { 'ref': 'REFC_entireAtmosphere' },
    },

    'hrrr_cape': {
        label      : 'HRRR — CAPE/CIN',
        group      : 'instability',
        source_id  : 'HRRR',
        product_id : 'cape_fill',
        time_mode  : 'forecast',
        fhr_range  : { min: 0, max: 18 },
        maxZoom    : 8,
        var_map    : { 'cape': 'CAPE_surface', 'cin': 'CIN_surface' },
    },

    // ── MRMS (analysis/realtime — no cycle/fhr) ───────────────────────────────

    'mrms_cref': {
        label          : 'MRMS — Composite Reflectivity',
        group          : 'raster',
        source_id      : 'MRMS',
        product_id     : 'reflectivity_raster',
        time_mode      : 'realtime',    // SSE events trigger refresh
        fhr_range      : null,
        maxZoom        : 10,
        var_map        : { 'cref': 'MergedReflectivityQC' },
    },

    'mrms_precip_rate': {
        label          : 'MRMS — Precipitation Rate',
        group          : 'precip',
        source_id      : 'MRMS',
        product_id     : 'precip_rate_raster',
        time_mode      : 'realtime',
        fhr_range      : null,
        maxZoom        : 10,
        var_map        : { 'precip_rate': 'PrecipRate' },
    },

    // ── Surface observations ──────────────────────────────────────────────────

    'surface_obs': {
        label          : 'Surface Observations',
        group          : 'point',
        source_id      : 'SURFACE_OBS',
        product_id     : 'surface_obs_standard',
        time_mode      : 'realtime',
        data_category  : 'point_obs',
        fhr_range      : null,
        maxZoom        : 8.5,
        var_map        : {},
    },

    // ── Local Storm Reports ───────────────────────────────────────────────────

    'lsrs_6h': {
        label          : 'Local Storm Reports — 6h',
        group          : 'point',
        source_id      : 'LSR',
        product_id     : 'lsr_standard',
        time_mode      : 'realtime',
        data_category  : 'point_events',
        fhr_range      : null,
        window_hours   : 6,
        maxZoom        : 10,
        var_map        : {},
    },

    // ── Watches, Warnings, Advisories ─────────────────────────────────────────

    'nws_wwa': {
        label          : 'NWS Watches & Warnings',
        group          : 'misc',
        source_id      : 'NWS_ALERTS',
        product_id     : 'watches_warnings',
        time_mode      : 'realtime',
        data_category  : 'geometry_polygon',
        fhr_range      : null,
        maxZoom        : 12,
        var_map        : {},
    },

    // ── SPC Outlooks ──────────────────────────────────────────────────────────

    'spc_day1_cat': {
        label          : 'SPC Day 1 Categorical Outlook',
        group          : 'misc',
        source_id      : 'SPC_DAY1_OUTLOOK',
        product_id     : 'spc_categorical',
        time_mode      : 'static',
        data_category  : 'geometry_polygon',
        fhr_range      : null,
        maxZoom        : 8,
        var_map        : {},
    },

    'spc_day1_torn': {
        label          : 'SPC Day 1 Tornado Outlook',
        group          : 'misc',
        source_id      : 'SPC_DAY1_OUTLOOK',
        product_id     : 'spc_tornado_prob',
        time_mode      : 'static',
        data_category  : 'geometry_polygon',
        fhr_range      : null,
        maxZoom        : 8,
        var_map        : { 'event_type': 'type', 'probability': 'idp_custom' },
    },

    // ── Aircraft tracks ───────────────────────────────────────────────────────

    'adsb_conus': {
        label          : 'Aircraft Tracks (ADS-B)',
        group          : 'misc',
        source_id      : 'ADSB',
        product_id     : 'aircraft_tracks',
        time_mode      : 'realtime',
        data_category  : 'point_obs',
        fhr_range      : null,
        maxZoom        : 14,
        var_map        : {},
    },

    // ── Lightning ─────────────────────────────────────────────────────────────

    'lightning_60min': {
        label          : 'Lightning Strikes — 60 min',
        group          : 'misc',
        source_id      : 'LIGHTNING',
        product_id     : 'lightning_strikes',
        time_mode      : 'realtime',
        data_category  : 'point_events',
        fhr_range      : null,
        maxZoom        : 14,
        var_map        : {},
    },
};

export function getActiveGroups() {
    return [
        { id: 'basic',      label: 'Basic Fields'       },
        { id: 'upper_air',  label: 'Upper Air'          },
        { id: 'instability',label: 'Instability'        },
        { id: 'moisture',   label: 'Moisture'           },
        { id: 'wind',       label: 'Wind / Shear'       },
        { id: 'precip',     label: 'Precipitation'      },
        { id: 'raster',     label: 'Raster / Imagery'   },
        { id: 'point',      label: 'Point Data'         },
        { id: 'misc',       label: 'Overlays'           },
    ];
}

export function getViewsByGroup(groupId) {
    return Object.entries(VIEW_REGISTRY)
        .filter(([, v]) => v.group === groupId)
        .map(([id, v]) => ({ id, label: v.label }));
}
