┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: CONFIGURATION  (replaces NMAP2 text tables)           │
│                                                                 │
│  src/config/                                                    │
│    datasources.js      ← datatype.tbl                           │
│    colormaps.js        ← colormap table files                   │
│    stationmodels.js    ← prmlst.tbl                             │
│    views.js            ← mod_res.tbl (grouping + availability)  │
│                                                                 │
│  src/products/         ← restore files (one file per group)     │
│    index.js            (barrel export)                          │
│    basic.js            (temperature, heights, dewpoint, etc.)   │
│    instability.js      (CAPE, LI, STP, SCP, etc.)               │
│    moisture.js         (PWat, RH, mixing ratio, etc.)           │
│    shear.js            (0-6km, 0-1km, SRH, etc.)                │
│    precipitation.js    (QPF, snow, PTYPE, etc.)                 │
│    composite.js        (SPC HREF composites, etc.)              │
│    raster.js           (MRMS, satellite)                        │
│    point.js            (surface obs, soundings, etc.)           │
└─────────────────────┬───────────────────────────────────────────┘
                      │ drives
┌─────────────────────▼───────────────────────────────────────────┐
│  LAYER 2: RUNTIME ENGINE  (translates config → APGL objects)    │
│                                                                 │
│  src/                                                           │
│    DataLoader.js       (fetch + decode zarr / compressed JSON)  │
│    LayerBuilder.js     (product config → PlotLayer objects)     │
│    ViewManager.js      (active layers, time stepping)           │
└─────────────────────┬───────────────────────────────────────────┘
                      │ renders
┌─────────────────────▼───────────────────────────────────────────┐
│  LAYER 3: UI                                                    │
│                                                                 │
│  public/                                                        │
│    main.js             (map init + UI event wiring only)        │
│    index.html                                                   │
└─────────────────────────────────────────────────────────────────┘
