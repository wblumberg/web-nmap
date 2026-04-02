# Web-NMAP Frontend README

This directory holds the code and resources to run the frontend of the web-nmap app.

To run this webapp, use the following command to start the web server:

`npm run dev`

Being a vite server, it will start on the port 5173(4).

## What all is contained in the frontend:

Within the `public/` folder are the static assets for the webapp such as:
- CSS files for the overall app, dataSelector, productGen, and mapBuilder windows.
- style.json file to provide the map style (e.g., background, geographic outlines, highways, city names, etc.)
- tiles.json file to provide the map information about the mapping tiles and vector layers.
- the main index.html page that initiates the webapp.

The JavaScript code to execute the webapp is contained in the `src/` folder.  Below describes the directory structure:

`src/main.js` - Application bootstrap/entry point
`src/app/store.js` - Javascript code to represent the app state (model in MVC) such as frozenMap, productGenOpen, sources (from catalog), etc.
`config/colormaps.js` - custom colormaps from APGL.  Will probably be modified in the future.
`controllers/appController.js` - this is the glue that connects all of the pieces of the app together.  This controller initializes the map state, wires up the app toolbar, the keyboard controls, loads the frames from the backend, does the time matching, etc.  TODO: it might be best to break this file up into smaller components.
`controllers/*.js` - many of these controllers are empty files that should be simplified.
`domain/` - holds scripts for the dataProducts, the GridFactory (builds the APGL grids for a dataset), and builds all of the respective layers for a map frame.
`domain/dataProducts/` - the repository for all of the possible dataProducts we could view from different data sources.  Similiar to the "restore" files repository for NAWIPS/GEMPAK.
`services/api/` - code for interacting with the API to interact with the data catalog (get times, grid info, data sources) and fetch actual data from the API.
`services/decoding/` - routines for decoding the data that is recieved from the API (e.g., ProtocolBuffer schemas).
`views/components/` - currently empty.
`views/panels/` - code to handle different panels the user can open up in the UI.  For example, the dataSelector panel to select the data and products you want to add to the map, a panel to generate products (contours, fronts, text, etc.), and the productManager to view the timeline and products that will be put on the map looper.
`catalog.js` - old catalog JavaScript code.  Been superceeded by the method of interacting with the API to get the data source catalog.
`DataLoader.js` - old data loader code.  There is some code in here to set up the auto-update for loopers by listening for new Server-Side Events.
`main.js` - initialize the app via the appController.js init() function.
`PanelManager.js` - a lot of older code here.  Maybe the PRODUCT_SUITES is important, but all the other stuff seems to be handled by the API now.