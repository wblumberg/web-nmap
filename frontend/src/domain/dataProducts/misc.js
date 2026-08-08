/**
 * products/misc.js — Miscellaneous Overlay Products
 *
 * Products that don't fit the gridded-data or station-plot model:
 *   - Active NWS watches / warnings / advisories (polygon fills + outlines)
 *   - Aircraft tracks (polylines colored by altitude)
 *   - Lightning strikes (points colored by age)
 *
 * ─── Implementation strategy ────────────────────────────────────────────────
 *
 * autumnplot-gl's extension point is PlotComponent: any object with
 *   async onAdd(map, gl) { ... }
 *   render(gl, arg)      { ... }
 * can be wrapped in a PlotLayer and used everywhere a native apgl layer can.
 *
 * For these misc products the GPU-heavy raster/vector rendering of apgl
 * is not needed. Instead we use MapLibre's own GeoJSON source+layer system,
 * which handles polygon fills, line strings, and circle markers natively and
 * efficiently. The PlotComponent wrapper just manages adding/removing the
 * MapLibre source and layers when the apgl PlotLayer is added to or removed
 * from the map.
 *
 * This hybrid approach means:
 *   ✓ Works as a standard PlotLayer (same API as any gridded product)
 *   ✓ Participates in MultiPlotLayer time-stepping for free
 *   ✓ No custom WebGL shader code required
 *   ✓ MapLibre handles zoom-dependent styling, hit-testing, popups, etc.
 *   ✓ GeoJSON data can come from any source (NWS API, ADS-B feeds, etc.)
 *
 * ─── Data contracts ──────────────────────────────────────────────────────────
 *
 * watches_warnings:
 *   GeoJSON FeatureCollection where each Feature has:
 *     geometry: Polygon or MultiPolygon
 *     properties: {
 *       event:      string  — e.g. 'Tornado Warning', 'Severe Thunderstorm Watch'
 *       severity:   string  — 'Extreme' | 'Severe' | 'Moderate' | 'Minor'
 *       certainty:  string  — 'Observed' | 'Likely' | 'Possible'
 *       onset:      string  — ISO 8601 datetime
 *       expires:    string  — ISO 8601 datetime
 *       headline:   string  — short human-readable summary
 *       id:         string  — NWS alert ID (e.g. 'urn:oid:2.49.0.1.840.0...')
 *     }
 *
 * aircraft_tracks:
 *   GeoJSON FeatureCollection where each Feature has:
 *     geometry: LineString  (ordered oldest→newest position)
 *     properties: {
 *       callsign:     string
 *       icao24:       string   — ICAO 24-bit address (hex)
 *       altitude_ft:  number   — current altitude in feet MSL
 *       speed_kts:    number   — ground speed in knots
 *       heading:      number   — track over ground, 0–360
 *       squawk:       string   — transponder squawk code
 *       last_seen:    number   — Unix epoch seconds of most recent position
 *     }
 *
 * lightning_strikes:
 *   GeoJSON FeatureCollection where each Feature has:
 *     geometry: Point
 *     properties: {
 *       time:           number   — Unix epoch seconds of strike
 *       polarity:       number   — +1 for positive, -1 for negative CG
 *       peak_current_ka: number  — peak current in kA
 *     }
 *   The age in minutes is computed at render time relative to `reference_time`.
 */

// ─── NWS event type → fill color mapping ─────────────────────────────────────
//
// Colors follow NWS standard:
//   Tornado Warning        = red
//   Severe T-Storm Warning = yellow
//   Flash Flood Warning    = dark green
//   Tornado Watch          = yellow-orange
//   Severe T-Storm Watch   = yellow
//   Winter Storm Warning   = hot pink
//   etc.
//
// This is a partial list; extend as needed. The fallback color handles
// any event type not explicitly listed.
//
const NWS_EVENT_COLORS = {
    // ── Warnings (imminent/occurring) ─────────────────────────────────────
    'Tornado Warning':                  { fill: '#ff0000', outline: '#ff0000' },
    'Severe Thunderstorm Warning':      { fill: '#ffa500', outline: '#ffa500' },
    'Flash Flood Warning':              { fill: '#008b00', outline: '#00ff00' },
    'Flood Warning':                    { fill: '#00ff00', outline: '#00ff00' },
    'Winter Storm Warning':             { fill: '#ff69b4', outline: '#ff69b4' },
    'Blizzard Warning':                 { fill: '#ff4500', outline: '#ff4500' },
    'Ice Storm Warning':                { fill: '#8b008b', outline: '#8b008b' },
    'High Wind Warning':                { fill: '#daa520', outline: '#daa520' },
    'Dust Storm Warning':               { fill: '#ffe4c4', outline: '#ffe4c4' },
    'Dense Fog Advisory':               { fill: '#708090', outline: '#708090' },
    'Fire Weather Watch':               { fill: '#ffd700', outline: '#ffd700' },
    'Red Flag Warning':                 { fill: '#ff1493', outline: '#ff1493' },
    'Hurricane Warning':                { fill: '#dc143c', outline: '#dc143c' },
    'Hurricane Watch':                  { fill: '#ff00ff', outline: '#ff00ff' },
    'Tropical Storm Warning':           { fill: '#b22222', outline: '#b22222' },
    // ── Watches (conditions favorable) ───────────────────────────────────
    'Tornado Watch':                    { fill: '#ffff00', outline: '#ffff00' },
    'Severe Thunderstorm Watch':        { fill: '#db7093', outline: '#db7093' },
    'Flash Flood Watch':                { fill: '#2e8b57', outline: '#2e8b57' },
    'Winter Storm Watch':               { fill: '#4682b4', outline: '#4682b4' },
    'High Wind Watch':                  { fill: '#b8860b', outline: '#b8860b' },
    // ── Advisories ────────────────────────────────────────────────────────
    'Wind Advisory':                    { fill: '#d2b48c', outline: '#d2b48c' },
    'Winter Weather Advisory':          { fill: '#7b68ee', outline: '#7b68ee' },
    'Frost Advisory':                   { fill: '#6495ed', outline: '#6495ed' },
    // ── Fallback ──────────────────────────────────────────────────────────
    '__default__':                      { fill: '#aaaaaa', outline: '#ffffff' },
};

function nwsEventColor(eventName, component) {
    const entry = NWS_EVENT_COLORS[eventName] ?? NWS_EVENT_COLORS['__default__'];
    return entry[component];
}

// ─── Lightning age color ramp ─────────────────────────────────────────────────
//
// Strikes are colored by age relative to a reference time:
//   0–5 min   = bright red (most recent)
//   5–15 min  = orange
//   15–30 min = yellow
//   30–45 min = light green
//   45–60 min = grey (oldest shown)
//
// MapLibre 'circle-color' with a 'step' expression handles this efficiently.
// The 'age_minutes' property is computed before building the GeoJSON.
//
const LIGHTNING_COLOR_STEPS = [
    // [max_age_minutes, color]
    [5,  '#ff0000'],   // 0–5 min
    [15, '#ff8800'],   // 5–15 min
    [30, '#ffff00'],   // 15–30 min
    [45, '#88ff00'],   // 30–45 min
    [60, '#888888'],   // 45–60 min
];

// Build a MapLibre 'step' expression from the color ramp
function buildLightningColorExpression() {
    // MapLibre step expression format:
    //   ['step', input, default_output, threshold1, output1, threshold2, output2, ...]
    const expr = ['step', ['get', 'age_minutes'], '#ffffff'];
    for (const [minutes, color] of LIGHTNING_COLOR_STEPS) {
        expr.push(minutes, color);
    }
    return expr;
}

// Aircraft altitude color ramp (feet MSL)
const AIRCRAFT_ALTITUDE_COLOR_STEPS = [
    [  1000, '#0000ff'],   // <1000 ft — very low
    [  5000, '#00aaff'],
    [ 10000, '#00ffff'],
    [ 18000, '#00ff88'],
    [ 28000, '#88ff00'],
    [ 36000, '#ffff00'],   // cruise altitude range
    [ 45000, '#ff8800'],
    [ 60000, '#ff0000'],   // very high
];

function buildAltitudeColorExpression() {
    const expr = ['step', ['get', 'altitude_ft'], '#aaaaaa'];
    for (const [alt, color] of AIRCRAFT_ALTITUDE_COLOR_STEPS) {
        expr.push(alt, color);
    }
    return expr;
}


// ─── Base class: MapLibreOverlayComponent ────────────────────────────────────
//
// This is the reusable PlotComponent base that all three misc products share.
// It manages a MapLibre GeoJSON source and an arbitrary set of MapLibre layers
// as a single autumnplot-gl PlotComponent.
//
// Subclasses implement:
//   _getSourceId()              → string: unique source ID
//   _getLayerIds()              → string[]: all layer IDs this component owns
//   _addMapLayers(map, data)    → void: add source + layers to map
//   _updateMapData(map, data)   → void: update source data in place
//
// onAdd() is called once when map.addLayer(plotLayer) is called.
// render() is a no-op because MapLibre handles its own rendering for
// GeoJSON layers — they are NOT WebGL custom layers and don't need a
// render callback.
//
class MapLibreOverlayComponent {
    constructor(geojson) {
        // The GeoJSON data this component displays
        this._geojson = geojson;
        // Reference to the map, set in onAdd()
        this._map = null;
        // Whether this component has been added to the map
        this._added = false;
        this._opacity = 1;
        this._basePaintOpacity = new Map();
    }

    // ── PlotComponent interface ───────────────────────────────────────────

    async onAdd(map, _gl) {
        this._map = map;
        this._added = true;
        this._addMapLayers(map, this._geojson);
        this.setOpacity(this._opacity);
    }

    // render() is intentionally empty: MapLibre manages its own render loop
    // for GeoJSON source layers. autumnplot-gl calls this after its own WebGL
    // render pass, so we do nothing here.
    render(_gl, _arg) {}

    setOpacity(opacity) {
        this._opacity = Math.max(0, Math.min(1, Number(opacity)));
        if (!this._added || !this._map) return;
        const opacityProperties = {
            fill: ['fill-opacity'],
            line: ['line-opacity'],
            circle: ['circle-opacity', 'circle-stroke-opacity'],
            symbol: ['text-opacity', 'icon-opacity'],
            raster: ['raster-opacity'],
            heatmap: ['heatmap-opacity'],
            'fill-extrusion': ['fill-extrusion-opacity'],
        };
        this._getLayerIds().forEach(layerId => {
            const layer = this._map.getLayer(layerId);
            (opacityProperties[layer?.type] || []).forEach(property => {
                const key = `${layerId}:${property}`;
                if (!this._basePaintOpacity.has(key)) {
                    this._basePaintOpacity.set(key, this._map.getPaintProperty(layerId, property) ?? 1);
                }
                const base = this._basePaintOpacity.get(key);
                this._map.setPaintProperty(layerId, property,
                    this._opacity === 1 ? base : ['*', base, this._opacity]);
            });
        });
    }

    // ── Data update ─���─────────────────────────────────────────────────────

    updateData(geojson) {
        this._geojson = geojson;
        if (this._added && this._map) {
            this._updateMapData(this._map, geojson);
        }
    }

    // ── Cleanup ───────────────────────────────────────────────────────────

    remove() {
        if (!this._map || !this._added) return;
        const map = this._map;

        // Remove layers first, then source (MapLibre requires this order)
        for (const layerId of this._getLayerIds()) {
            if (map.getLayer(layerId)) map.removeLayer(layerId);
        }
        if (map.getSource(this._getSourceId())) {
            map.removeSource(this._getSourceId());
        }
        this._added = false;
    }

    // ── Subclass interface (must override) ────────────────────────────────

    _getSourceId()           { throw new Error('_getSourceId() not implemented'); }
    _getLayerIds()           { return []; }
    _addMapLayers(map, data) { throw new Error('_addMapLayers() not implemented'); }
    _updateMapData(map, data){ throw new Error('_updateMapData() not implemented'); }
}


// ─── WatchesWarningsOverlay ──────────────────────────────────────────────────
//
// Renders NWS watch/warning/advisory polygons.
//
// Three MapLibre layers are created per overlay instance:
//   1. 'fill' layer   — semi-transparent polygon fill, colored by event type
//   2. 'outline' layer — 2px solid outline, same color as fill but fully opaque
//   3. 'label' layer  — event name centered on polygon (symbol layer)
//
// The fill opacity is intentionally low (0.25) so underlying data is visible.
//
class WatchesWarningsOverlay extends MapLibreOverlayComponent {
    constructor(geojson, opts = {}) {
        super(geojson);
        this._id    = opts.id    ?? 'watches_warnings';
        this._fillOpacity    = opts.fillOpacity    ?? 0.25;
        this._outlineWidth   = opts.outlineWidth   ?? 2;
        this._showLabels     = opts.showLabels     ?? true;
    }

    _getSourceId() { return `${this._id}_src`; }

    _getLayerIds() {
        const ids = [`${this._id}_fill`, `${this._id}_outline`];
        if (this._showLabels) ids.push(`${this._id}_label`);
        return ids;
    }

    _addMapLayers(map, data) {
        // ── Source ─────────────────────────────────────────────────────
        map.addSource(this._getSourceId(), {
            type: 'geojson',
            data: data,
        });

        // ── Fill layer ─────────────────────────────────────────────────
        // 'match' expression: look up the event name in our color table
        map.addLayer({
            id:     `${this._id}_fill`,
            type:   'fill',
            source: this._getSourceId(),
            paint: {
                // Build a MapLibre 'match' expression from our color table
                'fill-color':   this._buildMatchExpression('fill'),
                'fill-opacity': this._fillOpacity,
            },
        });

        // ── Outline layer ──────────────────────────────────────────────
        map.addLayer({
            id:     `${this._id}_outline`,
            type:   'line',
            source: this._getSourceId(),
            paint: {
                'line-color': this._buildMatchExpression('outline'),
                'line-width': this._outlineWidth,
            },
        });

        // ── Label layer ────────────────────────────────────────────────
        if (this._showLabels) {
            map.addLayer({
                id:     `${this._id}_label`,
                type:   'symbol',
                source: this._getSourceId(),
                layout: {
                    'text-field':          ['get', 'event'],
                    'text-size':           11,
                    'text-font':           ['Trebuchet MS Regular'],
                    'text-anchor':         'center',
                    'symbol-placement':    'point',
                    'text-allow-overlap':  false,
                    'text-ignore-placement': false,
                },
                paint: {
                    'text-color':      '#ffffff',
                    'text-halo-color': '#000000',
                    'text-halo-width': 1,
                },
            });
        }
    }

    _updateMapData(map, data) {
        map.getSource(this._getSourceId())?.setData(data);
    }

    // Build a MapLibre 'match' expression for fill or outline colors
    _buildMatchExpression(component) {
        // Format: ['match', input, val1, output1, val2, output2, ..., fallback]
        const expr = ['match', ['get', 'event']];
        for (const [eventName, colors] of Object.entries(NWS_EVENT_COLORS)) {
            if (eventName === '__default__') continue;
            expr.push(eventName, colors[component]);
        }
        // fallback
        expr.push(NWS_EVENT_COLORS['__default__'][component]);
        return expr;
    }
}


// ─── AircraftTrackOverlay ────────────────────────────────────────────────────
//
// Renders aircraft tracks as polylines colored by altitude.
//
// Two MapLibre layers:
//   1. 'track' layer     — LineString, colored by altitude_ft
//   2. 'position' layer  — Circle at the last known position (head of track)
//
// The altitude color ramp uses a 'step' expression built from AIRCRAFT_ALTITUDE_COLOR_STEPS.
//
class AircraftTrackOverlay extends MapLibreOverlayComponent {
    constructor(geojson, opts = {}) {
        super(geojson);
        this._id            = opts.id          ?? 'aircraft_tracks';
        this._lineWidth     = opts.lineWidth   ?? 2;
        this._dotRadius     = opts.dotRadius   ?? 5;
        // Optionally filter to a single callsign or ICAO24 for detail view
        this._filterCallsign = opts.filterCallsign ?? null;
    }

    _getSourceId() { return `${this._id}_src`; }
    _getLayerIds() { return [`${this._id}_track`, `${this._id}_position`]; }

    _addMapLayers(map, data) {
        map.addSource(this._getSourceId(), {
            type: 'geojson',
            data: data,
        });

        // ── Track line ─────────────────────────────────────────────────
        map.addLayer({
            id:     `${this._id}_track`,
            type:   'line',
            source: this._getSourceId(),
            filter: ['==', ['geometry-type'], 'LineString'],
            layout: {
                'line-cap':  'round',
                'line-join': 'round',
            },
            paint: {
                // Color the line by the current altitude of the aircraft
                'line-color': buildAltitudeColorExpression(),
                'line-width': this._lineWidth,
                // Fade the line from transparent at the tail to opaque at the head
                // using a gradient — note: gradient requires the source to have
                // lineMetrics: true (set above in addSource)
                'line-opacity': 0.85,
            },
        });

        // ── Current position dot ────────────────────────────────────────
        // A Point geometry placed at the last known position (the head of the track)
        map.addLayer({
            id:     `${this._id}_position`,
            type:   'circle',
            source: this._getSourceId(),
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-radius':       this._dotRadius,
                'circle-color':        buildAltitudeColorExpression(),
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1,
            },
        });
    }

    _updateMapData(map, data) {
        map.getSource(this._getSourceId())?.setData(data);
    }
}


// ─── LightningStrikeOverlay ──────────────────────────────────────────────────
//
// Renders lightning strikes as colored circles, age-faded.
//
// One MapLibre 'circle' layer. The age_minutes property on each feature
// drives the color expression. Strikes older than maxAgeMins are filtered out.
//
class LightningStrikeOverlay extends MapLibreOverlayComponent {
    constructor(geojson, opts = {}) {
        super(geojson);
        this._id          = opts.id          ?? 'lightning';
        this._maxAgeMins  = opts.maxAgeMins  ?? 60;
        this._circleRadius = opts.circleRadius ?? 4;
        // The reference time (epoch seconds) used to compute age.
        // Updated when new data is loaded.
        this._refTime     = opts.referenceTime ?? Math.floor(Date.now() / 1000);
    }

    _getSourceId() { return `${this._id}_src`; }
    _getLayerIds() { return [`${this._id}_strikes`]; }

    _addMapLayers(map, data) {
        map.addSource(this._getSourceId(), {
            type: 'geojson',
            data: this._computeAges(data),
        });

        map.addLayer({
            id:     `${this._id}_strikes`,
            type:   'circle',
            source: this._getSourceId(),
            // Only show strikes within maxAgeMins
            filter: ['<=', ['get', 'age_minutes'], this._maxAgeMins],
            paint: {
                'circle-radius':       this._circleRadius,
                'circle-color':        buildLightningColorExpression(),
                'circle-opacity':      0.85,
                'circle-stroke-color': '#000000',
                'circle-stroke-width': 0.5,

                // Scale radius slightly for stronger strokes (high peak current)
                // ['min', ['/', ['abs', ['get', 'peak_current_ka']], 20], 2] adds
                // 0-2px depending on peak current up to 40 kA
                // (intentionally subtle — don't overwhelm the display)
            },
        });
    }

    _updateMapData(map, data) {
        map.getSource(this._getSourceId())?.setData(this._computeAges(data));
    }

    // Compute age_minutes for each strike relative to the reference time,
    // returning a new GeoJSON FeatureCollection with the property added
    _computeAges(geojson) {
        if (!geojson?.features) return geojson;
        return {
            ...geojson,
            features: geojson.features.map(f => ({
                ...f,
                properties: {
                    ...f.properties,
                    age_minutes: Math.round((this._refTime - f.properties.time) / 60),
                },
            })),
        };
    }
}


// ─── Helper: fetch NWS active alerts as GeoJSON ───────────────────────────────
//
// The NWS API (api.weather.gov) provides active alerts as GeoJSON natively.
// This helper fetches the current alerts for the CONUS.
//
// Usage:
//   const geojson = await fetchNWSAlerts();
//
// You can filter to a specific area using the 'area' query parameter:
//   fetchNWSAlerts({ area: 'OK' })   — Oklahoma only
//   fetchNWSAlerts({ zone: 'OKZ001' })
//
async function fetchNWSAlerts(params = {}) {
    const url = new URL('https://api.weather.gov/alerts/active');
    // Default: only watches/warnings/advisories with polygon geometries
    url.searchParams.set('status', 'actual');
    url.searchParams.set('message_type', 'alert,update');

    for (const [key, val] of Object.entries(params)) {
        url.searchParams.set(key, val);
    }

    const resp = await fetch(url.toString(), {
        headers: { 'Accept': 'application/geo+json' },
    });

    if (!resp.ok) throw new Error(`NWS alerts fetch failed: ${resp.status} ${resp.statusText}`);

    const fc = await resp.json();

    // The NWS /alerts/active endpoint returns features with 'geometry: null'
    // for county-based alerts (no polygon). Filter those out.
    return {
        ...fc,
        features: fc.features.filter(f => f.geometry !== null),
    };
}

// ─── Helper: prepare aircraft track GeoJSON from ADS-B position records ───────
//
// Converts a flat array of position records into a FeatureCollection
// containing both LineString (track) and Point (current position) features.
//
// Each record:
//   { icao24, callsign, lat, lon, altitude_ft, speed_kts, heading,
//     squawk, time (epoch s) }
//
// Records are grouped by icao24, sorted oldest→newest, and a LineString
// + current-position Point is created for each unique aircraft.
//
function buildAircraftTrackGeoJSON(positionRecords) {
    // Group records by icao24
    const byAircraft = {};
    for (const rec of positionRecords) {
        if (!byAircraft[rec.icao24]) byAircraft[rec.icao24] = [];
        byAircraft[rec.icao24].push(rec);
    }

    const features = [];

    for (const [icao24, records] of Object.entries(byAircraft)) {
        // Sort oldest → newest
        records.sort((a, b) => a.time - b.time);

        const latest  = records[records.length - 1];
        const coords  = records.map(r => [r.lon, r.lat]);

        // LineString: the full track
        if (coords.length >= 2) {
            features.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: coords },
                properties: {
                    icao24,
                    callsign:    latest.callsign,
                    altitude_ft: latest.altitude_ft,
                    speed_kts:   latest.speed_kts,
                    heading:     latest.heading,
                    squawk:      latest.squawk,
                    last_seen:   latest.time,
                },
            });
        }

        // Point: current position (head of track)
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [latest.lon, latest.lat] },
            properties: {
                icao24,
                callsign:    latest.callsign,
                altitude_ft: latest.altitude_ft,
                speed_kts:   latest.speed_kts,
                heading:     latest.heading,
                squawk:      latest.squawk,
                last_seen:   latest.time,
            },
        });
    }

    return { type: 'FeatureCollection', features };
}


// ─── Product definitions ──────────────────────────────────────────────────────

export default {

    // ════════════════════════════════════════════════════════════════════════
    // NWS Active Watches, Warnings & Advisories
    // Data source: api.weather.gov/alerts/active (GeoJSON)
    // ════════════════════════════════════════════════════════════════════════

    'watches_warnings': {
        label:         'NWS Active Watches & Warnings',
        group:         'misc',
        available_for: ['NWS_ALERTS'],
        data_keys:     ['alerts_geojson'],

        make_layers(data, _grid) {
            const overlay = new WatchesWarningsOverlay(
                data.alerts_geojson ?? { type: 'FeatureCollection', features: [] },
                {
                    id:           'wwa',
                    fillOpacity:  0.25,
                    outlineWidth: 2,
                    showLabels:   true,
                }
            );

            const layer = new apgl.PlotLayer('wwa_overlay', overlay);

            return {
                layers:   [layer],
                colorbar: [],
                // Sampler: return the alert(s) at the clicked point
                // Uses MapLibre queryRenderedFeatures() under the hood
                sampler: null,   // See note below about interactive samplers
            };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Aircraft Tracks (ADS-B)
    // Data source: OpenSky Network API or local ADS-B receiver
    // ════════════════════════════════════════════════════════════════════════

    'aircraft_tracks': {
        label:         'Aircraft Tracks (ADS-B)',
        group:         'misc',
        available_for: ['ADSB'],
        data_keys:     ['positions'],

        make_layers(data, _grid) {
            // Convert flat position records to GeoJSON track features
            const geojson  = buildAircraftTrackGeoJSON(
                data.positions ?? []
            );

            const overlay  = new AircraftTrackOverlay(geojson, {
                id:         'aircraft',
                lineWidth:  2,
                dotRadius:  5,
            });

            const layer = new apgl.PlotLayer('aircraft_overlay', overlay);

            return {
                layers:   [layer],
                colorbar: [_buildAltitudeColorbar()],
                sampler:  null,
            };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Lightning Strikes (colored by age)
    // Data source: Vaisala/Earth Networks or any GeoJSON point feed
    // ════════════════════════════════════════════════════════════════════════

    'lightning_strikes': {
        label:         'Lightning Strikes (60 min)',
        group:         'misc',
        available_for: ['LIGHTNING'],
        data_keys:     ['strikes_geojson'],

        make_layers(data, _grid) {
            const overlay = new LightningStrikeOverlay(
                data.strikes_geojson ?? { type: 'FeatureCollection', features: [] },
                {
                    id:            'ltg',
                    maxAgeMins:    60,
                    circleRadius:  4,
                    referenceTime: data.reference_time ?? Math.floor(Date.now() / 1000),
                }
            );

            const layer = new apgl.PlotLayer('lightning_overlay', overlay);

            return {
                layers:   [layer],
                colorbar: [_buildLightningColorbar()],
                sampler:  null,
            };
        },
    },

    // ════════════════════════════════════════════════════════════════════════
    // Lightning Strikes — last 5 minutes only (for real-time convective mode)
    // ════════════════════════════════════════════════════════════════════════

    'lightning_strikes_5min': {
        label:         'Lightning Strikes (5 min)',
        group:         'misc',
        available_for: ['LIGHTNING'],
        data_keys:     ['strikes_geojson'],

        make_layers(data, _grid) {
            const overlay = new LightningStrikeOverlay(
                data.strikes_geojson ?? { type: 'FeatureCollection', features: [] },
                {
                    id:            'ltg5',
                    maxAgeMins:    5,
                    // Larger dots for the 5-minute product — it's meant to be
                    // a "flash flood / CI" overlay, not a detailed strike map
                    circleRadius:  6,
                    referenceTime: data.reference_time ?? Math.floor(Date.now() / 1000),
                }
            );

            const layer = new apgl.PlotLayer('lightning_5min_overlay', overlay);

            return {
                layers:   [layer],
                colorbar: [],
                sampler:  null,
            };
        },
    },
};


// ─── Colorbar helpers ─────────────────────────────────────────────────────────
//
// apgl.makeColorBar() produces an SVG element from a ColorMap object.
// For our altitude and lightning-age ramps we build a ColorMap manually
// from the step arrays, then call makeColorBar().
//
// This keeps the colorbar consistent with the actual map styling.

function _buildLightningColorbar() {
    const levels = LIGHTNING_COLOR_STEPS.map(([mins]) => mins);
    const colors = LIGHTNING_COLOR_STEPS.map(([, color]) => color);
    const cmap   = new apgl.ColorMap(levels, colors.slice(0, -1), {
        overflow_color: colors[colors.length - 1],
    });
    return apgl.makeColorBar(cmap, {
        label:           'Strike Age (min)',
        orientation:     'horizontal',
        tick_direction:  'bottom',
        ticks:           levels,
        fontface:        'Trebuchet MS',
    });
}

function _buildAltitudeColorbar() {
    const levels = AIRCRAFT_ALTITUDE_COLOR_STEPS.map(([alt]) => alt);
    const colors = AIRCRAFT_ALTITUDE_COLOR_STEPS.map(([, color]) => color);
    const cmap   = new apgl.ColorMap(levels, colors.slice(0, -1), {
        overflow_color: colors[colors.length - 1],
    });
    return apgl.makeColorBar(cmap, {
        label:           'Altitude (ft MSL)',
        orientation:     'horizontal',
        tick_direction:  'bottom',
        ticks:           [0, 5000, 10000, 18000, 28000, 36000, 45000],
        fontface:        'Trebuchet MS',
    });
}

// Export the helpers so DataLoader.js can use them when fetching real data
export { fetchNWSAlerts, buildAircraftTrackGeoJSON,
         WatchesWarningsOverlay, AircraftTrackOverlay, LightningStrikeOverlay };
