MVC is a good fit for your app, but you’ll be happiest if you interpret it as:

- **Backend = “Model + Controller”** (domain + API endpoints)
- **Frontend = “View + Controller”** (UI + state orchestration)
- and you add a small “**Service**” layer on both sides to keep controllers thin.

Below is a concrete folder structure for `backend/api/` and `frontend/src/` that maps directly to your flow (catalog → data selection → timeline → load map → timematch → fetch data).

---

## Backend (`backend/api/`): Model + Controller (+ Services)
Your backend already uses FastAPI routers; treat each router as a **Controller** and keep it thin. Put your “real logic” in services and your data representations in models/schemas.

### Suggested backend tree

```
backend/api/
  main.py                       # FastAPI app wiring, middleware, static mount
  routers/                      # Controllers (HTTP layer)
    catalog.py
    sources.py                  # or keep per-domain like gridded.py, lightning.py, etc.
    timematch.py
    gridded.py
    points.py
    observations.py
    events.py
    geometries.py
    health.py

  schemas/                      # Pydantic response/request models (API contracts)
    catalog.py                  # DataCategory, DataSource, ProductGroup, Product...
    times.py                    # TimeKey, CycleTime, ValidTime...
    timematch.py                # TimematchRequest/Response
    data.py                     # GridResponse, PointsResponse, GeoJSONFeature...

  services/                     # Domain logic (your “application layer”)
    catalog_service.py          # build catalog (categories->sources->products)
    times_service.py            # list available times, cycles, valids
    timematch_service.py        # core matching algorithm
    data_service.py             # fetch/assemble data for layers
    watcher_service.py          # file watching -> events/notifications

  domain/                       # Pure domain objects (no FastAPI)
    datasource.py               # DataSource definition, metadata, type
    product.py                  # Product definitions
    timekey.py                  # time parsing/format rules, dt conversions

  sources/                      # Data access layer (“Model” in the DB sense)
    registry.py                 # get_source("RAP"), get_source("MRMS")
    rap.py
    mrms.py
    lightning.py
    obs.py
    ...                         # each knows how to list times + load data from disk

  readers/                      # Low-level file readers/parsers
    netcdf_reader.py
    grib_reader.py
    acad_ltng_reader.py
    ...

  utils/
    time.py                     # _parse_key_to_dt etc (move private funcs here)
    caching.py
```

### Mapping to MVC terms (backend)
- **Model:** `sources/`, `readers/`, `domain/`
- **Controller:** `routers/`
- **“View”:** JSON responses (defined by `schemas/`)

### Keep controllers thin
Example pattern:

- `routers/catalog.py` just validates query params and calls `CatalogService`
- `CatalogService` calls `sources.registry.get_source(...)` and assembles a `CatalogResponse` schema

This avoids “router files become 1000 lines” syndrome.

---

## Frontend (`frontend/src/`): View + Controller (+ Services)
On the frontend, MVC becomes:

- **View:** UI components (DOM, panels, dialogs)
- **Controller:** state machine / event handlers (user actions + async API orchestration)
- **Model:** app state + domain entities + API client

### Suggested frontend tree

```
frontend/src/
  main.js                      # entry: boot app, init controllers, mount UI
  app/
    bootstrap.js               # wires controllers + store + event bus
    routes.js                  # optional (if you add client-side routing)

  controllers/                 # “Controller” in MVC (orchestrate flows)
    appController.js           # startup: load catalog; global events
    dataSelectorController.js  # load data window interactions
    timelineController.js      # timeline population + selection
    mapController.js           # layer creation/removal + map rendering orchestration
    loadMapController.js       # kicks off timematch + batch fetch + async layer processing

  views/                       # “View” (DOM/UI)
    layout/
      topbarView.js
      mapView.js
    dialogs/
      loadDataDialogView.js
    components/
      dataCategoryListView.js
      dataSourceListView.js
      productTreeView.js
      cycleTimePickerView.js
      timelineView.js
      progressView.js

  models/                      # “Model” in MVC (client-side state + domain)
    store.js                   # centralized state (or small stores per feature)
    entities/
      catalog.js               # DataCategory, DataSource, Product definitions
      selection.js             # Selected layers, dominant source, cycle, etc.
      time.js                  # TimeKey, parse/format utilities

  services/                    # API + computation helpers
    api/
      client.js                # fetch wrapper + baseUrl + error handling
      catalogApi.js            # getCatalog(), listSources(), listProducts()
      timesApi.js              # listTimes(), listCycles(), listValids()
      timematchApi.js          # postTimeMatch(...)
      dataApi.js               # fetchGrid(...), fetchPoints(...), fetchGeoJSON(...)
    layerBuilders/
      mrmsLayerBuilder.js
      rapLayerBuilder.js
      lightningLayerBuilder.js
      obsLayerBuilder.js
    timeMatching/
      clientSideMatch.js       # optional fallback

  lib/
    eventBus.js                # pub/sub for UI events (simple)
    asyncQueue.js              # concurrency limiting for many requests
    logging.js

  config/
    constants.js               # API prefixes, default dominant source, etc.
```

This structure makes it easy to answer: “Where does X live?”

- UI markup/DOM: `views/`
- app logic: `controllers/`
- state: `models/`
- API calls + data transforms: `services/`

---

## How your flow maps into controllers/services (concrete)

### 1) App load → ask API “what data sources do you have?”
Backend endpoint (Controller): `GET /api/v1/catalog`
- Response schema: categories → sources → product groups → products

Backend implementation:
- `routers/catalog.py` → `CatalogService.get_catalog()`

Frontend:
- `appController.init()` calls `catalogApi.getCatalog()`
- stores result in `store.catalog`
- `dataSelectorController` uses this to populate “Load Data” window

### 2) Open “Load Data” window → categories → sources → products
Frontend:
- `loadDataDialogView.show()`
- `dataSelectorController.onOpen()` reads catalog from store
- View renders categories
- When user clicks category: controller updates store.selectedCategory and re-renders sources
- When user selects a source: controller shows product groups/products

Backend:
- Ideally no extra calls here if your catalog response already contains the hierarchy.
- If too heavy, split into:
  - `GET /catalog/categories`
  - `GET /catalog/sources?category=...`
  - `GET /catalog/products?source=...`

### 3) Forecast cycle times (RAP cycles)
Backend:
- `GET /api/v1/gridded/rap/cycles` (or `/api/v1/times/cycles?source=RAP`)
Frontend:
- `timesApi.listCycles({sourceId})`
- controller updates store.availableCycles and view updates the cycle picker

### 4) Dominant product selected → populate timeline
Backend:
- `GET /api/v1/times?source=...&product=...&cycle=...`
  - for obs/analysis: “available times”
  - for forecast: “valid times for cycle”
Frontend:
- `timelineController.loadTimesForDominantSelection()`
- view shows timeline, store stores `availableTimes`

### 5) Load Map → timematch → fetch all data → render layers async
Backend:
- `POST /api/v1/timematch`
  - body: dominant source/product + other selected layers + window/strategy
  - response: matched time pairs/groups
- `POST /api/v1/data/batch` (recommended)
  - request: list of “layer requests” (source, product, time, bbox, level, etc.)
  - response: either URLs to fetch or data blobs (depending on size)

Frontend:
- `loadMapController.loadMap()`
  1. calls `timematchApi.match(...)`
  2. builds a queue of layer fetch jobs from returned matched times
  3. uses `asyncQueue` to fetch/process concurrently (limit concurrency to avoid freezing)
  4. each job calls a specific `layerBuilder` to create APGL layers
  5. `mapController` attaches layers to the map and updates progress UI

This is exactly where you avoid your earlier “JSONResponse takes forever” problem: don’t fetch huge GeoJSON for long windows in one go; batch, paginate, compress, and/or return URLs.

---

## API design suggestion that fits MVC well
Even if you keep your existing routes, consider these “controller” style endpoints:

- `GET /api/v1/catalog` → all categories/sources/products metadata
- `GET /api/v1/times/cycles?source=RAP` → cycle list
- `GET /api/v1/times/available?...` → time list for a product
- `POST /api/v1/timematch` → matched timeline across layers
- `POST /api/v1/data/requests` → returns either:
  - signed URLs / file URLs (best for large data), or
  - compact binary payloads, or
  - paginated GeoJSON

---

## One key architectural choice (so you don’t fight MVC)
For your frontend, decide early whether you want:

- **One central store** (simple global state + events), or
- “state per controller”

For your app, a central store works well because many things depend on shared selection:
- selected category/source/product
- dominant layer
- available times
- matched times
- loaded layers

You don’t need React/Vue for this; a plain JS store + event bus is enough.

---

### If you want, I can tailor this to your repo
If you paste:
1) your current `frontend/src/` file list, and
2) your current `backend/api/routers/` file list,

…I can propose an exact “move plan” (current path → new path) that preserves your current code while aligning it to MVC.




Below is a concrete MVC-friendly re-structure plan for **your current files** (frontend + backend), mapped to the flow you described. I’ll keep it pragmatic: minimal renames at first, clear “where things go”, and a migration path that doesn’t require rewriting everything at once.

---

## 1) How MVC maps to *your* app

### Backend (FastAPI)
- **Controllers:** FastAPI routers (`backend/api/routers/*.py`)
- **Models:** data access + domain logic (`backend/api/sources`, `backend/api/readers`)
- **Views:** JSON responses (Pydantic schemas recommended; right now you return dict/JSONResponse)

In practice: routers should be thin wrappers around “services” that call sources/readers and return schema objects.

### Frontend (plain JS + AutumnPlot-GL)
- **Views:** DOM panels/windows (Load Data window, timeline, selectors)
- **Controllers:** orchestrate user actions + API calls + state updates
- **Models:** in-browser state (catalog, selected layers, times, matched times)

You already have many pieces; they’re just not grouped by responsibility yet.

---

## 2) Proposed target structure (Frontend)

### Target tree
```
frontend/src/
  main.js                    # entrypoint (keep)
  app/
    store.js                 # app state (catalog, selections, times, layers)
    eventBus.js              # simple pub/sub (optional)
    config.js                # API base, defaults, etc.

  controllers/
    appController.js         # on load: fetch catalog, init managers
    dataSelectorController.js
    timeMatcherController.js
    layerManagerController.js

  views/
    panels/
      panelManager.js        # DOM layout, open/close panels
      dataSelectorView.js    # renders the "Load Data" window
      productGenView.js      # renders product generator (if that’s UI)
    components/
      timelineView.js
      catalogView.js         # category/source/product tree UI components

  services/
    api/
      catalogClient.js       # wraps calls to /api/v1/catalog etc.
      timeMatchClient.js
      dataClient.js          # points/grids/geojson fetchers
    decoding/
      ambp/                  # if you decode binary protocols
      decoders.js            # index barrel that re-exports

  domain/
    layerBuilder.js          # builds APGL layers from decoded data
    gridFactory.js
    products/
      productIndex.js        # already exists
      *.js                   # product definitions

  config/
    colormaps.js
    colormaps/...
  tests/
    ...                      # your __tests__ (can keep __tests__)
```

### Where your existing frontend files fit
Here’s a **mapping** from your current `frontend/src` files into that structure:

#### Controllers / orchestration
- `main.js` → keep as `frontend/src/main.js` (entry)
- `layermanager.js` → `frontend/src/controllers/layerManagerController.js` (or split: controller + domain)
- `timematcher.js` → `frontend/src/controllers/timeMatcherController.js`
- `DataLoader.js` → likely `frontend/src/services/api/dataClient.js` (if it fetches) or `controllers/` (if it orchestrates)

#### Views (DOM/UI)
- `PanelManager.js` → `frontend/src/views/panels/panelManager.js`
- `dataselector.js` → split:
  - rendering part → `frontend/src/views/panels/dataSelectorView.js`
  - orchestration part → `frontend/src/controllers/dataSelectorController.js`
- `productGen/productgen.js` → if it’s UI: `frontend/src/views/panels/productGenView.js`; if it’s “definition builder logic”: `domain/`

#### API clients / services
- `catalog/catalog.js` and `catalog/CatalogClient.js`:
  - keep client: `frontend/src/services/api/catalogClient.js`
  - any catalog parsing helpers: `frontend/src/domain/catalog/…` or `frontend/src/app/…`
- `catalog/DynamicViewManager.js` sounds like a view/controller hybrid. I would:
  - if it manipulates DOM: move under `views/`
  - if it manages “what products exist”: move under `domain/`

#### Data decode layer
- `decoders/*` → `frontend/src/services/decoding/*` (this is your “Model-ish” layer for the frontend)

#### Domain product definitions
- `products/*` → keep as `frontend/src/domain/products/*` (these are “model definitions” for what can be rendered)
- `LayerBuilder.js` → `frontend/src/domain/layerBuilder.js`
- `catalog/GridFactory.js` → `frontend/src/domain/gridFactory.js`

#### Config
- `config/colormaps.js` + `config/colormaps/` → keep under `frontend/src/config/`

#### Tests
- `__tests__/*` → keep as is, or move to `frontend/src/tests/` (either is fine)

---

## 3) Proposed target structure (Backend)

Your backend is already close. I’d add two folders and gently refactor toward them:

### Target tree
```
backend/api/
  main.py
  routers/                 # Controllers (keep)
  schemas/                 # Pydantic models for requests/responses (add)
  services/                # Orchestration logic (add)
  sources/                 # Data access (keep)
  readers/                 # File readers (keep)
  domain/                  # Pure domain helpers (optional)
  utils/                   # time parsing, shared helpers (optional)
  watcher.py
```

### What to change in backend
- Keep `routers/*.py` but move “heavy logic” into `services/*`.
- Move things like `_parse_key_to_dt` into `utils/time.py` (and import it from there) so routers don’t import each other.
- Add `schemas/` for:
  - `CatalogResponse`, `DataSource`, `Product`, `TimeListResponse`, `TimematchRequest/Response`, etc.
  This also prevents OpenAPI/Pydantic surprises.

---

## 4) Tie it to your flow (endpoints + frontend modules)

### Startup flow: “What sources do you have?”
Backend:
- `GET /api/v1/catalog` (you already have `routers/catalog.py`)
- returns a “catalog model” describing categories → sources → product groups → products

Frontend:
- `services/api/catalogClient.js` fetches catalog
- `app/store.js` stores it
- `dataSelectorController` and `catalogView` render it

### Data Selector: “What cycle times do you have for RAP?”
Backend:
- `GET /api/v1/gridded/rap/cycles` (or generic `GET /api/v1/times/cycles?source=rap`)
Frontend:
- `timesClient.listCycles(sourceId)`
- store updates → UI updates (cycle dropdown)

### Timeline: “What valid/available times exist?”
Backend:
- `GET /api/v1/times?source=...&product=...&cycle=...`
Frontend:
- `timeMatcherController` (or `timelineController`) loads these and populates timeline view

### Load Map: time matching + batch data
Backend:
- `POST /api/v1/timematch` (already exists)
- (recommended) `POST /api/v1/data/batch` (not required immediately, but will help performance)

Frontend:
- `layerManagerController.loadMap()`:
  1) POST timematch
  2) build list of requests for each layer/time
  3) fetch/stream data with concurrency limits (so you don’t “take forever”)
  4) `domain/layerBuilder` turns decoded data into APGL layers

---

## 5) “Do this in phases” migration plan (so you don’t break everything)

### Phase 1 (no behavior change, just organize)
- Create folders: `controllers/`, `views/`, `services/`, `domain/`, `app/`
- Move files without renaming symbols first, update imports.
- Keep `frontend/src/main.js` as the entrypoint.

### Phase 2 (separate view from controller)
- Split `dataselector.js` into:
  - `dataSelectorView.js` (DOM creation + render/update functions)
  - `dataSelectorController.js` (wires events, calls API, updates store)

### Phase 3 (introduce a real store)
- Create `app/store.js` with a single state object and `subscribe()` mechanism.
- Controllers update state; views subscribe and re-render.

### Phase 4 (backend schemas/services)
- Add `backend/api/schemas/` with Pydantic response types
- Routers return schema instances (fastapi will serialize)
- Move heavy logic to `backend/api/services/`

---

## 6) A concrete “starter store” (frontend) that fits your app
This is the core of MVC on the frontend: controllers mutate model, views render.

```js name=frontend/src/app/store.js
const state = {
  catalog: null,

  selection: {
    categoryId: null,
    sourceId: null,
    productId: null,
    cycleTime: null,
    dominantLayerId: null,
    layers: [] // list of selected layers
  },

  times: {
    available: [],
    matched: []
  },

  ui: {
    loadDataOpen: false,
    loading: false,
    error: null
  }
};

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  // very simple shallow merge; you can improve later
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
```

Controllers call API and update `setState()`. Views `subscribe()` and re-render.

---

## 7) A few specific suggestions based on your current filenames
- Rename to consistent casing:
  - `DataLoader.js` → `dataLoader.js`
  - `LayerBuilder.js` → `layerBuilder.js`
  - `PanelManager.js` → `panelManager.js`
  This matters more once you’re on Linux + Vite + imports.

- Decide what “manager” means:
  - “Manager that touches DOM” → view/controller
  - “Manager that builds layers/data” → domain/service

- Keep `products/` together and treat it as the “domain model” of renderable products.

---

## Next step (to make this actionable)
If you want, I can produce a **specific move table** like:

- `frontend/src/dataselector.js` → `frontend/src/controllers/dataSelectorController.js` (+ create view file)
- `frontend/src/PanelManager.js` → `frontend/src/views/panels/panelManager.js`
- etc.

To do that cleanly, I need one extra piece: in your current `frontend/src/main.js`, what are the top-level imports? (first ~30 lines). That tells me what depends on what, and where the clean “MVC seam” is in your current code.