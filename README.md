# web-nmap

A web-based NMAP2-style meteorological display application built on top of [autumnplot-gl](https://github.com/tsupinie/autumnplot-gl) and [MapLibre GL JS](https://maplibre.org/), inspired by the NMAP2 program from NAWIPS/GEMPAK.

## Features

- Single-panel, full-screen map viewer with a dark operational meteorological workstation UI
- Multiple meteorological data views selectable from a dropdown:
  - **Synthetic 500mb** — synthetic 500mb height contours, wind speed fill, and wind barbs (no data files needed)
  - **GFS T2m** — GFS 2m temperature filled contours + 32°F contour line
  - **HREF** — HREF paintball + neighborhood probability contours
  - **MRMS Composite Reflectivity** — MRMS raster with precip-type colormaps
  - **Surface Observations** — station plots with temperature, dewpoint, wind barbs, sky cover, and present weather
- Colorbar panel, lat/lon + data readout

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- A local map tile server serving a MapLibre-compatible `style.json` on port **8080** (e.g., [Martin](https://martin.maplibre.org/) or [tileserver-gl](https://github.com/maptiler/tileserver-gl))

## Setup

```bash
npm install
```

## Running

```bash
npm start
```

Then open [http://localhost:9000](http://localhost:9000) in your browser.

> **Note:** The map requires a local tile server serving `style.json` at `http://localhost:8080/style.json`. The **Synthetic 500mb** view works with no data files. For all other views, supply the appropriate binary data files in `public/data/`:
>
> | View | Files |
> |------|-------|
> | GFS T2m | `public/data/gfs.bin.gz` |
> | HREF | `public/data/hrefv3.2023051100.f036.mxuphl5000_2000m.nh_max.086400_p99.85_0040km.bin.gz`<br>`public/data/hrefv3.2023051100.f036.mxuphl5000_2000m.086400.pb75.bin.gz` |
> | MRMS | `public/data/mrms.202112152259.cref.bin.gz`<br>`public/data/hrrr.2021121522.ptype.bin.gz` |
> | Surface Obs | `public/data/surface_20240823_1500.json` |

## Building for Production

```bash
npm run build
```

The bundle will be written to `dist/web-nmap.js`.
