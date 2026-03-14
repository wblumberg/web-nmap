
/**
 * datasources.js  (updated: NWS_ALERTS, ADSB, LIGHTNING added)
 *
 * Each entry describes one data source:
 *   fetch(time, varMap)   → Promise<object>   — returns the data object
 *                                               passed to make_layers()
 *   grid                  → fn | null         — grid factory (null for
 *                                               unstructured/GeoJSON sources)
 *
 * For the three misc products, `fetch` hits live APIs or a local proxy.
 * The `grid` is null because GeoJSON sources don't have a structured grid.
 * 
 * // Analogous to NMAP2's datatype.tbl.
 * format: 'zarr' | 'compressed_json' | 'binary_gz'
 */

import { fetchNWSAlerts, buildAircraftTrackGeoJSON } from '../products/misc.js';

const DATA_SOURCES = {

    'GFS': {
        label: 'GFS',
        type: 'gridded',
        format: 'zarr',
        // Zarr store per model run; variables live inside the store
        url_template: 'data/gfs.{cycle}.zarr',
        grid: () => new apgl.PlateCarreeGrid(1441, 721, 0, -90, 360, 90),
        wrap_lon: true,
        available_fhrs: [0, 6, 12, 18, 24, 30, 36, 42, 48],
    },

    'NAM': {
        label: 'NAM',
        type: 'gridded',
        format: 'zarr',
        url_template: 'data/nam.{cycle}.zarr',
        grid: () => new apgl.LambertGrid.fromLLCornerLonLat(/* ... */),
        wrap_lon: false,
        available_fhrs: [0, 3, 6, 9, 12, 15, 18, 21, 24, 36, 48, 60],
    },

    'HRRR': {
        label: 'HRRR',
        type: 'gridded',
        format: 'zarr',
        url_template: 'data/hrrr.{cycle}.zarr',
        grid: () => new apgl.LambertGrid.fromLLCornerLonLat(/* ... */),
        wrap_lon: false,
        available_fhrs: Array.from({ length: 19 }, (_, i) => i),  // 0–18
    },

    'MRMS': {
        label: 'MRMS',
        type: 'gridded_raster',
        format: 'zarr',
        url_template: 'data/mrms.{valid_time}.zarr',
        grid: () => new apgl.PlateCarreeGrid(7000, 3500, -129.995, 20.005, -60.005, 54.995),
        wrap_lon: false,
    },

    'SURFACE_OBS': {
        label: 'Surface Observations',
        type: 'point',
        format: 'compressed_json',
        // Each file is a gzip-compressed JSON array of obs
        url_template: 'data/surface_{valid_time}.json.gz',
    },

    // ── Legacy sources (binary .bin.gz) — kept during transition ──
    'GFS_LEGACY': {
        label: 'GFS (legacy binary)',
        type: 'gridded',
        format: 'binary_gz',
        url_template: 'data/gfs.bin.gz',
        dtype: 'float16',
        grid: () => new apgl.PlateCarreeGrid(1441, 721, 0, -90, 360, 90),
        wrap_lon: true,
    },

    // ── NWS Active Alerts ─────────────────────────────────────────────────────
    // Data comes from api.weather.gov — no grid, pure GeoJSON polygons.
    //
    // The `time` argument is ignored for NWS alerts (they are always current).
    // You can pass { area: 'OK' } in varMap to filter by state.
    'NWS_ALERTS': {
        format: 'geojson',
        grid:   null,
        fetch:  async (_time, varMap) => {
            const params = {};
            if (varMap?.area)   params.area = varMap.area;
            if (varMap?.zone)   params.zone = varMap.zone;
            if (varMap?.region) params.region = varMap.region;

            const geojson = await fetchNWSAlerts(params);
            return { alerts_geojson: geojson };
        },
    },

    // ── ADS-B Aircraft Positions ──────────────────────────────────────────────
    // OpenSky Network REST API (free tier, 10s resolution, no auth required
    // for anonymous access but rate-limited to ~100 req/day).
    //
    // Alternatively point ADSB_BASE_URL at a local dump1090 or tar1090 instance.
    'ADSB': {
        format: 'json',
        grid:   null,
        fetch:  async (_time, varMap) => {
            const baseUrl  = varMap?.base_url ?? 'https://opensky-network.org/api';
            const bbox     = varMap?.bbox     ?? [-130, 20, -60, 55]; // CONUS
            const [lamin, lomin, lamax, lomax] = [bbox[1], bbox[0], bbox[3], bbox[2]];

            const url = `${baseUrl}/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`ADS-B fetch failed: ${resp.status}`);

            const raw = await resp.json();

            // OpenSky returns a 'states' array of fixed-position arrays.
            // Indices: https://openskynetwork.github.io/opensky-api/rest.html
            const FIELDS = ['icao24','callsign','origin_country','time_position',
                            'last_contact','lon','lat','baro_altitude','on_ground',
                            'velocity','true_track','vertical_rate','sensors',
                            'geo_altitude','squawk','spi','position_source'];
            const records = (raw.states ?? [])
                .filter(s => s[5] !== null && s[6] !== null)  // must have lat/lon
                .map(s => {
                    const rec = {};
                    FIELDS.forEach((f, i) => rec[f] = s[i]);
                    return {
                        icao24:      rec.icao24,
                        callsign:    (rec.callsign ?? '').trim(),
                        lat:         rec.lat,
                        lon:         rec.lon,
                        altitude_ft: rec.geo_altitude !== null
                                     ? Math.round(rec.geo_altitude * 3.28084)
                                     : (rec.baro_altitude !== null
                                        ? Math.round(rec.baro_altitude * 3.28084)
                                        : 0),
                        speed_kts:   rec.velocity !== null
                                     ? Math.round(rec.velocity * 1.944)
                                     : 0,
                        heading:     rec.true_track ?? 0,
                        squawk:      rec.squawk ?? '0000',
                        time:        rec.time_position ?? rec.last_contact,
                    };
                });

            return { positions: records };
        },
    },

    // ── Lightning Strikes ─────────────────────────────────────────────────────
    // Expects a local proxy endpoint that returns GeoJSON point features.
    // The real Vaisala / Earth Networks APIs are commercial — this wires up
    // to whatever endpoint you configure in varMap.base_url.
    //
    // For development/testing, a mock endpoint returns synthetic strikes.
    'LIGHTNING': {
        format: 'geojson',
        grid:   null,
        fetch:  async (time, varMap) => {
            const baseUrl = varMap?.base_url ?? '/api/lightning';

            let url = baseUrl;
            if (time?.valid_time) url += `?valid_time=${time.valid_time}`;

            let geojson;
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`${resp.status}`);
                geojson = await resp.json();
            } catch (e) {
                console.warn('Lightning fetch failed, using empty dataset:', e);
                geojson = { type: 'FeatureCollection', features: [] };
            }

            return {
                strikes_geojson: geojson,
                // Reference time: use the provided valid_time if available,
                // otherwise use current clock time
                reference_time: time?.valid_time
                    ? _parseValidTimeToEpoch(time.valid_time)
                    : Math.floor(Date.now() / 1000),
            };
        },
    },
};

// Parse a 'YYYYMMDD_HHMM' or 'YYYYMMDDHHMM' string to epoch seconds
function _parseValidTimeToEpoch(vt) {
    const s = vt.replace('_', '');
    const y = parseInt(s.slice(0,4), 10);
    const m = parseInt(s.slice(4,6), 10) - 1;
    const d = parseInt(s.slice(6,8), 10);
    const h = parseInt(s.slice(8,10), 10);
    const mn = s.length >= 12 ? parseInt(s.slice(10,12), 10) : 0;
    return Math.floor(new Date(Date.UTC(y, m, d, h, mn)).getTime() / 1000);
};

export default DATA_SOURCES;
