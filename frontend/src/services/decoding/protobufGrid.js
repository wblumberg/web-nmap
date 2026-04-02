/**
 * protobufGrid.js — Decode GridResponse protobuf messages
 *
 * Decodes the binary protobuf payload from /api/v1/gridded/… endpoints
 * and returns the same { fields, gridInfo, key } shape that the JSON
 * path produces, so downstream consumers (gridFactory, layerBuilder, etc.)
 * don't need any changes.
 *
 * Supports both float32 (default) and float16 precision transport.
 * When the server sends float16 data, it sets metadata.precision = "float16"
 * on the GridField message.  This halves the payload size with negligible
 * precision loss for visualization.
 */

import protobuf from 'protobufjs';
import protoJSON from './wxdata.proto.json';

// Build the protobuf root once at module load
const root = protobuf.Root.fromJSON(protoJSON);
const GridResponse = root.lookupType('wxdata.GridResponse');

/**
 * Convert a Uint8Array of IEEE 754 half-precision (float16) bytes into
 * a Float32Array.  Each pair of bytes is one float16 value, little-endian.
 *
 * @param {Uint8Array} raw - float16 bytes (length must be even)
 * @returns {Float32Array}
 */
function float16ToFloat32(raw) {
    const count = raw.byteLength / 2;
    const view  = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const out   = new Float32Array(count);

    for (let i = 0; i < count; i++) {
        const h = view.getUint16(i * 2, true);  // little-endian

        const sign     = (h >>> 15) & 0x1;
        const exponent = (h >>> 10) & 0x1f;
        const mantissa = h & 0x3ff;

        let f;
        if (exponent === 0) {
            // Subnormal or zero
            f = (sign ? -1 : 1) * Math.pow(2, -14) * (mantissa / 1024);
        } else if (exponent === 0x1f) {
            // Infinity or NaN
            f = mantissa ? NaN : ((sign ? -1 : 1) * Infinity);
        } else {
            f = (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
        }
        out[i] = f;
    }
    return out;
}

/**
 * Decode a GridResponse protobuf ArrayBuffer into the standard
 * { fields, gridInfo, key } format used by the rest of the frontend.
 *
 * @param {ArrayBuffer} buffer - raw protobuf bytes from fetch()
 * @returns {{ fields: Object<string, Float32Array>, gridInfo: object|null, key: string }}
 */
export function decodeGridResponse(buffer) {
    const msg = GridResponse.decode(new Uint8Array(buffer));

    const fields = {};
    let gridInfo = null;

    for (const [varName, pbField] of Object.entries(msg.fields)) {
        const raw = pbField.data;
        const precision = (pbField.metadata && pbField.metadata.precision) || 'float32';

        if (precision === 'float16') {
            // Float16 transport: each value is 2 bytes
            fields[varName] = float16ToFloat32(raw);
        } else {
            // Float32 transport (default): create aligned copy
            const aligned = new ArrayBuffer(raw.byteLength);
            new Uint8Array(aligned).set(raw);
            fields[varName] = new Float32Array(aligned);
        }

        if (!gridInfo && pbField.grid) {
            const g = pbField.grid;
            gridInfo = {
                grid_type:   g.gridType,
                ni:          g.ni,
                nj:          g.nj,
                lat_min:     g.latMin,
                lat_max:     g.latMax,
                lon_min:     g.lonMin,
                lon_max:     g.lonMax,
                dx:          g.dx,
                dy:          g.dy,
                proj_params: _convertProjParams(g.projParams),
            };
        }
    }

    return { fields, gridInfo, key: msg.key };
}

/**
 * Convert proj_params map values from strings back to numbers where possible.
 */
function _convertProjParams(params) {
    if (!params) return {};
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        const num = Number(v);
        out[k] = isNaN(num) ? v : num;
    }
    return out;
}
