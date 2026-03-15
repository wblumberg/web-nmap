/*
 * AutumnPlot Meteorological Binary Protocol (AMBP) v1.0 Decoder
 */

const AMBP_MAGIC = "AMBP";
const AMBP_VERSION = 1;

// Message Types
const MSG_GRID = 1;
const MSG_POINT = 2;
const MSG_GEOMETRY = 3;

// DTypes
const DTYPE_INT16 = 1;
const DTYPE_INT32 = 2;
const DTYPE_FLOAT32 = 3;

// Geometry Types
const GEOM_POLYLINE = 1;
const GEOM_POLYGON = 2;


// ==============================
// Public API
// ==============================

export function decodeAMBP(arrayBuffer) {
    const view = new DataView(arrayBuffer);

    // Validate magic
    const magic = readString(view, 0, 4);
    if (magic !== AMBP_MAGIC) {
        throw new Error("Invalid AMBP magic header");
    }

    const version = view.getUint8(4);
    if (version !== AMBP_VERSION) {
        throw new Error(`Unsupported AMBP version: ${version}`);
    }

    const messageType = view.getUint8(5);
    const flags = view.getUint16(6, true);
    const headerLength = view.getUint32(8, true);

    const headerOffset = 12;
    const dataOffset = headerOffset + headerLength;

    switch (messageType) {
        case MSG_GRID:
            return decodeGrid(arrayBuffer, headerOffset, dataOffset);
        case MSG_POINT:
            return decodePoints(arrayBuffer, headerOffset, dataOffset);
        case MSG_GEOMETRY:
            return decodeGeometry(arrayBuffer, headerOffset, dataOffset);
        default:
            throw new Error(`Unknown AMBP message type: ${messageType}`);
    }
}


// ==============================
// Grid Decoder
// ==============================

function decodeGrid(buffer, headerOffset, dataOffset) {
    const view = new DataView(buffer);

    let o = headerOffset;

    const nx = view.getUint32(o, true); o += 4;
    const ny = view.getUint32(o, true); o += 4;
    const scale = view.getFloat32(o, true); o += 4;
    const offset = view.getFloat32(o, true); o += 4;
    const missing = view.getInt16(o, true); o += 2;

    const dtype = view.getUint8(o); o += 1;
    const variableId = view.getUint8(o); o += 1;
    const unitsId = view.getUint8(o); o += 1;
    const projectionId = view.getUint8(o); o += 1;

    const bbox = [
        view.getFloat32(o, true),
        view.getFloat32(o + 4, true),
        view.getFloat32(o + 8, true),
        view.getFloat32(o + 12, true)
    ];

    const count = nx * ny;

    let data;

    if (dtype === DTYPE_INT16) {
        data = new Int16Array(buffer, dataOffset, count);
    } else if (dtype === DTYPE_INT32) {
        data = new Int32Array(buffer, dataOffset, count);
    } else if (dtype === DTYPE_FLOAT32) {
        data = new Float32Array(buffer, dataOffset, count);
    } else {
        throw new Error("Unsupported grid dtype");
    }

    return {
        type: "grid",
        nx,
        ny,
        scale,
        offset,
        missing,
        variableId,
        unitsId,
        projectionId,
        bbox,
        data
    };
}


// ==============================
// Point Decoder
// ==============================

function decodePoints(buffer, headerOffset, dataOffset) {
    const view = new DataView(buffer);

    let o = headerOffset;

    const count = view.getUint32(o, true); o += 4;
    const fieldCount = view.getUint8(o); o += 1;
    o += 3; // reserved

    const fields = [];

    for (let i = 0; i < fieldCount; i++) {
        const fieldId = view.getUint8(o); o += 1;
        const dtype = view.getUint8(o); o += 1;
        o += 2; // reserved
        const scale = view.getFloat32(o, true); o += 4;
        const offset = view.getFloat32(o, true); o += 4;

        fields.push({ fieldId, dtype, scale, offset });
    }

    const result = {};
    let dataPtr = dataOffset;

    for (let f of fields) {
        let arr;

        if (f.dtype === DTYPE_INT16) {
            arr = new Int16Array(buffer, dataPtr, count);
            dataPtr += count * 2;
        } else if (f.dtype === DTYPE_INT32) {
            arr = new Int32Array(buffer, dataPtr, count);
            dataPtr += count * 4;
        } else if (f.dtype === DTYPE_FLOAT32) {
            arr = new Float32Array(buffer, dataPtr, count);
            dataPtr += count * 4;
        } else {
            throw new Error("Unsupported point dtype");
        }

        result[f.fieldId] = {
            data: arr,
            scale: f.scale,
            offset: f.offset
        };
    }

    return {
        type: "point",
        count,
        fields: result
    };
}


// ==============================
// Geometry Decoder
// ==============================

function decodeGeometry(buffer, headerOffset, dataOffset) {
    const view = new DataView(buffer);

    let o = headerOffset;
    const featureCount = view.getUint32(o, true);

    let dataPtr = dataOffset;

    const features = [];

    for (let i = 0; i < featureCount; i++) {
        const geomType = view.getUint8(dataPtr); dataPtr += 1;
        dataPtr += 3; // reserved

        const vertexCount = view.getUint32(dataPtr, true);
        dataPtr += 4;

        const coords = new Int32Array(buffer, dataPtr, vertexCount * 2);
        dataPtr += vertexCount * 2 * 4;

        features.push({
            geometryType: geomType,
            vertexCount,
            coords,
            scale: 1e-6
        });
    }

    return {
        type: "geometry",
        featureCount,
        features
    };
}


// ==============================
// Helpers
// ==============================

function readString(view, offset, length) {
    let s = "";
    for (let i = 0; i < length; i++) {
        s += String.fromCharCode(view.getUint8(offset + i));
    }
    return s;
}