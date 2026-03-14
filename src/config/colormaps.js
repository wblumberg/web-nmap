// Named colormap registry — analogous to NMAP2's colormap table files.
// Colormaps from autumnplot-gl's built-in library are referenced by name;
// custom ones are defined here.

const COLORMAPS = {

    // --- Built-in autumnplot-gl colormaps ---
    'pw_speed500mb': apgl.colormaps.pw_speed500mb,
    'pw_speed850mb': apgl.colormaps.pw_speed850mb,
    'pw_cape':       apgl.colormaps.pw_cape,
    'pw_t2m':        apgl.colormaps.pw_t2m,
    'pw_td2m':       apgl.colormaps.pw_td2m,

    // --- Custom colormaps (defined here) ---
    // MRMS Rain Reflectivity colormap
    'mrms_cref_rain': new apgl.ColorMap(
        [10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50],
        ['#bce8be','#a6d3a8','#93c393','#7fb482','#68a06a','#568e56','#48894d',
         '#3b8043','#2b7a39','#1f7331','#116c28','#f3ef6f','#f7dd65','#f6c55b',
         '#f5b24f','#fb9e45'],
        { overflow_color: '#f88a3f' }
    ),

    // MRMS Snow Reflectivity colormap
    'mrms_cref_snow': new apgl.ColorMap(
        [5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50],
        ['#bfdeed','#a6cfe6','#92c0db','#7ab0d0','#66a5c9','#5196be','#4089b3',
         '#347da4','#2a7296','#1e6586','#125877','#074b67','#703579','#b23890',
         '#c051a2','#c970b2','#d18dbe','#e4add6'],
        { overflow_color: '#eec9e5' }
    ),

    // MRMS Freezing Rain Reflectivity colormap
    'mrms_cref_cfrzr': new apgl.ColorMap(
        [5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50],
        ['#eac6d6', '#edb6be', '#e8a5a8', '#ea9492', '#ec897a', '#e87664', '#eb684d',
         '#ee5736', '#ea4721', '#df4427', '#d3422c', '#bf3e32', '#b53c33', '#a63835',
         '#94393a', '#88353d'],
        { overflow_color: '#793042' }
    ),

    // MRMS Ice Pellets Reflectivity colormap
    'mrms_cref_cicep': new apgl.ColorMap(
        [5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40, 42.5, 45, 47.5, 50],
        ['#e1c9ed', '#d4b4e3', '#cda2de', '#c58fda', '#b97ad1', '#b368cf', '#ab54c9', '#a042bf', '#9631b8', '#8f2caa',
         '#832898', '#792687', '#702475', '#652162', '#5d2051', '#53203e'],
        { overflow_color: '#471b2c' }
    ),

    // Grayscale colormap for visible satellite imagery (not tested)
    'vis_greyscale': new apgl.ColorMap(
        [0.00, 0.06, 0.12, 0.18, 0.24, 0.30, 0.36, 0.42, 0.48, 0.54, 0.60, 0.66, 0.72, 0.78, 0.84, 0.90, 0.96],
        ['#000000', '#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777',
         '#888888', '#999999', '#aaaaaa', '#bbbbbb', '#cccccc', '#dddddd', '#eeeeee', '#f8f8f8'],
        { overflow_color: '#ffffff' }
    ),

    
    // ... add more as needed
};

export default COLORMAPS;