// Products group: BASIC
// Analogous to the "basic" group entries in NMAP2's mod_res.tbl
// Covers: temperature, dewpoint, heights, winds

import COLORMAPS from '../../config/colormaps.js';

export default {

    'sfc_temp_fill': {
        label: '2m Temperature (Filled)',
        group: 'basic',
        available_for: ['GFS', 'NAM', 'HRRR', 'RAP', 'ECMWF_HR'],
        data_keys: ['temperature_2m'],
        make_layers(data, grid) {
            const tempF = data.temperature_2m.map(v => (v - 273.15) * 9/5 + 32);
            const field = new apgl.RawScalarField(grid, tempF);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_t2m'] });
            const cntr  = new apgl.Contour(field, { levels: [32], line_width: 3, color: '#ffffff' });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_t2m'], {
                label: '2m Temperature (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [-40, -20, 0, 20, 40, 60, 80, 100, 120],
            });
            return {
                layers: [
                    new apgl.PlotLayer('t2m_fill', fill),
                    new apgl.PlotLayer('t2m_32f',  cntr),
                ],
                colorbar: [svg],
                sampler: (lon, lat) => ({ temperature_2m: field.sampleField(lon, lat) }),
            };
        },
    },

    'sfc_dwpt_fill': {
        label: '2m Dewpoint (Filled)',
        group: 'basic',
        available_for: ['GFS', 'NAM', 'HRRR', 'RAP', 'ECMWF_HR'],
        data_keys: ['dewpoint_2m'],
        make_layers(data, grid) {
            const dwptF = data.dewpoint_2m.map(v => (v - 273.15) * 9/5 + 32);
            const field = new apgl.RawScalarField(grid, dwptF);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_td2m'], opacity: 0.5 });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_td2m'], {
                label: '2m Dewpoint (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
            });
            return {
                layers: [new apgl.PlotLayer('d2m_fill', fill)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ dewpoint_2m: field.sampleField(lon, lat) }),
            };
        },
    },

    'sfc_dwpt_fill_mean': {
        label: 'Mean 2m Dewpoint (Filled) and MSLP (Contours)',
        group: 'basic',
        available_for: ['HREF'],
        data_keys: ['mean_DPT_hght_2', 'mean_MSLMA'],
        make_layers(data, grid) {
            const field = new apgl.RawScalarField(grid, data.mean_DPT_hght_2);
            const fill  = new apgl.ContourFill(field, { cmap: COLORMAPS['pw_td2m'] });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_td2m'], {
                label: 'Mean 2-m Dewpoint (°F)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70, 80]
            });
            const cntr = new apgl.Contour(
                new apgl.RawScalarField(grid, data.mean_MSLMA),
                { interval: 4, color: '#ffffff', line_width: 3 }
            );
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#ffffff', halo: true, font_size: 16, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            return {
                layers: [new apgl.PlotLayer('2m_fill', fill), new apgl.PlotLayer('mslp_cntr', cntr), new apgl.PlotLayer('mslp_lbls', lbls)],
                //layers: [new apgl.PlotLayer('mslp_cntr', cntr), new apgl.PlotLayer('mslp_lbls', lbls)],
                colorbar: [svg],
                sampler: (lon, lat) => ({ mean_DPT_hght_2: field.sampleField(lon, lat) }),
            };
        },
    },

    '500mb_analysis': {
        label: '500mb Heights / Wind Speed / Barbs',
        group: 'basic',
        available_for: ['GFS', 'NAM', 'HRRR', 'RAP', 'ECMWF_HR'],
        data_keys: ['hght_500mb', 'ugrd_500mb', 'vgrd_500mb'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const hght  = new apgl.RawScalarField(grid, data.hght_500mb);
            const wind  = new apgl.RawVectorField(grid, data.ugrd_500mb, data.vgrd_500mb,
                                                  { relative_to: 'grid' });
            const wspdData = new Float32Array(data.ugrd_500mb.length);
            for (let i = 0; i < wspdData.length; i++)
                wspdData[i] = Math.hypot(data.ugrd_500mb[i], data.vgrd_500mb[i]);
            const wspd  = new apgl.RawScalarField(grid, wspdData);

            const fill  = new apgl.ContourFill(wspd,  { cmap: COLORMAPS['pw_speed500mb'], opacity: 0.8 });
            const cntr  = new apgl.Contour(hght, {
                interval: 6, color: '#000000',
                line_width: lev => (lev % 60 === 0) ? 3 : 1.5,
            });
            const barbs = new apgl.Barbs(wind,  { color: '#000000', thin_fac: 16 });
            const lbls  = new apgl.ContourLabels(cntr, {
                text_color: '#ffffff', halo: true,
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });
            const svg   = apgl.makeColorBar(COLORMAPS['pw_speed500mb'], {
                label: '500mb Wind Speed (kts)',
                orientation: 'horizontal', tick_direction: 'bottom',
                fontface: 'Trebuchet MS',
                ticks: [20, 40, 60, 80, 100, 120, 140],
            });
            return {
                layers: [
                    new apgl.PlotLayer('500_fill',  fill),
                    new apgl.PlotLayer('500_cntr',  cntr),
                    new apgl.PlotLayer('500_barbs', barbs),
                    new apgl.PlotLayer('500_lbls',  lbls),
                ],
                colorbar: [svg],
                sampler: (lon, lat) => ({
                    hght: hght.sampleField(lon, lat),
                    wind: wind.sampleField(lon, lat),
                }),
            };
        },
    },
};
