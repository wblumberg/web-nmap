/**
 * protobufGrid.js — Decode GridResponse protobuf messages
 *
 * Decodes the binary protobuf payload from /api/v1/gridded/… endpoints
 * and returns { fields, gridInfo, key } where each field value is a
 * descriptor object carrying the raw typed array plus quantization params:
 *
 *   fields[varName] = { int16Data: Int16Array, scale_factor, add_offset, data_type }
 *
 * The dataClient layer is responsible for dequantizing these into
 * RawScalarField objects using the APgL operator API.
 *
 * Supported data_type values on the wire:
 *   "int16"   — quantized integers; physical = data * scale_factor + add_offset
 *   "float32" — legacy float32 path (pass-through)
 *   "float16" — legacy float16 path (half-float decode)
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
            f = (sign ? -1 : 1) * Math.pow(2, -14) * (mantissa / 1024);
        } else if (exponent === 0x1f) {
            f = mantissa ? NaN : ((sign ? -1 : 1) * Infinity);
        } else {
            f = (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
        }
        out[i] = f;
    }
    return out;
}

/**
 * Decode a GridResponse protobuf ArrayBuffer.
 *
 * @param {ArrayBuffer} buffer - raw protobuf bytes from fetch()
 * @returns {{
 *   fields:   Object<string, { rawData: Int16Array|Float32Array, scale_factor: number, add_offset: number, data_type: string }>,
 *   gridInfo: object|null,
 *   key:      string
 * }}
 */
export function decodeGridResponse(buffer) {
    const msg = GridResponse.decode(new Uint8Array(buffer));

    const fields = {};
    let gridInfo = null;

    for (const [varName, pbField] of Object.entries(msg.fields)) {
        const raw      = pbField.data;
        const dataType = pbField.dataType || (pbField.metadata && pbField.metadata.precision) || 'float32';

        let rawData;
        if (dataType === 'int16') {
            // Quantized int16: re-interpret bytes as a signed Int16Array.
            const aligned = new ArrayBuffer(raw.byteLength);
            new Uint8Array(aligned).set(raw);
            rawData = new Int16Array(aligned);
        } else if (dataType === 'float16') {
            rawData = float16ToFloat32(raw);
        } else {
            // float32 (default / legacy)
            const aligned = new ArrayBuffer(raw.byteLength);
            new Uint8Array(aligned).set(raw);
            rawData = new Float32Array(aligned);
        }

        fields[varName] = {
            rawData,
            scale_factor: pbField.scaleFactor ?? 1.0,
            add_offset:   pbField.addOffset   ?? 0.0,
            data_type:    dataType,
        };

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
                ll_x:        g.llX,
                ll_y:        g.llY,
                ur_x:        g.urX,
                ur_y:        g.urY,
                sat_lon:     g.satLon,
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
