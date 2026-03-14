**Context:**

We are building `web-nmap`, a web-based replacement for NMAP2 (part of the GEMPAK/NAWIPS system), using the [`autumnplot-gl`](https://github.com/tsupinie/autumnplot-gl) library (TypeScript, WebGL/MapLibre GL JS) for hardware-accelerated geospatial rendering. The application needs to support interactive meteorological **product generation** — the ability to create, edit, save, and render multiple classes of map overlays, similar to how NMAP2 lets users create probabilistic outlook products (like SPC's tornado/hail/wind outlooks), fronts, pressure system labels, and general drawing/annotation.

---

### 1. Probabilistic Contour Products (SPC-style)

**Goal:** Allow users to create and edit filled probabilistic contour products (e.g., SPC Day 1 Tornado Outlook: 2%, 5%, 10%, 15%, 30%, 45%, 60%).

**autumnplot-gl hooks:**
- `ContourFill` + `ColorMap` with discrete color steps maps directly to probabilistic fill categories.
- `Contour` + `ContourLabels` for the outline contours and percentage labels.
- `cmap_mask` on `ContourFill` supports multiple colormaps for different probability regions.

**Implementation ideas:**
```typescript
// Use discrete ColorMap levels for SPC tornado probability bins
const spc_tornado_cmap = new ColorMap(
  [0.02, 0.05, 0.10, 0.15, 0.30, 0.45, 0.60],
  ['#006400', '#8B4513', '#FFA500', '#FF0000', '#FF00FF', '#FF69B4', '#C0C0C0'],
  { overflow_color: '#C0C0C0', underflow_color: 'transparent' }
);
const prob_field = new RawScalarField(grid, probabilityData);
const prob_fill = new ContourFill(prob_field, { cmap: spc_tornado_cmap, opacity: 0.6 });
const prob_contours = new Contour(prob_field, { levels: [0.02, 0.05, 0.10, 0.15, 0.30, 0.45, 0.60], color: '#000' });
const prob_labels = new ContourLabels(prob_contours, { text_color: '#fff', halo: true });
```

**Interactive editing:** Use MapLibre's `draw` plugin (e.g., `maplibre-gl-draw`) or a custom canvas overlay to allow users to:
- Click to place probability contour vertices.
- Drag to reshape contours.
- Select a probability level from a palette (like NMAP2's product selector).
- Store contours as GeoJSON polygons with associated probability metadata.
- Rasterize user-drawn polygons back onto a `RawScalarField` grid to feed back into `ContourFill`.

---

### 2. Product Class System (NMAP2 "Special Graphics" Equivalent)

**Goal:** Create a modular `ProductLayer` class system that wraps autumnplot-gl's `PlotLayer`/`PlotComponent` and adds product metadata (type, name, editable state, visibility).

**Design:**
```typescript
interface ProductDefinition {   
  id: string;
  name: string;
  type: 'probabilistic_contour' | 'front' | 'pressure_symbol' | 'text_annotation' | 'symbol' | 'polyline' | 'circle';
  visible: boolean;
  locked: boolean;
  data: GeoJSON.FeatureCollection | RawScalarField<any, any>;
  renderConfig: ProbContourConfig | FrontConfig | SymbolConfig | TextConfig;
}
```

Build a `ProductManager` class that:
- Maintains a stack of `ProductDefinition` objects.
- Serializes/deserializes to JSON for save/load.
- Renders each product as an autumnplot-gl `PlotLayer`.
- Supports a layer panel (like NMAP2's product list) with drag-to-reorder and per-layer toggles.

---

### 3. Fronts Drawing Tool

**Goal:** Draw cold fronts, warm fronts, stationary fronts, and dry lines on the map with proper meteorological symbology (pips/spikes on the correct side, colored lines).

**autumnplot-gl hooks:**
- `PolylineCollection` (internal) handles GPU-accelerated polyline rendering.
- For front symbology (triangles/semicircles), extend `PlotComponent` with a custom WebGL shader or use SVG overlay.

**Implementation ideas:**
- Build a `FrontLayer extends PlotComponent` that accepts a GeoJSON `LineString` + front type.
- Render the base line via `PolylineCollection`.
- Generate symbol geometry (evenly spaced triangles/semicircles) along the line mathematically and render as a `BillboardCollection` or instanced geometry.
- Front types: `'cold'`, `'warm'`, `'stationary'`, `'occluded'`, `'dryline'`, `'trough'`.

---

### 4.  High/Low Pressure Symbols

**Goal:** Place `H`/`L` labels with associated pressure values at user-specified locations on the map.

**autumnplot-gl hooks:**
- `StationPlot` already supports positioned text and symbols via `SPStringConfig` and `SPSymbolConfig`.
- Alternatively, use `TextCollection` (internal) directly.

**Implementation ideas:**
```typescript
// Reuse StationPlot for H/L labels
// OR build a dedicated HighLowLayer:
interface PressureCenter {
  lat: number;
  lon: number;
  type: 'H' | 'L';
  value?: number; // pressure in mb
  color?: string;
}
// Render as TextCollection or extend StationPlot with custom SPStringConfig
```

- Interactive: Click on map → popup to choose H or L, enter pressure value → renders symbol.
- Use colored text: `H` in blue, `L` in red (standard convention).

---

### 5. Free-Form Text Annotation

**Goal:** Place arbitrary text labels on the map (e.g., city names, forecast discussion text, event labels).

**autumnplot-gl hooks:**
- `TextCollection` + `ContourLabels` pattern.
- Can build a `TextAnnotationLayer extends PlotComponent` backed by a list of `{lat, lon, text, color, font_size}`.

**Implementation:** Expose a UI panel where users can:
- Click on the map to place text.
- Type text in a popup.
- Choose color, font size, halo on/off.
- Move/delete existing annotations via a selection tool.

---

### 6. General Drawing Tools (Polylines, Circles, Markers)

**Goal:** Allow freehand or point-to-point drawing of lines, circles, and point markers.

**Implementation approaches:**
- **Polylines:** GeoJSON `LineString` rendered via `PolylineCollection` (already in autumnplot-gl). User clicks to add vertices; double-click to close.
- **Circles:** GeoJSON `Polygon` approximated as N-gon (or use MapLibre's circle layer for simple cases). Parameterize by center + radius in km.
- **Markers:** Custom SVG icons or `BillboardCollection` (internal autumnplot-gl) for point features. Support NMAP2 marker symbol set (WX symbols already in `StationPlot`).
- Use a **drawing mode state machine**: `IDLE → PLACING → EDITING → LOCKED`.

---

### 7. Product Editor UI (NMAP2 Product Builder Panel)

**Goal:** A sidebar/panel UI that mimics NMAP2's product generation workflow.

**Components to build:**
- **Product Palette:** Dropdown or grid of product types (tornado outlook, hail outlook, wind outlook, fronts, custom).
- **Layer Stack:** Ordered list of active product layers with visibility toggles, lock, delete, and reorder.
- **Property Panel:** Context-sensitive panel showing editable properties for the selected product (e.g., for probabilistic contours: probability levels, colors, opacity).
- **Draw Toolbar:** Pencil/polygon/line/circle/text/marker buttons that activate drawing modes.
- **Undo/Redo Stack:** Array of `ProductDefinition[]` snapshots, accessible via `Ctrl+Z`/`Ctrl+Y`.
- **Export:** Export current product set as GeoJSON, PNG (canvas capture), or a custom JSON format.

---

### 8.  Probabilistic Field Generation from Drawn Polygons

**Goal:** Take user-drawn GeoJSON polygons with associated probability values and rasterize them onto a grid to drive `ContourFill`.

**Implementation:**
```typescript
function rasterizePolygonsToGrid(
  polygons: { geometry: GeoJSON.Polygon; probability: number }[],
  grid: PlateCarreeGrid  // or LambertGrid
): Float32Array {
  // For each grid point, find the maximum probability from all overlapping polygons
  // Use point-in-polygon test (e.g., @turf/boolean-point-in-polygon)
  // Return Float32Array matching grid dimensions
}
```

Libraries to use:
- [`@turf/turf`](https://turfjs.org/) for point-in-polygon, line offsets, buffer zones.
- [`d3-contour`](https://github.com/d3/d3-contour) as an alternative client-side contouring engine if needed.

---

### 9. Product Template System

**Goal:** Pre-built templates for common NWS/SPC products that users can instantiate and modify.

**Templates to include:**
- SPC Day 1 Tornado Outlook (2/5/10/15/30/45/60%)
- SPC Day 1 Hail Outlook (5/15/30/45/60%)
- SPC Day 1 Wind Outlook (5/15/30/45/60%)
- SPC Day 1 Categorical (TSTM/MRGL/SLGT/ENH/MDT/HIGH)
- WPC Frontal Analysis (cold/warm/stationary/occluded fronts + H/L labels)
- Generic QPF contour product
- Generic temperature/dewpoint/wind analysis

---

### 10.  Integration Architecture

**Recommended file structure additions for web-nmap:**

```
src/
  products/
    ProductManager.ts          # Product stack, serialization
    ProductLayer.ts            # Wrapper around PlotLayer with metadata
    types.ts                   # ProductDefinition, FrontConfig, etc.
  tools/
    DrawTool.ts                # Drawing mode state machine
    PolygonTool.ts             # Probabilistic contour drawing
    FrontTool.ts               # Front drawing
    TextTool.ts                # Text annotation placement
    HighLowTool.ts             # H/L pressure placement
  renderers/
    FrontRenderer.ts           # PlotComponent for fronts
    ProbabilisticRenderer.ts   # ContourFill wrapper for prob products
    AnnotationRenderer.ts      # TextCollection wrapper
    SymbolRenderer.ts          # Marker/symbol renderer
  ui/
    ProductPanel.tsx           # Sidebar layer stack UI (React/Svelte/Vue)
    DrawToolbar.tsx            # Icon toolbar
    PropertyEditor.tsx         # Context-sensitive property editor
  utils/
    rasterize.ts               # Polygon-to-grid rasterization
    geojsonHelpers.ts          # GeoJSON utilities
```

---

### Key Libraries to Add

| Library | Purpose |
|---|---|
| `@turf/turf` | Geospatial math (point-in-polygon, buffering, area) |
| `maplibre-gl-draw` | Interactive polygon/line drawing on MapLibre map |
| `d3-contour` | Client-side contour generation from rasterized grids |
| `immer` | Immutable state for undo/redo stack |
| `react` or `svelte` | UI framework for panels and toolbars |

---

This gives your AI coding partner a full, actionable blueprint. The key insight is that **autumnplot-gl already gives you the rendering primitives** — `ContourFill`, `Contour`, `ContourLabels`, `StationPlot`, `Barbs`, `PolylineCollection`, `TextCollection`, `BillboardCollection` — and what `web-nmap` needs to build on top is:
1. A **product data model** (GeoJSON + metadata)
2. A **drawing/editing UI layer**
3. A **rasterization bridge** from drawn shapes → scalar fields → autumnplot-gl renderers
4. A **product management/serialization system**
