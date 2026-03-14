======================= WEB NMAP DIRECTORY LAYOUT ==================================

web-nmap/
├── public/
│   ├── index.html
│   ├── main.js               ← thin: map init + UI wiring only
│   └── data/                 ← served data files
│       ├── gfs.2025030200.zarr/
│       ├── hrrr.2025030200.zarr/
│       ├── mrms.202503021800.zarr/
│       └── surface_20250302_1800.json.gz
│
├── src/
│   ├── index.js              ← webpack entry point
│   │
│   ├── config/               ← LAYER 1: Configuration (replaces NMAP2 tables)
│   │   ├── datasources.js    ← datatype.tbl
│   │   ├── colormaps.js      ← colormap table files
│   │   ├── stationmodels.js  ← prmlst.tbl
│   │   └── views.js          ← mod_res.tbl grouping + view registry
│   │
│   ├── products/             ← LAYER 1: Product definitions (replaces restore files)
│   │   ├── index.js          ← barrel: merges all groups → PRODUCT_SUITES
│   │   ├── basic.js          ← temperature, dewpoint, heights, winds
│   │   ├── instability.js    ← CAPE, CIN, Lapse Rates
│   │   ├── moisture.js       ← PWat, RH, mixing ratio, Dewpoint
│   │   ├── shear.js          ← bulk shear, SRH, storm-relative winds, storm motions
│   │   ├── lift.js           ← Frontogenesis, QG Diagnostics, Convergence
│   │   ├── precipitation.js  ← QPF, snow, PTYPE, precip type
│   │   ├── composite.js      ← STP, SCP, SHIP, HREF paintball, SPC composite fields
│   │   ├── raster.js         ← MRMS, satellite
│   │   ├── advisories.js     ← watches, warnings, advisories, discussions
│   │   └── point.js          ← surface obs, LSR, air quality, VADs, station models
│   │
│   ├── DataLoader.js         ← LAYER 2: zarr / compressed JSON / legacy binary fetch
│   ├── LayerBuilder.js       ← LAYER 2: (optional) shared layer construction helpers
│   └── ViewManager.js        ← LAYER 2: active layers, time stepping, MultiPlotLayer
│
├── package.json
├── webpack.config.js
└── tsconfig.json

====================== DATA STORE DIRECTORIES AND FILENAMES ========================

/data/
└── /store/
    ├── /grid/
    │   ├── ecens/
    │   │   └── ecens_YYYYMMDD.CC.fFFF.zarr
    │   ├── ecmwf_hr/
    │   │   └── ecmwfhr_YYYYMMDD.CC.fFFF.zarr
    │   ├── gefs/
    │   │   └── gefs_YYYYMMDD.CC.fFFF.zarr
    │   ├── gfs/
    │   │   └── gfs_YYYYMMDD.CC.fFFF.zarr
    │   ├── meso/
    │   │   └── mesoanalysis_YYYYMMDD.HH.zarr
    │   ├── mrms/
    │   │   └── mrms_YYYYMMDD.HHMMSS.zarr
    │   ├── rrfs/
    │   │   └── rrfs_YYYYMMDD.CC.fFFF.zarr
    │   ├── refs/
    │   │   └── refs_YYYYMMDD.CC.fFFF.zarr
    │   ├── href/
    │   │   └── href_YYYYMMDD.CC.fFFF.zarr
    │   └── satellite/
    │       ├── GOES-E_CONUS_YYYYMMDD.HHMMSS.zarr
    │       └── GOES-W_CONUS_YYYYMMDD.HHMMSS.zarr
    ├── /point/
    │   ├── acft/
    │   │   └── acft_YYYYMMDD.HH.json
    │   ├── airq/
    │   │   └── airq_YYYYMMDD.HHMMSS.json
    │   ├── lsr/
    │   │   └── lsr_YYYYMMDD.HHMMSS.json
    │   ├── ltng
    │   ├── recon/
    │   │   └── recon_YYYYMMDD.HHMMSS.json
    │   ├── sfc/
    │   │   └── sfc_YYYYMMDD.HH.json
    │   ├── ship/
    │   │   └── ship_YYYYMMDD.HH.json
    │   ├── synoptic/
    │   │   └── synoptic_YYYYMMDD.HHMM.json
    │   ├── upperair/
    │   │   └── upperair_YYYYMMDD.HH.json
    │   └── vad/
    │       └── NEXRAD.VWP.summary.YYYYMMDD.HHMMSS.nc
    ├── /feature/
    │   ├── warn
    │   ├── wtch
    │   └── wstm
    └── /contour/
        ├── ecens/
        ├── gefs/
        └── refs/