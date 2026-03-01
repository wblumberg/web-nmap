/* Demo subscript for synthetic_500mb

Exports a factory function registered with SubscriptRegistry that produces
AutumnPlot-GL layers for a requested frame/time. The implementation mirrors
the existing makeSynthetic500mbLayers but accepts a frameTime to vary the
generated fields so playback shows changes.
*/

'use strict';

(function(){
    async function makeForFrame(frameTime, ctx) {
        // frameTime may be a Date or an index; convert to a numeric key
        let key = 0;
        if (frameTime instanceof Date) key = Math.floor(frameTime.getTime() / 3600000) % 500;
        else if (typeof frameTime === 'number') key = frameTime;

        const nx = 121, ny = 61;
        const grid = new apgl.PlateCarreeGrid(nx, ny, -130, 20, -65, 55);
        const coords = grid.getGridCoords();

        // Increase perturbation and speed for more visible temporal variation
        const height_base = 570;
        const height_pert = 40;   // larger height perturbation
        const height_grad = 0.5;
        const vel_pert = 180;     // larger wind amplitude
        const speed = 0.005;      // faster temporal phase change

        function makeHeight(k) {
            const h = new Float32Array(nx * ny);
            for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
                const idx = i + j * nx;
                if (i < 10 && j < 10) h[idx] = NaN;
                else h[idx] = height_base + height_pert * (Math.cos(-k * speed + 4 * Math.PI * i / (nx - 1)) * Math.cos(2 * Math.PI * j / (ny - 1))) - 61 * height_grad * j / ny;
            }
            return new apgl.RawScalarField(grid, h);
        }

        function makeWinds(k) {
            const u = new Float32Array(nx * ny);
            const v = new Float32Array(nx * ny);
            for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
                const idx = i + j * nx;
                if (i < 10 && j < 10) { u[idx] = v[idx] = NaN; continue; }
                let v_fac = 1;
                if (grid.type == 'latlon' || grid.type == 'latlonrot') v_fac = Math.cos(coords.y[j] * Math.PI / 180);
                let u_earth = vel_pert * (Math.cos(-k * speed + 4 * Math.PI * i / (nx - 1)) * Math.sin(2 * Math.PI * j / (ny - 1)) + height_grad);
                let v_earth = -vel_pert * Math.sin(-k * speed + 4 * Math.PI * i / (nx - 1)) * Math.cos(2 * Math.PI * j / (ny - 1));
                const mag = Math.hypot(u_earth, v_earth);
                v_earth /= v_fac;
                u[idx] = u_earth * mag / Math.hypot(u_earth, v_earth);
                v[idx] = v_earth * mag / Math.hypot(u_earth, v_earth);
            }
            return new apgl.RawVectorField(grid, u, v, {relative_to: 'grid'});
        }

        function makeWindSpeed(k) {
            const winds = makeWinds(k);
            const wspd = new Float32Array(winds.u.data.length);
            for (let idx = 0; idx < winds.u.data.length; idx++) wspd[idx] = Math.hypot(winds.u.data[idx], winds.v.data[idx]);
            return new apgl.RawScalarField(grid, wspd);
        }

        const raw_hght_field = makeHeight(key);
        const raw_wind_field = makeWinds(key);
        const raw_ws_field = makeWindSpeed(key);

        // Make contour interval and filled opacity vary with time to emphasize
        // frame-to-frame differences.
        const interval = 2; // coarser contours for visibility
        const dynamicOpacity = 0.35 + 0.65 * Math.abs(Math.sin(key * 0.25));
        const cntr = new apgl.Contour(raw_hght_field, {interval: interval, color: '#ffffff', line_width: lev => lev < 565 ? 2 : 4, line_style: lev => lev < 555 ? '--' : '-'});
        const filled = new apgl.ContourFill(raw_ws_field, {cmap: apgl.colormaps.pw_speed500mb, opacity: dynamicOpacity});
        const barbs = new apgl.Barbs(raw_wind_field, {color: '#ffffff', thin_fac: 16});
        const labels = new apgl.ContourLabels(cntr, {text_color: '#ffffff', halo: true, font_url_template: 'font/{fontstack}/{range}.pbf'});

        // Append a time-key suffix to each layer id so the map receives
        // distinct layers per-frame and the update logic will remove the
        // previous frame's layers before adding the new ones.
        const suffix = `-t${key}`;
        const hght_layer = new apgl.PlotLayer('synthetic-height' + suffix, cntr);
        const ws_layer = new apgl.PlotLayer('synthetic-windspeed' + suffix, filled);
        const barb_layer = new apgl.PlotLayer('synthetic-barbs' + suffix, barbs);
        const label_layer = new apgl.PlotLayer('synthetic-labels' + suffix, labels);

        const svg = apgl.makeColorBar(apgl.colormaps.pw_speed500mb, {label: 'Wind Speed (kts)', fontface: 'Trebuchet MS', orientation: 'horizontal'});

        return { layers: [ws_layer, hght_layer, barb_layer, label_layer], colorbar: [svg], sampler: (lon, lat) => ({ hght: raw_hght_field.sampleField(lon, lat), barb: raw_wind_field.sampleField(lon, lat) }) };
    }

    // Register with global SubscriptRegistry if available; fallback to DataRegistry so
    // existing code paths continue to work.
    if (window.SubscriptRegistry && typeof window.SubscriptRegistry.registerModule === 'function') {
        window.SubscriptRegistry.registerModule('synthetic_500mb', makeForFrame);
    } else if (window.DataRegistry && typeof window.DataRegistry.register === 'function') {
        // keep backward compatibility for environments that call DataRegistry directly
        window.DataRegistry.register('synthetic_500mb', () => makeForFrame(0, {}));
    }

    // Expose for tests
    window._demo_synthetic_subscript = makeForFrame;
})();
