// Named colormap registry — analogous to NMAP2's colormap table files.
// Colormaps from autumnplot-gl's built-in library are referenced by name;
// custom ones are defined here.

import * as apgl from "autumnplot-gl";

const COLORMAPS = {

    // --- Built-in autumnplot-gl colormaps ---
    'pw_speed500mb': apgl.colormaps.pw_speed500mb,
    'pw_speed850mb': apgl.colormaps.pw_speed850mb,
    'pw_cape':       apgl.colormaps.pw_cape,
    'pw_t2m':        apgl.colormaps.pw_t2m,
    'pw_td2m':       apgl.colormaps.pw_td2m,
    'wv_cimms':      apgl.colormaps.wv_cimss,
};

export default COLORMAPS;