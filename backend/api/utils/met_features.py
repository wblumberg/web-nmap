# met_features.py

import numpy as np
import struct
import json

# Geometry type constants
POINT = 0
LINESTRING = 1
POLYGON = 2
MULTILINESTRING = 3


# =========================
# Quantization utilities
# =========================

def quantize_lat(lat):
    return np.round((lat + 90.0) * 100).astype(np.int32)


def quantize_lon(lon):
    return np.round((lon + 180.0) * 100).astype(np.int32)


def delta_encode(arr):
    return np.diff(arr, prepend=arr[0]).astype(np.int32)


# =========================
# Geometry encoders
# =========================

def encode_linestring(lat, lon):
    lat_q = quantize_lat(lat)
    lon_q = quantize_lon(lon)

    dlat = delta_encode(lat_q).astype(np.int16)
    dlon = delta_encode(lon_q).astype(np.int16)

    n = len(lat)

    header = struct.pack("<BI", LINESTRING, n)
    body = dlat.tobytes() + dlon.tobytes()

    return header + body


def encode_polygon(lat, lon):
    lat_q = quantize_lat(lat)
    lon_q = quantize_lon(lon)

    dlat = delta_encode(lat_q).astype(np.int16)
    dlon = delta_encode(lon_q).astype(np.int16)

    n = len(lat)

    header = struct.pack("<BI", POLYGON, n)
    body = dlat.tobytes() + dlon.tobytes()

    return header + body


def encode_multilinestring(lines):
    """
    lines: list of (lat_array, lon_array)
    """
    n_lines = len(lines)

    parts = []
    parts.append(struct.pack("<BH", MULTILINESTRING, n_lines))

    for lat, lon in lines:
        lat_q = quantize_lat(lat)
        lon_q = quantize_lon(lon)

        dlat = delta_encode(lat_q).astype(np.int16)
        dlon = delta_encode(lon_q).astype(np.int16)

        n = len(lat)

        parts.append(struct.pack("<H", n))
        parts.append(dlat.tobytes())
        parts.append(dlon.tobytes())

    return b"".join(parts)


# =========================
# Properties encoding
# =========================

def encode_properties(props: dict):
    """
    Encode properties as UTF-8 JSON (can be replaced later with binary schema)
    """
    blob = json.dumps(props, separators=(",", ":")).encode("utf-8")
    return struct.pack("<H", len(blob)) + blob


# =========================
# Feature encoder
# =========================

def encode_feature(geometry_bytes, properties=None):
    if properties is None:
        prop_blob = struct.pack("<H", 0)
    else:
        prop_blob = encode_properties(properties)

    return geometry_bytes + prop_blob


# =========================
# Feature collection encoder
# =========================

def encode_feature_collection(features):
    """
    features: list of already-encoded feature blobs
    """
    out = []
    out.append(struct.pack("<H", len(features)))

    for f in features:
        out.append(struct.pack("<I", len(f)))
        out.append(f)

    return b"".join(out)
