#!/bin/bash

source /home/gblumberg/.bashrc
#/home/gblumberg/opt/miniforge3/etc/profile.d/conda.sh
conda activate nmap_api
which python
export PYTHONPATH=/home/gblumberg/code/web-nmap
cd /home/gblumberg/ingest/satellite

pwd
ls *

python nc2zarr.py /data/base/goes_conus/ /data/store/raster/satellite/ --satellite=GOES-19 --skip-existing

# We're gonna CD to the webnmap directory
export TIMESCALE_CONN='postgresql+asyncpg://webnmap:SH%40RPpyFunt1m3z@localhost:5432/wxdata'
export PYTHONPATH=/home/gblumberg/code/web-nmap
cd $PYTHONPATH

python backend/api/ingest/recon_ingest.py --keep-all --verbose
