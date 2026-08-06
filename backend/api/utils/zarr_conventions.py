"""Normalize Zarr metadata and dimensions used by backend readers."""

# zarr_conventions.py
import zarr
from numcodecs import Blosc

ZARR_FORMAT     = 2
BLOSC_FLOAT     = Blosc(cname='zstd', clevel=5, shuffle=Blosc.BITSHUFFLE)
BLOSC_UINT      = Blosc(cname='lz4',  clevel=3, shuffle=Blosc.BITSHUFFLE)
FLOAT_DTYPE     = "float16"   # default for display fields
ACCUM_DTYPE     = "float32"   # for accumulated fields
