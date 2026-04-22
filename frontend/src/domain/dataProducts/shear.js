export default {

    'mn_06_shear': {
        label: 'Mean 0-6 km Shear',
        group: 'shear',
        available_for: ['NSSL_GEFS'],
        data_keys: ['mean_USHR_hght_6000_0', 'mean_VSHR_hght_6000_0'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            //console.log('[mn_06_shear] grid:', {
            //    type: grid?.constructor?.name,
            //    nx: grid?.nx,
            //    ny: grid?.ny,
            //    projection: grid?.projection ?? grid?.proj,
            //    total_points: grid?.nx * grid?.ny,
            //});
            //console.log('[mn_06_shear] u field type:', data.mean_USHR_hght_6000_0?.constructor?.name);
            //console.time('renderCPU');
            const u = data.mean_USHR_hght_6000_0.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v = data.mean_VSHR_hght_6000_0.multiply(1.94384).renderCPU(); // Convert from m/s to knots

            const wspd = apgl.RawScalarField.aggregateFields(Math.hypot, u, v).renderCPU();
            const wspd_mask = wspd.data.map(val => val >= 30); // Mask values below 30 knots
            const u_masked = new apgl.RawScalarField(grid, u.data.map((val, i) => wspd_mask[i] ? val : NaN));
            const v_masked = new apgl.RawScalarField(grid, v.data.map((val, i) => wspd_mask[i] ? val : NaN));

            //console.timeEnd('renderCPU');

            //console.time('RawVectorField');
            const wind = new apgl.RawVectorField(grid, u_masked.data, v_masked.data, { relative_to: 'earth' });
            //console.timeEnd('RawVectorField');
            //const tmpc_cntr  = new apgl.Contour(tmpc, {
            //    interval: 4, color: '#da4343',
            //    line_width: 2, line_style: '--',
            //});
            //console.time('Barbs');
            const shear_cmap = new apgl.ColorMap(
                [30, 40, 50, 60, 70],
                ['#a1a9bd', '#91a5bc', '#7594c0', '#6974c8'],
                { overflow_color:  '#5b5bbb' }
            );

            const barbs = new apgl.Barbs(wind, { cmap: shear_cmap, thin_fac: 16 });
            //console.timeEnd('Barbs');
            //const hght_lbls  = new apgl.ContourLabels(hght_cntr, {
            //    text_color: '#ecec5e', halo: true, halo_color: '#000000',
            //    font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            //});

            const shear_cbar = apgl.makeColorBar(shear_cmap, {
                label: '0-6 km Shear [kt]', fontface: 'Trebuchet MS',
                ticks: [30, 40, 50, 60, 70, 80],
                orientation: 'horizontal', tick_direction: 'bottom',
            });

            return {
                layers: [
                    new apgl.PlotLayer('0_6_shear_barbs', barbs),
                    //new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                ],
                colorbar: [shear_cbar],
                sampler: [],
            };
        },
    },

    '06_shear': {
        label: 'Surface to 6 km Shear Vector',
        group: 'shear',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['sh6u', 'sh6v'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {
            const u = data.sh6u.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v = data.sh6v.multiply(1.94384).renderCPU(); // Convert from m/s to knots

            const wspd = apgl.RawScalarField.aggregateFields(Math.hypot, u, v).renderCPU();
            const wspd_mask = wspd.data.map(val => val >= 30); // Mask values below 30 knots
            const u_masked = new apgl.RawScalarField(grid, u.data.map((val, i) => wspd_mask[i] ? val : NaN));
            const v_masked = new apgl.RawScalarField(grid, v.data.map((val, i) => wspd_mask[i] ? val : NaN));

            const wind = new apgl.RawVectorField(grid, u_masked.data, v_masked.data, { relative_to: 'earth' });

            const shear_cmap = new apgl.ColorMap(
                [30, 40, 50, 60, 70],
                ['#a1a9bd', '#91a5bc', '#7594c0', '#6974c8'],
                { overflow_color:  '#5b5bbb' , underflow_color: '#ffffff' }
            );

            const barbs = new apgl.Barbs(wind, { cmap: shear_cmap, thin_fac: 16 });
            const shear_mag = new apgl.Contour(wspd, {
                levels: [30,40,50,60,70], cmap: shear_cmap,
                line_width: 2, line_style: '-',
            });
            const hght_lbls  = new apgl.ContourLabels(shear_mag, {
                text_color: '#d6d6d6', halo: true, halo_color: '#000000',
                font_url_template: 'https://autumnsky.us/glyphs/{fontstack}/{range}.pbf',
            });

            const shear_cbar = apgl.makeColorBar(shear_cmap, {
                label: '0-6 km Shear [kt]', fontface: 'Trebuchet MS',
                ticks: [30, 40, 50, 60, 70, 80],
                orientation: 'horizontal', tick_direction: 'bottom',
            });

            return {
                layers: [
                    new apgl.PlotLayer('06_shear_barbs', barbs),
                    new apgl.PlotLayer('06_shear_mag', shear_mag),
                    new apgl.PlotLayer('06_shear_lbls', hght_lbls),
                    //new apgl.PlotLayer('500_hght_lbls',  hght_lbls),
                ],
                colorbar: [shear_cbar],
                sampler: [],
            };
        },
    },

    'shear_crossover': {
        label: '1, 3, 6 km Shear Crossover',
        group: 'shear',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['sh6u', 'sh6v', 'sh3u', 'sh3v', 'sh1u', 'sh1v'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const u6 = data.sh6u.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v6 = data.sh6v.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const u3 = data.sh3u.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v3 = data.sh3v.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const u1 = data.sh1u.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v1 = data.sh1v.multiply(1.94384).renderCPU(); // Convert from m/s to knots

            console.log('[shear_crossover] values: ' + `u6[0]: ${u6.data[0]}, v6[0]: ${v6.data[0]}, u3[0]: ${u3.data[0]}, v3[0]: ${v3.data[0]}, u1[0]: ${u1.data[0]}, v1[0]: ${v1.data[0]}`);
            const wind_1km = new apgl.RawVectorField(grid, u1.data, v1.data, { relative_to: 'earth' });
            const wind_3km = new apgl.RawVectorField(grid, u3.data, v3.data, { relative_to: 'earth' });
            const wind_6km = new apgl.RawVectorField(grid, u6.data, v6.data, { relative_to: 'earth' });

            const barbs_1km = new apgl.Barbs(wind_1km, { color: '#8d3939', thin_fac: 16 });
            const barbs_3km = new apgl.Barbs(wind_3km, { color: '#598d39', thin_fac: 16 });
            const barbs_6km = new apgl.Barbs(wind_6km, { color: '#398d79', thin_fac: 16 });

            const legend_svg = new apgl.makePaintballKey(['#8d3939', '#598d39', '#398d79'], ['1 km Shear', '3 km Shear', '6 km Shear'], {
                fontface: 'Trebuchet MS',
                n_cols:3,
            });

            return {
                layers: [
                    new apgl.PlotLayer('1km_shear_barbs', barbs_1km),
                    new apgl.PlotLayer('3km_shear_barbs', barbs_3km),
                    new apgl.PlotLayer('6km_shear_barbs', barbs_6km),
                ],
                colorbar: [legend_svg],
                sampler: [],
            };
        },
    },

    'wind_crossover': {
        label: '850-500 mb Crossover',
        group: 'shear',
        available_for: ['MESOANALYSIS_GRID'],
        data_keys: ['urel_850hpa, vrel_850hpa', 'urel_500hpa, vrel_500hpa'],
        // The make_layers() takes in the data object and a grid object and makes the layers we need to visualize
        make_layers(data, grid) {

            const u500 = data.urel_500hpa.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v500 = data.vrel_500hpa.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const u850 = data.urel_850hpa.multiply(1.94384).renderCPU(); // Convert from m/s to knots
            const v850 = data.vrel_850hpa.multiply(1.94384).renderCPU(); // Convert from m/s to knots

            console.log('[shear_crossover] values: ' + `u500[0]: ${u500.data[0]}, v500[0]: ${v500.data[0]}, u850[0]: ${u850.data[0]}, v850[0]: ${v850.data[0]}`);
            const wind_850mb = new apgl.RawVectorField(grid, u850.data, v850.data, { relative_to: 'earth' });
            const wind_500mb = new apgl.RawVectorField(grid, u500.data, v500.data, { relative_to: 'earth' });

            const barbs_850mb = new apgl.Barbs(wind_850mb, { color: '#8d3939', thin_fac: 16 });
            const barbs_500mb = new apgl.Barbs(wind_500mb, { color: '#598d39', thin_fac: 16 });

            const legend_svg = new apgl.makePaintballKey(['#8d3939', '#598d39'], ['850 mb Wind', '500 mb Wind'], {
                fontface: 'Trebuchet MS',
                n_cols:3,
            });

            return {
                layers: [
                    new apgl.PlotLayer('850mb_winds', barbs_850mb),
                    new apgl.PlotLayer('500mb_winds', barbs_500mb),
                ],
                colorbar: [legend_svg],
                sampler: [],
            };
        },
    },

};