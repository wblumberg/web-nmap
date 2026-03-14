/* 
TODO: Make an "ERROR" button that will allow the user to view messages from the Javascript console referring to errors in plotting data, etc.  These messages should also be informative.

TODO: Figure out how the "restore" file capability will work for the generation of various maps from gridded data.  This will allow the user to save a configuration of the map (e.g., layers, colorbars, etc.) and restore it later.

Questions:
  - How should I go about organizing the various restore files?  I do like the way SPC has been doing it with categories (basic, moisture, instability, lift, shear, precip, winter, fire, composite, overlays, etc.)
  - One file, one restore file.

TODO: Figure out how to create and organize "restore" files for different ways of visualizing observed data (upper air and surface).  These files should provide different ways to visualize the data by changing up how different station plots look?  What about the local storm reports, etc.?

TODO: Figure out how to specify or list the different colormaps that can be used to plot the satellite and radar data.

TODO: Create the method of binning upper air and surface observations.

TODO: Test the time matching of the various datasets to make sure that the data is being plotted correctly and that the time matching is working as expected.  This will require some test cases with known data and known times.

TODO: Figure out what parts of this system are offloaded to the server and what parts are the client's responsiblity.

TODO: Include a settings menu that allows the user to change the settings of NMAP.
TODO: Include a slider that will change the animation speed.

TODO: Implement the Automated Devorak Technique for Cyclone Intensity Estimates.
TODO: Implement the cloud top height algorithm from NMAP2.


*/
// Make a synthetic 500mb height, wind, and wind speed field for testing purposes.  The height field is a simple cosine wave with a gradient, the wind field is a simple cosine wave with a gradient, and the wind speed field is the magnitude of the wind field.  The color map is defined for the wind speed range.
function makeSynthetic500mbLayers() {
    const nx = 121, ny = 61;
    const grid = new apgl.PlateCarreeGrid(nx, ny, -130, 20, -65, 55);
    const coords = grid.getGridCoords();

    const height_base = 570;
    const height_pert = 10;
    const height_grad = 0.5;
    const vel_pert = 60;
    const speed = 0.001;

    const arrayType = Float32Array;

    function makeHeight(key) {
        let hght = [];
        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
                const idx = i + j * nx;
                if (i < 10 && j < 10) {
                    hght[idx] = NaN;
                } else {
                    hght[idx] = height_base + height_pert * (Math.cos(-key * speed + 4 * Math.PI * i / (nx - 1)) * Math.cos(2 * Math.PI * j / (ny - 1))) - 61 * height_grad * j / ny;
                }
            }
        }
        return new apgl.RawScalarField(grid, new arrayType(hght));
    }

    function makeWinds(key) {
        let u = [], v = [];
        for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
                const idx = i + j * nx;
                if (i < 10 && j < 10) {
                    u[idx] = v[idx] = NaN;
                } else {
                    let v_fac = 1;
                    if (grid.type == 'latlon' || grid.type == 'latlonrot') {
                        v_fac = Math.cos(coords.y[j] * Math.PI / 180);
                    }
                    let u_earth = vel_pert * (Math.cos(-key * speed + 4 * Math.PI * i / (nx - 1)) * Math.sin(2 * Math.PI * j / (ny - 1)) + height_grad);
                    let v_earth = -vel_pert * Math.sin(-key * speed + 4 * Math.PI * i / (nx - 1)) * Math.cos(2 * Math.PI * j / (ny - 1));
                    const mag = Math.hypot(u_earth, v_earth);
                    v_earth /= v_fac;
                    u[idx] = u_earth * mag / Math.hypot(u_earth, v_earth);
                    v[idx] = v_earth * mag / Math.hypot(u_earth, v_earth);
                }
            }
        }
        return new apgl.RawVectorField(grid, new arrayType(u), new arrayType(v), {relative_to: 'grid'});
    }

    function makeWindSpeed(key) {
        const winds = makeWinds(key);
        const wspd = [];
        for (let idx = 0; idx < winds.u.data.length; idx++) {
            wspd[idx] = Math.hypot(winds.u.data[idx], winds.v.data[idx]);
        }
        return new apgl.RawScalarField(grid, new arrayType(wspd));
    }

    const colormap = apgl.colormaps.pw_speed500mb;

    const raw_hght_field = makeHeight(0);
    const raw_wind_field = makeWinds(0);
    const raw_ws_field = makeWindSpeed(0);

    const cntr = new apgl.Contour(raw_hght_field, {interval: 1, color: '#ffffff', line_width: lev => lev < 565 ? 2 : 4, line_style: lev => lev < 555 ? '--' : '-'});
    const filled = new apgl.ContourFill(raw_ws_field, {cmap: colormap, opacity: 0.8});
    const barbs = new apgl.Barbs(raw_wind_field, {color: '#ffffff', thin_fac: 16});
    const labels = new apgl.ContourLabels(cntr, {text_color: '#ffffff', halo: true, font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf'});

    const hght_layer = new apgl.PlotLayer('height', cntr);
    const ws_layer = new apgl.PlotLayer('wind-speed', filled);
    const barb_layer = new apgl.PlotLayer('barbs', barbs);
    const label_layer = new apgl.PlotLayer('label', labels);

    const svg = apgl.makeColorBar(colormap, {label: "Wind Speed (kts)", fontface: 'Trebuchet MS',
                                             ticks: [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140],
                                             orientation: 'horizontal', tick_direction: 'bottom'});

    return {layers: [ws_layer, hght_layer, barb_layer, label_layer], colorbar: [svg],
            sampler: (lon, lat) => ({hght: raw_hght_field.sampleField(lon, lat),
                                     barb: raw_wind_field.sampleField(lon, lat)})};
}

// Fetch a binary file from the server, decompress it using pako, and return it as a typed array.  The default data type is float16, but uint8 can also be specified.
async function fetchBinary(fname, dtype) {
    dtype = dtype === undefined ? 'float16' : dtype;
    const resp = await fetch(fname);
    const blob = await resp.blob();
    const ary = new Uint8Array(await blob.arrayBuffer());
    const ary_inflated = pako.inflate(ary);
    if (dtype == 'uint8') return ary_inflated;
    return new float16.Float16Array(new Float32Array(ary_inflated.buffer));
}

// Make some GFS layers for 2m temperature.  The data is read from a binary file and the color map is defined for the temperature range.
async function makeGFSLayers() {
    const grid_gfs = new apgl.PlateCarreeGrid(1441, 721, 0, -90, 360, 90);
    const colormap = apgl.colormaps.pw_t2m;
    const t2m_data = await fetchBinary('data/gfs/gfs.bin.gz');

    // The GFS data is missing the last column of data, so we need to pad it with the first column of data to make it wrap around the globe.  This is done by creating a new array with the same number of rows and columns as the original data, but with an extra column at the end.  The last column is filled with the first column of data.
    const t2m_data_pad = new float16.Float16Array(grid_gfs.ni * grid_gfs.nj);
    for (let j = 0; j < grid_gfs.nj; j++) {
        const idx_start = (grid_gfs.ni - 1) * j;
        const idx_end = (grid_gfs.ni - 1) * (j + 1);
        const idx_pad_start = grid_gfs.ni * j;
        const idx_pad_end = grid_gfs.ni * (j + 1);
        t2m_data_pad.set(t2m_data.subarray(idx_start, idx_end), idx_pad_start);
        t2m_data_pad[idx_pad_end - 1] = t2m_data[idx_start];
    }

    const t2m_field = new apgl.RawScalarField(grid_gfs, t2m_data_pad);
    const t2m_fill = new apgl.ContourFill(t2m_field, {cmap: colormap});
    const t2m_filllayer = new apgl.PlotLayer('t2m_fill', t2m_fill);

    const t2m_contour = new apgl.Contour(t2m_field, {levels: [32], line_width: 4});
    const t2m_contourlayer = new apgl.PlotLayer('t2m_contour', t2m_contour);
    const labels = new apgl.ContourLabels(t2m_contour, {text_color: '#ffffff', halo: true, font_url_template: 'font/{fontstack}/{range}.pbf'});
    const label_layer = new apgl.PlotLayer('label', labels);

    const svg = apgl.makeColorBar(colormap, {label: "Temperature", fontface: 'Trebuchet MS',
                                             ticks: [-60, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
                                             orientation: 'horizontal', tick_direction: 'bottom'});

    return {layers: [t2m_filllayer, t2m_contourlayer, label_layer], colorbar: [svg]};
}

// Make some HREF layers for probabilities and paintball.  The data is read from binary files and the color maps are defined for each probability level.
async function makeHREFLayers() {
    const grid_href = apgl.LambertGrid.fromLLCornerLonLat(1799, 1059, -97.5, 38.5, [38.5, 38.5], -122.719528, 21.138123, 3000, 3000);

    const nh_prob_data = (await fetchBinary('data/href/hrefv3.2023051100.f036.mxuphl5000_2000m.nh_max.086400_p99.85_0040km.bin.gz')).map(v => v * 100);
    const nh_prob_field = new apgl.RawScalarField(grid_href, nh_prob_data);
    const nh_prob_contour = new apgl.Contour(nh_prob_field, {levels: [10, 30, 50, 70, 90], color: '#ffffff'});
    const labels = new apgl.ContourLabels(nh_prob_contour, {text_color: '#ffffff', halo: true, font_size: 15,
                                                            font_url_template: 'font/{fontstack}/{range}.pbf'});

    const nh_prob_layer = new apgl.PlotLayer('nh_probs', nh_prob_contour);
    const label_layer = new apgl.PlotLayer('nh_prob_labels', labels);

    const pb_data = await fetchBinary('data/href/hrefv3.2023051100.f036.mxuphl5000_2000m.086400.pb75.bin.gz');
    const href_pb_colors = ['#9d4c1c', '#f2b368', '#792394', '#d99cf9', '#1e3293', '#aabee3', '#bc373b', '#f0928f', '#397d21', '#b5f0ab'];
    const pb_field = new apgl.RawScalarField(grid_href, pb_data);
    const paintball = new apgl.Paintball(pb_field, {colors: [...href_pb_colors].reverse()});
    const paintball_layer = new apgl.PlotLayer('paintball', paintball);

    const svg = apgl.makePaintballKey(href_pb_colors,
                                      ['HRRR', 'HRRR -6h', 'HRW ARW', 'HRW ARW -12h', 'HRW FV3', 'HRW FV3 -12h', 'HRW NSSL', 'HRW NSSL -12h', 'NAM 3k', 'NAM 3k -12h'],
                                      {n_cols: 5, color: '#ffffff'});

    return {layers: [paintball_layer, nh_prob_layer, label_layer], colorbar: [svg]};
}

// Make some MRMS layers for composite reflectivity and precipitation type.  The data is read from binary files and the color maps are defined for each precipitation type.
async function makeMRMSLayers() {
    const grid_mrms = new apgl.PlateCarreeGrid(7000, 3500, -129.995, 20.005, -60.005, 54.995);
    const data = await fetchBinary('data/mrms/mrms.202112152259.cref.bin.gz');
    const data_mask = await fetchBinary('data/hrrr.2021121522.ptype.bin.gz', 'uint8');

    const crain_colors = ['#bce8be', '#a6d3a8', '#93c393', '#7fb482', '#68a06a', '#568e56', '#48894d', '#3b8043', '#2b7a39', '#1f7331',
                          '#116c28', '#f3ef6f', '#f7dd65', '#f6c55b', '#f5b24f', '#fb9e45'];
    const crain_levels = [10., 12.5, 15., 17.5, 20., 22.5, 25., 27.5, 30., 32.5, 35., 37.5, 40., 42.5, 45., 47.5, 50.];
    const crain_cmap = new apgl.ColorMap(crain_levels, crain_colors, {overflow_color: '#f88a3f'});

    const csnow_colors = ['#bfdeed', '#a6cfe6', '#92c0db', '#7ab0d0', '#66a5c9', '#5196be', '#4089b3', '#347da4', '#2a7296', '#1e6586',
                          '#125877', '#074b67', '#703579', '#b23890', '#c051a2', '#c970b2', '#d18dbe', '#e4add6'];
    const csnow_levels = [5., 7.5, 10., 12.5, 15., 17.5, 20., 22.5, 25., 27.5, 30., 32.5, 35., 37.5, 40., 42.5, 45., 47.5, 50.];
    const csnow_cmap = new apgl.ColorMap(csnow_levels, csnow_colors, {overflow_color: '#eec9e5'});

    const cfrzr_colors = ['#eac6d6', '#edb6be', '#e8a5a8', '#ea9492', '#ec897a', '#e87664', '#eb684d', '#ee5736', '#ea4721', '#df4427',
                          '#d3422c', '#bf3e32', '#b53c33', '#a63835', '#94393a', '#88353d'];
    const cfrzr_levels = crain_levels;
    const cfrzr_cmap = new apgl.ColorMap(cfrzr_levels, cfrzr_colors, {overflow_color: '#793042'});

    const cicep_colors = ['#e1c9ed', '#d4b4e3', '#cda2de', '#c58fda', '#b97ad1', '#b368cf', '#ab54c9', '#a042bf', '#9631b8', '#8f2caa',
                          '#832898', '#792687', '#702475', '#652162', '#5d2051', '#53203e'];
    const cicep_levels = crain_levels;
    const cicep_cmap = new apgl.ColorMap(cicep_levels, cicep_colors, {overflow_color: '#471b2c'});

    const raw_cref_field = new apgl.RawScalarField(grid_mrms, data);
    const raster_cref = new apgl.Raster(raw_cref_field, {cmap: [crain_cmap, csnow_cmap, cicep_cmap, cfrzr_cmap], cmap_mask: data_mask});
    const raster_layer = new apgl.PlotLayer('mrms_cref', raster_cref);

    const svg_crain = apgl.makeColorBar(crain_cmap, {label: "Rain Reflectivity (dBZ)", size_long: 320, size_short: 67, fontface: 'Trebuchet MS',
                                                     ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});
    const svg_csnow = apgl.makeColorBar(csnow_cmap, {label: "Snow Reflectivity (dBZ)", size_long: 320, size_short: 67, fontface: 'Trebuchet MS',
                                                     ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});
    const svg_cicep = apgl.makeColorBar(cicep_cmap, {label: "Sleet Reflectivity (dBZ)", size_long: 320, size_short: 67, fontface: 'Trebuchet MS',
                                                     ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});
    const svg_cfrzr = apgl.makeColorBar(cfrzr_cmap, {label: "Freezing Rain Reflectivity (dBZ)", size_long: 320, size_short: 67, fontface: 'Trebuchet MS',
                                                     ticks: [-20, -10, 0, 10, 20, 30, 40, 50],
                                                     orientation: 'horizontal', tick_direction: 'bottom'});

    return {layers: [raster_layer], colorbar: [svg_crain, svg_csnow, svg_cicep, svg_cfrzr]};
}

async function makeObsLayers() {
    const skyc_choices = ['0/8', '1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', '8/8', 'obsc', null];
    const preswx_choices = ['fu', 'hz', 'du', 'bldu', 'po', 'vcds',
                            'br', 'bc', 'mifg', 'vcts', 'virga', 'vcsh', 'ts',
                            'sq', 'fc', 'ds', '+ds', 'drsn', '+drsn', '-blsn', '+blsn',
                            'vcfg', 'bcfg', 'prfg', 'fg', 'fzfg',
                            '-vctsdz', '-dz', '-dzbr', 'vctsdz', 'dz', '+vctsdz', '+dz', '-fzdz', 'fzdz', '-dzra', '+dzra',
                            '-ra', 'ra', '+ra', '-fzra', 'fzra', '-rasn', 'rasn', '-sn', 'sn', '+sn', 'ic', 'pl',
                            '-sh', 'sh', '-shsnra', '+shrabr', '-shsn', 'shsn', '-gs', '-sngs', '-gr', 'gr',
                            'tsrasn', 'tsra', 'tspl', 'tsgr', '+tsfzrapl', '+tsra', '+tssn', 'tssa', '+tsgr',
                            '-up', '+up', '-fzup', '+fzup'];

    const resp = await fetch('data/metar/surface_20240823_1500.json');
    const obs = await resp.json();

    obs.forEach((ob, iob) => {
        ob.data.skyc = skyc_choices[iob % skyc_choices.length];
        ob.data.preswx = preswx_choices[iob % preswx_choices.length];
    });

    const obs_grid = new apgl.UnstructuredGrid(obs.map(o => o.coord));
    const obs_field = new apgl.RawObsField(obs_grid, obs.map(o => o.data));

    const station_plot_locs = {
        tmpf: {type: 'number', pos: 'ul', halo: false, color: '#cc0000', formatter: val => val === null ? '' : val.toFixed(0)},
        dwpf: {type: 'number', pos: 'll', halo: false, color: '#00aa00', formatter: val => val === null ? '' : val.toFixed(0)},
        wind: {type: 'barb', pos: 'c', color: '#ffffff'},
        // preswx: {type: 'symbol', pos: 'cl', halo: false, color: '#ff00ff'},
        // skyc: {type: 'symbol', pos: 'c'},
    };
    const station_plot = new apgl.StationPlot(obs_field, {config: station_plot_locs, thin_fac: 8, font_size: 14, font_url_template: "font/{fontstack}/{range}.pbf"});
    const station_plot_layer = new apgl.PlotLayer('station-plots', station_plot);

    return {layers: [station_plot_layer]};
}

// Register makeLayers implementations for each catalog entry that has been implemented.
// IDs must match the corresponding "id" field in data/catalog.json.
DataRegistry.register('synthetic_500mb', makeSynthetic500mbLayers);
DataRegistry.register('gfs_t2m',         makeGFSLayers);
DataRegistry.register('href',            makeHREFLayers);
DataRegistry.register('mrms_cref',       makeMRMSLayers);
DataRegistry.register('metar',           makeObsLayers);

// ---------------------------------------------------------------------------------------------
// On Load of the page, load the catalog, create the map, and populate the view selection menu.
// This is the initialization section for the page or the main() in a way.
// ---------------------------------------------------------------------------------------------
window.addEventListener('load', async () => {
    // Load the dataset catalog from data/catalog.json (analogous to GEMPAK's datatype.tbl),
    // then build the views map from catalog entries that have a registered makeLayers function.
    await DataCatalog.load();
    const views = DataCatalog.buildViews();

    // Populate the view selection menu with the available views.  The menu will be updated with new layers and colorbars when the user selects a different view from the menu.
    const menu = document.querySelector('#view-select');
    menu.innerHTML = Object.entries(views).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');

    //Set up the MapLibre GL map with a custom style and initial view settings.  The map will be updated with new layers and colorbars when the user selects a different view from the menu.
    const map = new maplibregl.Map({
        container: 'map',
        style: 'http://localhost:9000/style.json',
        center: [-97.5, 38.5],
        zoom: 4,
        maxZoom: 7,
        projection: 'globe',
    });

    // Keep track of the current layers and mousemove handler so they can be removed when a new view is selected
    let current_layers = [];
    let current_mousemove_handler = null;

    // ------------------------------------------------------------------
    // Frame-time controller (dominant-source timeline playback scaffold)
    // ------------------------------------------------------------------
    const frameTimeValueEl = document.querySelector('#frame-time-value');
    const FRAME_PLAY_INTERVAL_MS = 900;
    let frameTimes = [];            // ascending (oldest -> newest)
    let currentFrameIdx = -1;       // index into frameTimes
    let playbackTimer = null;
    let playbackMode = 'pause';     // 'pause' | 'loop-fwd' | 'loop-back' | 'rock'
    let rockDirection = 1;          // +1 forward, -1 backward

    // Format the Frame DateTime
    function _fmtFrameUTC(dt) {
        if (!(dt instanceof Date)) return '--';
        const pad = n => String(n).padStart(2, '0');
        const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getUTCMonth()];
        return `${pad(dt.getUTCDate())} ${mon} ${dt.getUTCFullYear()} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())} UTC`;
    }

    // update the frame-time display in the UI based on the current frame index and the list of frame times
    function _updateFrameDisplay() {
        const cur = (currentFrameIdx >= 0 && currentFrameIdx < frameTimes.length) ? frameTimes[currentFrameIdx] : null;
        const idxTxt = (cur && frameTimes.length) ? ` [${currentFrameIdx + 1}/${frameTimes.length}]` : '';
        frameTimeValueEl.textContent = cur ? `${_fmtFrameUTC(cur)}${idxTxt}` : '--';
    }

    // set the current frame index and update the display.  If the index is out of bounds, it will be clamped to the valid range.
    function _setCurrentFrameIdx(idx) {
        if (!frameTimes.length) {
            currentFrameIdx = -1;
            _updateFrameDisplay();
            return;
        }
        currentFrameIdx = Math.max(0, Math.min(frameTimes.length - 1, idx));
        _updateFrameDisplay();
        // Debug: log timeline and current index for playback verification
        try { console.debug('%c[FRAMES]%c currentIdx=%d / total=%d currentTime=%s', 'color:#4a9eff;font-weight:bold', 'color:inherit', currentFrameIdx, frameTimes.length, frameTimes[currentFrameIdx] ? frameTimes[currentFrameIdx].toISOString() : 'null'); } catch (e) {}
        // Refresh dynamic layers when the current frame changes so subscripts
        // that produce per-frame PlotLayers are applied immediately.
        try { updateMap(); } catch (e) { /* ignore timing races during startup */ }
    }

    // stop any ongoing playback and clear the playback timer
    function _stopPlayback() {
        if (playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = null;
        }
        playbackMode = 'pause';
    }
    
    // step the current frame index by delta, wrapping around if necessary.  If delta is negative and the current frame index is 0, it will wrap to the last frame.
    function _step(delta) {
        if (delta < 0 && currentFrameIdx === 0) {
            _setCurrentFrameIdx(frameTimes.length - 1);
            return;
        }
        if (!frameTimes.length) return;
        _setCurrentFrameIdx(currentFrameIdx + delta >= frameTimes.length ? 0 : currentFrameIdx + delta);
    }

    // step the current frame index forward by 1, wrapping around to 0 if necessary
    function _tickLoopForward() {
        if (!frameTimes.length) return;
        const next = currentFrameIdx + 1;
        _setCurrentFrameIdx(next >= frameTimes.length ? 0 : next);
    }

    // step the current frame index backward by 1, wrapping around to the last frame if necessary
    function _tickLoopBackward() {
        if (!frameTimes.length) return;
        const next = currentFrameIdx - 1;
        _setCurrentFrameIdx(next < 0 ? frameTimes.length - 1 : next);
    }

    // step the current frame index forward or backward by 1, reversing direction when the end or beginning of the frame times is reached
    function _tickRock() {
        if (!frameTimes.length) return;
        if (frameTimes.length === 1) {
            _setCurrentFrameIdx(0);
            return;
        }
        let next = currentFrameIdx + rockDirection;
        if (next >= frameTimes.length) {
            rockDirection = -1;
            next = frameTimes.length - 2;
        } else if (next < 0) {
            rockDirection = 1;
            next = 1;
        }
        _setCurrentFrameIdx(next);
    }

    // start playback in the specified mode ('loop-fwd', 'loop-back', or 'rock').  If the same mode is already active, it will stop playback.  If a different mode is active, it will switch to the new mode.
    function _startPlayback(mode) {
        if (!frameTimes.length) return;
        if (playbackMode === mode && playbackTimer) {
            _stopPlayback();
            return;
        }
        _stopPlayback();
        playbackMode = mode;
        if (mode === 'rock') rockDirection = 1;
        playbackTimer = setInterval(() => {
            if (playbackMode === 'loop-fwd') _tickLoopForward();
            else if (playbackMode === 'loop-back') _tickLoopBackward();
            else if (playbackMode === 'rock') _tickRock();
        }, FRAME_PLAY_INTERVAL_MS);
    }

    // set the list of frame times from the dominant source, normalizing them to Date objects and sorting them in ascending order.  The current frame index will be set to the last frame (newest) by default.
    function _setFrameTimesFromDominant(framesNewestToOldest) {
        _stopPlayback();
        const normalized = (Array.isArray(framesNewestToOldest) ? framesNewestToOldest : [])
            .map(t => t instanceof Date ? new Date(t.getTime()) : new Date(t))
            .filter(d => Number.isFinite(d.getTime()));
        normalized.sort((a, b) => a.getTime() - b.getTime()); // oldest -> newest
        frameTimes = normalized;
        // Default to latest frame when a new timeline is applied
        _setCurrentFrameIdx(frameTimes.length ? frameTimes.length - 1 : -1);
    }

    // Expose central frame-time state for future loader integration.
    window.NmapFrameState = {
        getTimes: () => frameTimes.slice(),
        getCurrentIndex: () => currentFrameIdx,
        getCurrentTime: () => (currentFrameIdx >= 0 && currentFrameIdx < frameTimes.length) ? new Date(frameTimes[currentFrameIdx].getTime()) : null,
        setCurrentIndex: (idx) => _setCurrentFrameIdx(+idx || 0),
    };

    // ------------------------------------------------------------------
    // Map update function
    // ------------------------------------------------------------------
    // Right now, this function gets called every time we step forward a frame or back a frame
    // We need this function to use Tim's lovely MultiPlotLayer functionality to create a smooth
    // transition between frames.  Upon the load of the data, we need to generate the MultiPlotLayers
    // and add/delete the field whenever new data comes in that needs to be added to the loop.
    // TODO: Update the updateMap function to use the MultiPlotLayer
    async function updateMap() {
        const view = views[menu.value];
        console.debug('%c[NMAP]%c updateMap() → view="%s"', 'color:#55d46a;font-weight:bold', 'color:inherit', menu.value);
        map.setMaxZoom(view.maxZoom);

        // If a subscript is registered for this view and we have timeline
        // information, prefer the subscript so it can produce per-frame layers.
        let layers, colorbar, sampler;
        if (window.SubscriptRegistry && SubscriptRegistry.has(menu.value) && frameTimes.length) {
            const currentTime = window.NmapFrameState.getCurrentTime();
            const obj = await SubscriptRegistry.getLayersForFrame(menu.value, currentTime, {
                declarativeRasterRenderer: null
            });
            if (obj && obj.layers) {
                layers = obj.layers;
                colorbar = obj.colorbar;
                sampler = obj.sampler;
            }
        }
        if (!layers) {
            const res = await view.makeLayers();
            layers = res.layers; colorbar = res.colorbar; sampler = res.sampler;
        }

        // Add new layers before removing old ones where possible to avoid
        // a brief blank state (flicker) during the swap. If a new layer id
        // already exists on the map, remove that existing layer first to
        // prevent addLayer collisions.
        const newIds = (layers || []).map(l => l && l.id).filter(Boolean);
        for (const id of newIds) {
            if (map.getLayer(id)) {
                try { map.removeLayer(id); } catch (e) { /* best-effort */ }
            }
        }
        // If AutumnPlot-GL exposes MultiLayerPlot, prefer a single multi-layer
        // wrapper per view so AutumnPlot can composite internally and avoid
        // visible flicker. Otherwise fall back to adding each PlotLayer.
        let usedMulti = false;
        try {
            if (window.apgl && typeof apgl.MultiLayerPlot === 'function' && Array.isArray(layers) && layers.length) {
                const mlKey = `${menu.value}-ml`;
                window._apglMultiLayerMap = window._apglMultiLayerMap || {};
                let ml = window._apglMultiLayerMap[mlKey];
                if (ml) {
                    // Update existing multilayer instance if supported.
                    if (typeof ml.setLayers === 'function') {
                        ml.setLayers(layers);
                    } else {
                        // Not updatable — remove and recreate.
                        try { if (map.getLayer(ml.id)) map.removeLayer(ml.id); } catch (e) {}
                        ml = new apgl.MultiLayerPlot(mlKey, layers);
                        map.addLayer(ml);
                        window._apglMultiLayerMap[mlKey] = ml;
                    }
                } else {
                    // Create and register new MultiLayerPlot
                    ml = new apgl.MultiLayerPlot(mlKey, layers);
                    map.addLayer(ml);
                    window._apglMultiLayerMap[mlKey] = ml;
                }
                // Mark we used multilayer rendering and ensure current_layers
                // contains the single multilayer entry so later cleanup knows
                // what to remove.
                current_layers = [{ id: ml.id }];
                usedMulti = true;
            }
        } catch (err) {
            console.warn('updateMap: MultiLayerPlot integration failed', err && err.message);
            usedMulti = false;
        }

        if (!usedMulti) {
            for (const lyr of (layers || [])) {
                try { map.addLayer(lyr); } catch (err) { console.warn('updateMap: failed to add layer', lyr && lyr.id, err && err.message); }
            }
        }
        // Remove old layers that weren't re-used by the new set.
        const keep = new Set(newIds);
        for (const old of current_layers || []) {
            if (!old || !old.id) continue;
            if (keep.has(old.id)) continue;
            try { if (map.getLayer(old.id)) map.removeLayer(old.id); } catch (e) { /* ignore */ }
        }

        // Setup colorbar panel in the bottom part of the page.  If there are multiple colorbars, they will be stacked according to AutumnPlot-GL
        const colorbar_panel = document.querySelector('#colorbar-panel');
        const colorbar_container = document.querySelector('#colorbar');
        colorbar_container.innerHTML = '';

        // If there are colorbars, add them to the colorbar container and show the colorbar panel.  If there are no colorbars, hide the colorbar panel.
        if (colorbar && colorbar.length > 0) {
            colorbar.forEach(cb => colorbar_container.appendChild(cb));
            colorbar_panel.classList.remove('hidden');
        } else {
            colorbar_panel.classList.add('hidden');
        }

        current_layers = layers;

        // Readout from mousemove events to display coordinates, geographical locations (e.g., lat/lon, counties, asos, etc.) similar to NMAP2's lower right hand corner thingy and sampled data values
        const readout = document.querySelector('#readout');

        // Remove the previous mousemove handler if it exists, and set up a new one that samples data values at the mouse location and displays them in the readout.  If no sampler is provided, just display the lat/lon coordinates.
        if (current_mousemove_handler) {
            map.off('mousemove', current_mousemove_handler);
            current_mousemove_handler = null;
        }
        
        // TODO: Include other options for the readout, such as displaying the coordinates in different formats (e.g., DMS, UTM, etc.) and displaying additional information (e.g., elevation, county, country, state, time, etc.) and displaying the readout in a tooltip or popup instead of the readout.
        if (sampler !== undefined) {
            // If a sampler is provided, use it to sample data values at the mouse location and display them in the readout

            // TODO: provide options to display the sampled data values in different formats (e.g., raw, formatted, etc.) and to display additional information (e.g., units, descriptions, etc.) and to display the sampled data values in a tooltip or popup instead of the readout

            current_mousemove_handler = (ev) => {
                const coord = ev.lngLat.wrap();
                readout.innerHTML = `${coord.lat.toFixed(2)}°N ${coord.lng.toFixed(2)}°E`;
                const sample = sampler(coord.lng, coord.lat);
                if (sample) {
                    const str = Object.entries(sample)
                        .map(([sn, s]) => Array.isArray(s) ? `${sn}: ${s[0].toFixed(0)}/${s[1].toFixed(0)}` : `${sn}: ${s.toFixed(1)}`)
                        .join(', ');
                    readout.innerHTML += ` | ${str}`;
                }
            };
        } else {
            // If no sampler is provided, just display the lat/lon coordinates

            current_mousemove_handler = (ev) => {
                const coord = ev.lngLat.wrap();
                readout.innerHTML = `${coord.lat.toFixed(2)}°N ${coord.lng.toFixed(2)}°E`;
            };
        }
        map.on('mousemove', current_mousemove_handler);
    }

    // Initial map update when the page loads, and also when the user selects a different view from the menu
    map.on('load', () => {
        console.info('%c[NMAP]%c Map loaded — MapLibre ready', 'color:#55d46a;font-weight:bold', 'color:inherit');
        updateMap();
        ProductGen.init(map);
    });
    menu.addEventListener('change', updateMap);

    // --- Toolbar buttons ---

    // Playback controls (timeline scaffold only; data loading by frame is wired later)
    document.querySelector('#btn-goto-first').addEventListener('click', () => {
        _stopPlayback();
        _setCurrentFrameIdx(0);
    });
    document.querySelector('#btn-goto-last').addEventListener('click', () => {
        _stopPlayback();
        _setCurrentFrameIdx(frameTimes.length - 1);
    });
    document.querySelector('#btn-step-back').addEventListener('click', () => {
        _stopPlayback();
        _step(-1);
    });
    document.querySelector('#btn-step-fwd').addEventListener('click', () => {
        _stopPlayback();
        _step(+1);
    });
    document.querySelector('#btn-loop-back').addEventListener('click', () => _startPlayback('loop-back'));
    document.querySelector('#btn-loop-fwd').addEventListener('click', () => _startPlayback('loop-fwd'));
    document.querySelector('#btn-rock').addEventListener('click', () => _startPlayback('rock'));

    // Keyboard controls for timeline playback (spacebar toggles pause/play, left/right arrows step backward/forward, up/down arrows toggle loop forward/back)
    document.addEventListener('keydown', (ev) => {
        if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
        if (ev.code === 'Space') {
            ev.preventDefault();
            if (playbackMode === 'pause') _startPlayback('loop-fwd');
            else _stopPlayback();
        } else if (ev.code === 'Comma') {
            ev.preventDefault();
            _stopPlayback();
            
            _step(-1);
        } else if (ev.code === 'Period') {
            ev.preventDefault();
            _stopPlayback();
            _step(+1);
        } else if (ev.code === 'KeyL') {
            ev.preventDefault();    
            _startPlayback('loop-fwd');
        } else if (ev.code === 'KeyK') {
            ev.preventDefault();
            _startPlayback('loop-back');
        }
    });

    _updateFrameDisplay();

    /* -------------------------------------------------------------------------
    /  This section of the code connects the toolbar buttons for different functionalities
    /  to their respective listeners and configuration.
    / -------------------------------------------------------------------------*/

    // Initialize the Layer Manager (which internally initialises DataSelector).
    // "Load Data" opens the Layer Manager so the user can add / remove sources,
    // set the dominant source, choose frame count / skip, then hit Apply.
    LayerManager.init();
    document.querySelector('#btn-load').addEventListener('click', () => {
        LayerManager.open(({ sources, dominantId, numFrames, frameSkip, frames }) => {
            // For now, render the dominant source (or first source) using the
            // existing single-view pipeline.  Multi-layer simultaneous rendering
            // can be wired here once the plotter supports stacked PlotLayers.
            const activeId = dominantId || (sources.length ? sources[0].id : null);
            if (!activeId) return;
            // Log the received config
            console.groupCollapsed('%c[NMAP]%c LayerManager applied — loading %d frame(s) of "%s"',
                'color:#55d46a;font-weight:bold', 'color:inherit', frames.length, activeId);
            console.info('  Sources (%d):', sources.length,
                sources.map(s => `${s.id}${s.cycleTime ? ' @'+s.cycleTime.toISOString().slice(0,13)+'Z' : ''}`));
            console.info('  Dominant:', activeId);
            console.info('  numFrames:', numFrames, '  frameSkip:', frameSkip);
            if (frames.length) {
                console.info('  Time range:', frames[frames.length-1].toISOString(), '→', frames[0].toISOString(),
                    `(${((frames[0]-frames[frames.length-1])/3600000).toFixed(1)}h span)`);
            }
            console.groupEnd();

            // Centralize the active timeline to dominant-source frame times.
            _setFrameTimesFromDominant(frames);

            const opt = menu.querySelector(`option[value="${activeId}"]`);
            if (opt) {
                menu.value = activeId;
                updateMap();
            } else {
                console.warn(`LayerManager: id "${activeId}" not in view-select menu`);
            }
        });
    });

    // Freeze Map Location: lock/unlock pan and zoom interactions
    // This is so the user can do other things without having to worry
    // about accidentally moving the map around.
    let locationFrozen = false;
    const freezeBtn = document.querySelector('#btn-freeze');
    freezeBtn.addEventListener('click', () => {
        locationFrozen = !locationFrozen;
        freezeBtn.classList.toggle('active', locationFrozen);
        freezeBtn.title = locationFrozen ? 'Unfreeze Map Location' : 'Freeze Map Location';
        if (locationFrozen) {
            map.dragPan.disable();
            map.scrollZoom.disable();
            map.boxZoom.disable();
            map.doubleClickZoom.disable();
            map.touchZoomRotate.disable();
            map.keyboard.disable();
        } else {
            map.dragPan.enable();
            map.scrollZoom.enable();
            map.boxZoom.enable();
            map.doubleClickZoom.enable();
            map.touchZoomRotate.enable();
            map.keyboard.enable();
        }
    });

    // Auto-Update: reload data on a fixed interval (60 seconds)
    const AUTO_UPDATE_INTERVAL_MS = 60000;
    let autoUpdateTimer = null;
    const autoUpdateBtn = document.querySelector('#btn-autoupdate');
    autoUpdateBtn.addEventListener('click', () => {
        if (autoUpdateTimer) {
            clearInterval(autoUpdateTimer);
            autoUpdateTimer = null;
            autoUpdateBtn.classList.remove('active');
            autoUpdateBtn.title = 'Auto-Update (off)';
        } else {
            autoUpdateTimer = setInterval(updateMap, AUTO_UPDATE_INTERVAL_MS);
            autoUpdateBtn.classList.add('active');
            autoUpdateBtn.title = 'Auto-Update (on)';
        }
    });

    // Connect the Product Generation Button to the panel
    const productBtn = document.querySelector('#btn-product');
    productBtn.addEventListener('click', () => {
        const nowOpen = ProductGen.toggle();
        productBtn.classList.toggle('active', nowOpen);
    });

    // Template: placeholder for future functionality
    document.querySelector('#btn-template').addEventListener('click', () => {
        // TODO: implement
    });
});
