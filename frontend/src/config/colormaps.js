// Named colormap registry — analogous to NMAP2's colormap table files.
// Colormaps from autumnplot-gl's built-in library are referenced by name;
// custom ones are defined here.

import * as apgl from "autumnplot-gl";

import href_dwpt_data  from "./href_dwpt.json";
import href_maxuh_data from "./href_maxuh.json";
import href_minuh_data from "./href_minuh.json";
import href_qpf_data   from "./href_qpf.json";
import href_rh_data    from "./href_rh.json";
import pw_qpf_data     from "./pw_qpf.json";
import pw_refl_data    from "./pw_refl.json";
import pw_snow_data    from "./pw_snow.json";
import pw_uh_data      from "./pw_uh.json";
import wv_tpc_data     from "./wv_tpc.json";
import blues_probabilty_data from "./blues_probability.json";
import red_purple_probabilty_data from "./red_purple_probability.json";
import bgy_probability_data from "./bgy_probability.json";
import yrp_probability_data from "./yrp_probability.json";
import satellite_ir_rainbow from "./satellite_IR_enhanced-rainbow_warmer_yellow.json";
import satellite_ir_winter from "./satellite_IR_Color_Clouds_Winter.json";
import scatterometer_wind_speed from "./scatterometer_wind_speed.json";

import epa_aqi_pm25 from "./epa_aqi_pm25.json";
import epa_aqi_pm10 from "./epa_aqi_pm10.json";
import epa_aqi_o3 from "./epa_aqi_o3.json";
import epa_aqi_co from "./epa_aqi_co.json";
import epa_aqi_so2 from "./epa_aqi_so2.json";
import epa_aqi_no2 from "./epa_aqi_no2.json";

// Probability colormaps for precipitation types, custom colors.
import ptype_snow_probability from "./ptype_snow_probability.json";
import ptype_rain_probability from "./ptype_rain_probability.json";
import ptype_frzr_probability from "./ptype_frzr_probability.json";
import ptype_icep_probability from "./ptype_icep_probability.json";

// Reflectivity colormaps for precipitation types, based on PivotalWeather.
import ptype_snow_reflectivity from "./ptype_snow_reflectivity.json";
import ptype_rain_reflectivity from "./ptype_rain_reflectivity.json";
import ptype_frzr_reflectivity from "./ptype_frzr_reflectivity.json";
import ptype_icep_reflectivity from "./ptype_icep_reflectivity.json";

const COLORMAPS = {

    // --- Built-in autumnplot-gl colormaps ---
    'pw_speed500mb': apgl.colormaps.pw_speed500mb,
    'pw_speed850mb': apgl.colormaps.pw_speed850mb,
    // Fully opaque ocean-surface wind scale. The first two bins preserve the
    // distinction between calm circles (<2.5 kt) and 5-kt half barbs, while
    // explicit under/overflow colors prevent valid winds from disappearing.
    'scatterometer_wind_speed': new apgl.ColorMap(
        scatterometer_wind_speed.levels,
        scatterometer_wind_speed.colors,
        {
            underflow_color: scatterometer_wind_speed.underflow_color,
            overflow_color: scatterometer_wind_speed.overflow_color,
        },
    ),
    'pw_cape':       apgl.colormaps.pw_cape,
    'pw_t2m':        apgl.colormaps.pw_t2m,
    'pw_td2m':       apgl.colormaps.pw_td2m,
    'wv_cimms':      apgl.colormaps.wv_cimss,
    'nws_reflectivity':   apgl.colormaps.nws_storm_clear_refl,

    // --- Custom colormaps ---
    'href_dwpt':  new apgl.ColorMap(href_dwpt_data.levels,  href_dwpt_data.colors),
    //'href_maxuh': new apgl.ColorMap(href_maxuh_data.levels, href_maxuh_data.colors),
    //'href_minuh': new apgl.ColorMap(href_minuh_data.levels, href_minuh_data.colors),
    'href_qpf':   new apgl.ColorMap(href_qpf_data.levels,   href_qpf_data.colors, {overflow_color: href_qpf_data.overflow_color}),
    'href_rh':    new apgl.ColorMap(href_rh_data.levels,    href_rh_data.colors),
    'pw_qpf':     new apgl.ColorMap(pw_qpf_data.levels,     pw_qpf_data.colors),
    'pw_refl':    new apgl.ColorMap(pw_refl_data.levels,    pw_refl_data.colors),
    'pw_snow':    new apgl.ColorMap(pw_snow_data.levels,    pw_snow_data.colors),
    'pw_uh':      new apgl.ColorMap(pw_uh_data.levels,      pw_uh_data.colors, {overflow_color: pw_uh_data.overflow_color}),

    'blues_prob': new apgl.ColorMap(blues_probabilty_data.levels, blues_probabilty_data.colors, {underflow_color: blues_probabilty_data.colors[0], overflow_color: blues_probabilty_data.colors[blues_probabilty_data.colors.length - 1]}),
    'red_purple_prob': new apgl.ColorMap(red_purple_probabilty_data.levels, red_purple_probabilty_data.colors, {underflow_color: red_purple_probabilty_data.underflow_color}),
    'bgy_prob': new apgl.ColorMap(bgy_probability_data.levels, bgy_probability_data.colors, {underflow_color: bgy_probability_data.underflow_color}),
    'yrp_prob': new apgl.ColorMap(yrp_probability_data.levels, yrp_probability_data.colors, {underflow_color: yrp_probability_data.underflow_color}),
    
    'wv_tpc':     new apgl.ColorMap( wv_tpc_data.levels,  wv_tpc_data.colors),
    'satellite_ir_rainbow': new apgl.ColorMap(satellite_ir_rainbow.levels, satellite_ir_rainbow.colors, {overflow_color: satellite_ir_rainbow.overflow_color}),
    'satellite_ir_winter': new apgl.ColorMap(satellite_ir_winter.levels, satellite_ir_winter.colors),

    // EPA AQI colormaps for various pollutants, based on https://www.airnow.gov/aqi/aqi-basics/
    'epa_aqi_pm25': new apgl.ColorMap(epa_aqi_pm25.levels, epa_aqi_pm25.colors, {overflow_color: epa_aqi_pm25.overflow_color}),
    'epa_aqi_pm10': new apgl.ColorMap(epa_aqi_pm10.levels, epa_aqi_pm10.colors, {overflow_color: epa_aqi_pm10.overflow_color}),
    'epa_aqi_o3': new apgl.ColorMap(epa_aqi_o3.levels, epa_aqi_o3.colors, {overflow_color: epa_aqi_o3.overflow_color}),
    'epa_aqi_co': new apgl.ColorMap(epa_aqi_co.levels, epa_aqi_co.colors, {overflow_color: epa_aqi_co.overflow_color}),
    'epa_aqi_so2': new apgl.ColorMap(epa_aqi_so2.levels, epa_aqi_so2.colors, {overflow_color: epa_aqi_so2.overflow_color}),
    'epa_aqi_no2': new apgl.ColorMap(epa_aqi_no2.levels, epa_aqi_no2.colors, {overflow_color: epa_aqi_no2.overflow_color}),

    // Precipitation type probability colormaps
    'ptype_snow_probability': new apgl.ColorMap(ptype_snow_probability.levels, ptype_snow_probability.colors),
    'ptype_rain_probability': new apgl.ColorMap(ptype_rain_probability.levels, ptype_rain_probability.colors),
    'ptype_frzr_probability': new apgl.ColorMap(ptype_frzr_probability.levels, ptype_frzr_probability.colors),
    'ptype_icep_probability': new apgl.ColorMap(ptype_icep_probability.levels, ptype_icep_probability.colors),

    // Precipitation type reflectivity colormaps
    'ptype_snow_reflectivity': new apgl.ColorMap(ptype_snow_reflectivity.levels, ptype_snow_reflectivity.colors, {overflow_color: ptype_snow_reflectivity.overflow_color}),
    'ptype_rain_reflectivity': new apgl.ColorMap(ptype_rain_reflectivity.levels, ptype_rain_reflectivity.colors, {overflow_color: ptype_rain_reflectivity.overflow_color}),
    'ptype_frzr_reflectivity': new apgl.ColorMap(ptype_frzr_reflectivity.levels, ptype_frzr_reflectivity.colors, {overflow_color: ptype_frzr_reflectivity.overflow_color}),
    'ptype_icep_reflectivity': new apgl.ColorMap(ptype_icep_reflectivity.levels, ptype_icep_reflectivity.colors, {overflow_color: ptype_icep_reflectivity.overflow_color}),
};

export default COLORMAPS;
