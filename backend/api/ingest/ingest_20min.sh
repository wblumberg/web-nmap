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

python backend/api/ingest/gempak_sfc_ingest.py --type sao
python backend/api/ingest/gempak_sfc_ingest.py --type ship
python backend/api/ingest/airnow_ingest.py --verbose --hours 4

