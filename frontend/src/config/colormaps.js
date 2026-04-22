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

const COLORMAPS = {

    // --- Built-in autumnplot-gl colormaps ---
    'pw_speed500mb': apgl.colormaps.pw_speed500mb,
    'pw_speed850mb': apgl.colormaps.pw_speed850mb,
    'pw_cape':       apgl.colormaps.pw_cape,
    'pw_t2m':        apgl.colormaps.pw_t2m,
    'pw_td2m':       apgl.colormaps.pw_td2m,
    'wv_cimms':      apgl.colormaps.wv_cimss,
    'nws_reflectivity':   apgl.colormaps.nws_storm_clear_refl,

    // --- Custom colormaps ---
    'href_dwpt':  new apgl.ColorMap(href_dwpt_data.levels,  href_dwpt_data.colors),
    //'href_maxuh': new apgl.ColorMap(href_maxuh_data.levels, href_maxuh_data.colors),
    //'href_minuh': new apgl.ColorMap(href_minuh_data.levels, href_minuh_data.colors),
    'href_qpf':   new apgl.ColorMap(href_qpf_data.levels,   href_qpf_data.colors),
    'href_rh':    new apgl.ColorMap(href_rh_data.levels,    href_rh_data.colors),
    'pw_qpf':     new apgl.ColorMap(pw_qpf_data.levels,     pw_qpf_data.colors),
    'pw_refl':    new apgl.ColorMap(pw_refl_data.levels,    pw_refl_data.colors),
    'pw_snow':    new apgl.ColorMap(pw_snow_data.levels,    pw_snow_data.colors),
    'pw_uh':      new apgl.ColorMap(pw_uh_data.levels,      pw_uh_data.colors),

    'blues_prob': new apgl.ColorMap(blues_probabilty_data.levels, blues_probabilty_data.colors, {underflow_color: blues_probabilty_data.colors[0], overflow_color: blues_probabilty_data.colors[blues_probabilty_data.colors.length - 1]}),
    'red_purple_prob': new apgl.ColorMap(red_purple_probabilty_data.levels, red_purple_probabilty_data.colors, {underflow_color: red_purple_probabilty_data.underflow_color}),
    'bgy_prob': new apgl.ColorMap(bgy_probability_data.levels, bgy_probability_data.colors, {underflow_color: bgy_probability_data.underflow_color}),
    'yrp_prob': new apgl.ColorMap(yrp_probability_data.levels, yrp_probability_data.colors, {underflow_color: yrp_probability_data.underflow_color}),
    
    'wv_tpc':     new apgl.ColorMap( wv_tpc_data.levels,  wv_tpc_data.colors)
};

export default COLORMAPS;