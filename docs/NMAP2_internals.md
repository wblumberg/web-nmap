## Proposed new data file structure for Web-NMAP

Use three file formats:
- compressed JSON for point data (surface, upper air)
- compressed ZARR for gridded and image data
- GeoJSON for product generation and VGF

## Understanding how NMAP2 handles datasets

datatype.tbl has the following columns of information:

- the directory the data lives in
- the file template
- the file type category (none, imagery, surface obs, surface forecast, upper air obs, upper air fcst, gridded data, vector graphics file, miscellaneous)
- the file type subcategory (none, surface obs in daily files, surface obs in hourly files, surface fcst, flash flood guidance one time per day, upper air obs in daily files, upper air forecast, grid forecast, grid analysis)
- the default number of frames
- the default range of data to view
- the default interval of the frames
- the binning settings (ON/OFF, minutes before, minutes after, latest data only flag)
- the time matching setting (exact, only before and equal times, only after and equal times, nearest including before and after times)

## Understanding how NMAP2 handles datasets that go on a station model (point data)

prmlst.tbl specifies the pre-defined station plotting models that can be used for observational data types such as surface, upper-air, and surface forecast data.  The information used:
- the text identifier for the station plotting model (e.g., simple, winter, summer, 1 km winds, etc.)
- the observational data type that the station model corresponds to (e.g., METAR, SHIP, FFG, SYNOP, ACFT, UAIR, etc.)
- the vertical coordinate to be plotted (PRES, HGHT, NONE)
- the colors
- the station parameters at each spot around the station model.
- the level of filtering
- the level to be plotted (e.g., 850 mb, 1000 m, etc.)
- the title text.

## Understanding how NMAP2 datasets are structured and organized.

Data Access Configuration:

I.  Image Data Sources (IMAGE)

Layer#  Description			Table/Columns		Example
------------------------------------------------------------------------
1	Data Source Name		Hard Coded		IMAGE
2	Image Type			datatype.tbl, cols 1,4	SAT
3	Top-Level Image Type directory	N/A			GOES-E
4	Sub-directory			N/A			Atlantic
5	Sub-directory			N/A			IR	

The time line frame times are obtained from the image file names.  The number of
selected times and total time span are obtained from the DEF # FRM and DEF RANGE
columns, respectively, in the datatype.tbl.

II.  Observational Data Sources (SURF_OBS, UAIR_OBS)

Layer#  Description                     Table/Columns           Example
------------------------------------------------------------------------
1	Data Source Name		Hard Coded		SURF_OBS
2	Observation Data Type		datatype.tbl, cols 1,4	METAR
3	Station Plotting Model Name	prmlst.tbl, cols 1,2	standard	

The time line is constructed by opening the latest data files that match the 
template specified in the 3rd column of the datatype.tbl for the selected data 
type.  The available frame times and time increments are read from the data 
files.  The time line span and default number of frames selected are obtained 
from the Default Range and Default Number of Frames, columns of the datatype table, respectively. 

Layer#  Description                     Table/Columns           Example
------------------------------------------------------------------------
1       Data Source Name                Hard Coded              SURF_FCST
2	Surface Forecast Data Set Name	datatype.tbl, cols 1,4	MRFMOS
3	Cycle Time, from template	datatype.tbl, cols 2,3	020305_1200
4	Station Plotting Model Name	prmlst.tbl, cols 1,2	climo_mm	 

The time line is constructed by opening the surface forecast data file that
matches the template in the 3rd column of the datatype.tbl using the user-
selected cycle time.  The forecast valid times are read from the surface 
forecast data file and selected by default for loading.

Layer#  Description                     Table/Columns           Example
------------------------------------------------------------------------
1 	Data Source Name		Hard Coded		GRID
2	Model Name			datatype.tbl, cols 1,4	avn	
3	Cycle Time, from template	datatype.tbl, cols 2,3	020305_1200
4	Product Group Name		mod_res.tbl, cols 3,4	basic_wx	
5	Product Name			mod_res.tbl, cols 1,4	PRECIP_TYPE	

The time line is constructed by opening the model data file that matches the
template in the 3rd column of the datatype.tbl, using the user-selected cycle 
time.  The forecast valid times are read from the model data file and selected 
by default for loading.

V.  VGF Data Source (VGF)

Layer#  Description                     Table/Columns           Example
------------------------------------------------------------------------
1 	Data Source Name		Hard Coded		VGF
2	VGF Group Name			vgf.tbl, col 1		bawx
3	VGF Name, from directory list	vgf.tbl, col 2		rnsnow.vgf

The time line uses the system clock time rounded to the nearest hour for the
selected frame time. 

VI.  Miscellaneous Data Sources (MISC)

Layer#  Description                     Table/Columns           Example
------------------------------------------------------------------------
1       Data Source Name                Hard Coded              MISC
2	    Misc. Data Set Name		   datatype.tbl, col 1 	        AIRM

Miscellaneous data sources obtain their level 2 names from the data set 
alias (file type) names given in column 1 of the $GEMTBL/config/datatype.tbl
table.  All first column entries that match CAT_MSC in the 4th column are
listed in the scroll list. 

The time line is constructed using the default range and interval specified
in the datatype.tbl, DEF RANGE and DEF INTRVL columns (7,8), respectively.
The number of frames is computed using these values and all frames are 
selected by default for loading.  The path and template specified in 
the datatype.tbl, columns 2 and 3, respectively, are used to open the
appropriate files.

FRAME DATASET OVERLAYS AND PGEN ORDERING:

Each frame may contain multiple data sets, map overlays, logos and product
generation objects.  NMAP uses the following order in plotting when constructing
a frame: 
 
	Images
	Grid 
	Surface Observations
	Sounding Observations
	Surface Forecast 
	Miscellaneous
	VGF
	Maps/Overlays/Lat/Lon Lines
	Logos
	Active Product Generation


## How different data types are loaded:
