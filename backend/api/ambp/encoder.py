import struct
import numpy as np
import gzip

# AMBP v2 Protocol Constants
MAGIC = b"AMBP"
VERSION = 2

# Message type identifiers
GRID = 1
POINT = 2
FEATURE = 3
CONTOUR = 4


def _pack_header(msg_type, header_bytes, payload_bytes, flags=0):
    """
    Construct a complete AMBP message packet.
    
    Packs a standard 16-byte header followed by variable-length header and payload sections.
    All numbers are little-endian.
    
    Args:
        msg_type: Message type identifier (GRID, POINT, FEATURE, or CONTOUR)
        header_bytes: Type-specific header data
        payload_bytes: Binary payload data
        flags: Optional flags (bit 0: gzip, bit 1: little endian)
    
    Returns:
        Complete binary message: [header (16 bytes)] + [type header] + [payload]
    """
    header_len = len(header_bytes)
    payload_len = len(payload_bytes)

    header = struct.pack(
        "<4sBBBBII",
        MAGIC,
        VERSION,
        msg_type,
        flags,
        0,  # reserved byte
        header_len,
        payload_len
    )

    return header + header_bytes + payload_bytes


def encode_grid(data, scale=1.0, offset=0.0, packing="int16"):
    """
    Encode a 2D gridded field (forecast, analysis, radar, satellite).
    
    Applies scale/offset preprocessing and packs values into compact binary format.
    Decoded value = raw_value * scale + offset
    
    Args:
        data: 2D NumPy array with shape (ny, nx)
        scale: Scaling factor applied during encoding
        offset: Offset applied during encoding
        packing: Compression type: "int16" (default), "int32", or "float32"
    
    Returns:
        Complete AMBP GRID message
    """
    ny, nx = data.shape

    # Pack data according to specified compression type
    if packing == "int16":
        packed = np.round((data - offset) / scale).astype(np.int16)
        packing_type = 1
    elif packing == "int32":
        packed = np.round((data - offset) / scale).astype(np.int32)
        packing_type = 2
    elif packing == "float32":
        packed = data.astype(np.float32)
        packing_type = 3
    else:
        raise ValueError("invalid packing")

    # Construct type-specific header
    header = struct.pack(
        "<IIffB3s",
        nx,
        ny,
        scale,
        offset,
        packing_type,
        b"\x00\x00\x00"  # padding
    )

    payload = packed.tobytes()

    return _pack_header(GRID, header, payload)


def encode_points(lats, lons, fields=None):
    """
    Encode point observations (METAR, lightning, aircraft, mesonet, buoy).
    
    Each point has lat/lon in microdegrees plus optional typed fields.
    
    Args:
        lats: Array of latitude values (degrees)
        lons: Array of longitude values (degrees)
        fields: Optional list of NumPy arrays with field data (float32 or int32)
    
    Returns:
        Complete AMBP POINT message
    """
    point_count = len(lats)

    if fields is None:
        fields = []

    field_count = len(fields)

    # Pack point count and field metadata
    header = struct.pack("<IHH", point_count, field_count, 0)

    # Build field definition table and extract field data
    field_defs = b""
    field_payload = []

    for arr in fields:
        if arr.dtype == np.float32:
            field_defs += struct.pack("<BBH", 3, 4, 0)  # type 3: float, 4 bytes
        elif arr.dtype == np.int32:
            field_defs += struct.pack("<BBH", 4, 4, 0)  # type 4: int, 4 bytes
        else:
            raise ValueError("unsupported field type")

        field_payload.append(arr)

    # Construct payload: lat/lon for each point, then field values
    payload = bytearray()

    for i in range(point_count):
        payload += struct.pack(
            "<ii",
            int(lats[i] * 1e6),  # convert to microdegrees
            int(lons[i] * 1e6)
        )

        for arr in field_payload:
            payload += arr[i].tobytes()

    return _pack_header(POINT, header + field_defs, payload)


def encode_features(features, field_defs=None):
    """
    Encode geometric features (tracks, polygons, fronts, watch/warning areas).
    
    Each feature has a geometry type, vertices, and optional attributes.
    
    Args:
        features: List of dicts with keys:
            - "geometry_type": 1 (point), 2 (polyline), or 3 (polygon)
            - "vertices": List of (lat, lon) tuples
            - "attributes": Optional list of attribute values (floats)
        field_defs: Optional list of (type, size) tuples describing attributes
    
    Returns:
        Complete AMBP FEATURE message
    """
    feature_count = len(features)

    if field_defs is None:
        field_defs = []

    field_count = len(field_defs)

    # Pack feature count and field metadata
    header = struct.pack("<IHH", feature_count, field_count, 0)

    # Build field definition table
    field_table = b""
    for ftype, size in field_defs:
        field_table += struct.pack("<BBH", ftype, size, 0)

    # Construct payload: geometry and attributes for each feature
    payload = bytearray()

    for feature in features:

        geom_type = feature["geometry_type"]
        verts = feature["vertices"]
        attrs = feature.get("attributes", [])

        # Pack feature metadata: type, attribute count, vertex count
        payload += struct.pack(
            "<BBHI",
            geom_type,
            0,  # reserved
            len(attrs),
            len(verts)
        )

        # Pack vertices as microdegree coordinates
        for lat, lon in verts:
            payload += struct.pack(
                "<ii",
                int(lat * 1e6),
                int(lon * 1e6)
            )

        # Pack attribute values
        for val in attrs:
            payload += struct.pack("<f", val)

    return _pack_header(FEATURE, header + field_table, payload)


def encode_contours(level, contours):
    """
    Encode ensemble contour lines (spaghetti diagrams).
    
    Multiple contours at a single level, grouped by ensemble member.
    
    Args:
        level: Contour level value (e.g., 500 hPa)
        contours: List of dicts with keys:
            - "member": Ensemble member ID
            - "vertices": List of (lat, lon) tuples
    
    Returns:
        Complete AMBP CONTOUR message
    """
    contour_count = len(contours)
    # Count unique ensemble members
    member_count = len(set(c["member"] for c in contours))

    # Pack contour level and counts
    header = struct.pack("<fHH", level, member_count, contour_count)

    # Construct payload: contour polylines with member IDs and vertices
    payload = bytearray()

    for c in contours:
        member = c["member"]
        verts = c["vertices"]

        # Pack contour metadata: member ID, vertex count
        payload += struct.pack(
            "<HHI",
            member,
            0,  # reserved
            len(verts)
        )

        # Pack vertices as microdegree coordinates
        for lat, lon in verts:
            payload += struct.pack(
                "<ii",
                int(lat * 1e6),
                int(lon * 1e6)
            )

    return _pack_header(CONTOUR, header, payload)