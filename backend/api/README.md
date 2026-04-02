# What this directory does:

This directory contains the scripts needed by FastAPI to serve data and metadata to the frontend.

# What the directory structure is:

The directory structure is as follows:

- `ambp/` a prototype AutumnPlot Meteorological Binary Protocol (AMBP) to help transport data from the backend to the frontend (has been superceded by using ProtocolBuffers)
- `docs/` various documentation of the API
- `readers/` various readers for the datasets that exist on disk that can be served.  The individual readers will return information such as:
    - The grid information needed by AutumnPlot to plot the data via a base.py GridInfo object.
    - A GriddedResult object (compressed by a ProtocolBuffer) if it's a gridded dataset that needs to be returned.
    - A PointResult object (currently using GeoJSON) if it's a point-type dataset that is being returned.
    - A GeometryResult object (currently using GeoJSON framework) if it's a geometry-type dataset that is being returned.
    - A list of the forecast hours (valid times)
- `routers/` various endpoints for the API.  This includes queries about:
    - The data source catalog via `catalog.py`.  These endpoints tell the frontend what data sources are available, metadata about each data source, what times these data are valid for, and information about their grid (if true).
    - Data events (such as new data has arrive) via `events.py`.  This endpoint has not been tested yet.
    - Geometric data via `geometry.py`.  This endpoint has not been tested yet.
    - Point data via `points.py`.  This endpoint has not been tested yet.
    - Lightning data via `lightning.py`.  This endpoint should be consolidated into the point data type.
    - Observation data via `observations.py`.  This endpoint should be consolidated into the point data type.
    - Time matching help via `timematch,py`.  This endpoint has not been tested and currently its role is occupied by code on the frontend.
    - `ambp.py` code to implement the AutumnPlot Meteorological Binary Protocol.  Has not been tested and should be removed.
- `schemas/` includes some Pydantic schemas for the endpoint.  Currently there is only one:
    - `catalog.py` contains some prototype schemas for the catalog endpoint.
- `services/` includes some various services the API provides, such as interacting with a SQL database for observations and caching the grids that get served.
- `sources/` is a directory where all of the data sources in the catalog are specified (where they are found, how they are read, what their name is, any other descriptive information)
    - Within `registry.py` are a number of data sources (some active, some inactive) for testing.  Included is a filename glob, source_id, source_type, data_catagory, etc.
    - Other `.py` files are individual data sources not added to the primary registry.  Some of these are those that I have added.  
    - If custom data sources need a custom reader, we need to write that and put it in the `readers/` directory.
- `utils/` provides some other various utilities to quantize the data types (lat, lon, delta encodes) to encode the data before being sent.  Not all of these are currently being used.

# What are any extra files?

within the main directory are the following extra files:

`main.py` - runs the API and is run when uvicorn is run.
`metrics.py` - code to compute metrics about API responsiveness, etc.
`watcher.py` - code to run the watchdog that monitors the data directories for new data.

