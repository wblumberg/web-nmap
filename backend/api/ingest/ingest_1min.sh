#!/bin/bash

source /home/gblumberg/.bashrc
#/home/gblumberg/opt/miniforge3/etc/profile.d/conda.sh
conda activate nmap_api
which python
cd /home/gblumberg/code/web-nmap
export PYTHONPATH=/home/gblumberg/code/web-nmap
pwd
ls *
export TIMESCALE_CONN='postgresql+asyncpg://webnmap:SH%40RPpyFunt1m3z@localhost:5432/wxdata'

python backend/api/ingest/lightning_ingest.py /data/base/lightning/
python backend/api/ingest/lsr_ingest.py
python backend/api/ingest/alerts/run_ingest.py --fetch --shp backend/assets/mapping/counties/counties_boundaries_2025.shp --verbose
python -m backend.api.ingest.vad_ingest --files-per-station 15 --lookback-minutes 10


