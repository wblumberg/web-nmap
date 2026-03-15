"""
AutumnPlot Meteorological Binary Protocol (AMBP) v1.0
Author: Your Team
"""

import struct
import numpy as np
from typing import List, Tuple

# ==============================
# Protocol Constants
# ==============================

MAGIC = b"AMBP"
VERSION = 1

# Message Types
MSG_GRID = 1
MSG_POINT = 2
MSG_GEOMETRY = 3

# DType IDs
DTYPE_INT16 = 1
DTYPE_INT32 = 2
DTYPE_FLOAT32 = 3

# Geometry Types
GEOM_POLYLINE = 1
GEOM_POLYGON = 2

# ==============================
# Utility: Scale Packing
# ==============================

def auto_pack_int16(data: np.ndarray):
    """
    Automatically compute scale/offset and pack float array into int16.
    """
    if not np.isfinite(data).any():
        raise ValueError("Data contains no finite values.")

    data_min = np.nanmin(data)
    data_max = np.nanmax(data)

    scale = (data_max - data_min) / 65530.0 if data_max != data_min else 1.0
    offset = data_min

    packed = np.full(data.shape, -32768, dtype=np.int16)
    mask = np.isfinite(data)
    packed[mask] = np.round((data[mask] - offset) / scale).astype(np.int16)

    return packed, scale, offset


# ==============================
# Packet Framing
# ==============================

def _frame_packet(message_type: int, header_block: bytes, data_block: bytes) -> bytes:
    flags = 0
    header_length = len(header_block)

    return (
        MAGIC +
        struct.pack("<BBH", VERSION, message_type, flags) +
        struct.pack("<I", header_length) +
        header_block +
        data_block
    )


# ==============================
# Grid Message
# ==============================

def encode_grid(
    array: np.ndarray,
    variable_id: int,
    units_id: int,
    projection_id: int,
    bbox: Tuple[float, float, float, float],
    pack: bool = True
) -> bytes:
    """
    Encode a 2D grid into AMBP format.
    """

    if array.ndim != 2:
        raise ValueError("Grid must be 2D.")

    ny, nx = array.shape

    if pack:
        packed, scale, offset = auto_pack_int16(array.astype(np.float32))
        dtype_id = DTYPE_INT16
        data_block = packed.tobytes(order="C")
        missing = -32768
    else:
        scale = 1.0
        offset = 0.0
        dtype_id = DTYPE_FLOAT32
        packed = array.astype(np.float32)
        data_block = packed.tobytes(order="C")
        missing = -9999

    minlon, minlat, maxlon, maxlat = bbox

    header = struct.pack(
        "<IIffhBBBBffff",
        nx,
        ny,
        scale,
        offset,
        missing,
        dtype_id,
        variable_id,
        units_id,
        projection_id,
        minlon,
        minlat,
        maxlon,
        maxlat,
    )

    header = header.ljust(64, b"\x00")  # pad to 64 bytes

    return _frame_packet(MSG_GRID, header, data_block)


# ==============================
# Point Message
# ==============================

def encode_points(
    fields: List[Tuple[int, np.ndarray, int, float, float]]
) -> bytes:
    """
    fields: List of tuples:
        (field_id, array, dtype_id, scale, offset)
    """

    if not fields:
        raise ValueError("No fields provided.")

    count = len(fields[0][1])

    for _, arr, _, _, _ in fields:
        if len(arr) != count:
            raise ValueError("All point fields must have same length.")

    header = struct.pack("<IB3s", count, len(fields), b"\x00\x00\x00")

    field_descriptors = b""
    data_block = b""

    for field_id, arr, dtype_id, scale, offset in fields:
        field_descriptors += struct.pack(
            "<BBHff",
            field_id,
            dtype_id,
            0,
            scale,
            offset
        )

        if dtype_id == DTYPE_INT16:
            data_block += arr.astype(np.int16).tobytes()
        elif dtype_id == DTYPE_INT32:
            data_block += arr.astype(np.int32).tobytes()
        elif dtype_id == DTYPE_FLOAT32:
            data_block += arr.astype(np.float32).tobytes()
        else:
            raise ValueError("Unsupported dtype.")

    header_block = header + field_descriptors

    return _frame_packet(MSG_POINT, header_block, data_block)


# ==============================
# Geometry Message
# ==============================

def encode_geometries(
    geometries: List[Tuple[int, np.ndarray]]
) -> bytes:
    """
    geometries: List of tuples:
        (geometry_type, vertices Nx2 float array in degrees)
    """

    header = struct.pack("<I", len(geometries))

    data_block = b""

    for geom_type, vertices in geometries:
        if vertices.shape[1] != 2:
            raise ValueError("Vertices must be Nx2 array.")

        vertex_count = vertices.shape[0]

        # Scale to microdegrees
        scaled = np.round(vertices * 1e6).astype(np.int32)

        data_block += struct.pack("<B3sI", geom_type, b"\x00\x00\x00", vertex_count)
        data_block += scaled.tobytes()

    return _frame_packet(MSG_GEOMETRY, header, data_block)