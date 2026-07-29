Yes — there *is* a workable pattern for this even if you **don’t have direct access to the `maplibre-gl` map instance**, only the `apgl` API from autumnplot-gl.

The key is understanding how the library is structured.

---

# How Autumnplot-GL Actually Works

`autumnplot-gl` is essentially a **WebGL plotting layer that gets attached to a MapLibre map**. It creates plotting layers (e.g. `MultiPlotLayer`) that MapLibre renders alongside its other layers. ([Socket][1])

Typical flow:

```
MapLibre map
   ↓
apgl plotting layer
   ↓
WebGL shaders render meteorological grids
```

Example pattern (simplified):

```javascript
const data_layer = new apgl.MultiPlotLayer('data');
```

Then fields/plots are attached to that layer.

---

# The Core Limitation You’re Facing

You **can’t call** things like:

```js
map.addSource()
map.addLayer()
map.addControl()
```

because the map object is hidden.

So the only realistic way to add geometry is to:

### 1️⃣ Render it **inside an apgl layer**

or

### 2️⃣ Create a **fake data grid** that encodes the geometry

Option 1 is much cleaner.

---

# Best Approach: Custom Plot Layer (Recommended)

You can piggyback on the same mechanism `MultiPlotLayer` uses.

Idea:

Create a **custom geometry renderer** that behaves like a plot.

### Concept

```
apgl.MultiPlotLayer
   ├─ weather grid plot
   ├─ contour plot
   └─ geometry plot (your new feature)
```

Your geometry plot would draw:

* points
* lines
* polygons

using WebGL buffers.

---

## Example Concept

```javascript
class GeometryPlot {
  constructor(features) {
    this.features = features; // GeoJSON
  }

  render(gl, mapProjection) {

     for (const feature of this.features) {

        const coords = feature.geometry.coordinates;

        const projected = coords.map(c =>
           mapProjection.project(c[0], c[1])
        );

        drawLine(gl, projected);
     }
  }
}
```

Then attach it:

```javascript
const geomPlot = new GeometryPlot(myGeoJSON);
data_layer.addPlot(geomPlot);
```

---

# Alternative: Encode Geometry Into a Grid

This is hacky but sometimes works.

Example:

* create a grid
* mark cells intersecting your geometry
* use a colormap

Example:

```
0 = transparent
1 = geometry
```

Then render it as a normal apgl field.

This works for:

* county boundaries
* masks
* forecast zones

But not ideal for crisp vector shapes.

---

# Another Trick (if the framework allows callbacks)

Some implementations expose the map through events:

```javascript
data_layer.onAdd = function(map) {
   window._map = map;
}
```

If that works, you suddenly gain full access to MapLibre and can add:

```
geojson source
line layer
fill layer
symbol layer
```

MapLibre supports native geometry layers like this. ([GitHub][2])

---

# A Practical Architecture I’d Implement

Create a wrapper layer:

```
GeometryOverlayLayer
```

Structure:

```
GeometryOverlayLayer
   ├─ addPoint()
   ├─ addLine()
   ├─ addPolygon()
   └─ render()
```

Attach to `MultiPlotLayer`.

Then users can do:

```javascript
geomLayer.addPolygon(countyPolygon);
geomLayer.addLine(frontBoundary);
geomLayer.addPoint(stationLocation);
```

---

# Why This Works Well

Advantages:

✔ uses same WebGL context
✔ syncs with map zoom/pan automatically
✔ avoids needing MapLibre access
✔ keeps everything inside apgl

---

# If I Were Designing This Cleanly

I'd implement:

```
apgl.VectorPlotLayer
```

Features:

```
GeoJSON input
style options
GPU rendering
```

Very similar to:

* deck.gl layers
* MapLibre custom layers

---

# If You Want, I Can Also Show

I can walk you through **a concrete implementation** of:

* `GeometryPlot.js`
* WebGL line rendering
* converting **lat/lon → map projection coordinates**
* plugging it into `MultiPlotLayer`

(about ~120 lines of code)

If you want, paste the **Autumnplot-GL script you’re using**, because there are **two different integration patterns** used in the wild and the solution depends on which one you have.

[1]: https://socket.dev/npm/package/autumnplot-gl/overview/2.1.0?utm_source=chatgpt.com "autumnplot-gl - npm Package Security Analysis - Socket"
[2]: https://github.com/maplibre/maplibre-gl-js?utm_source=chatgpt.com "GitHub - maplibre/maplibre-gl-js: MapLibre GL JS - Interactive vector tile maps in the browser"

