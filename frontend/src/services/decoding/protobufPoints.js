/**
 * protobufPoints.js — Decode PointResponse protobuf messages
 *
 * Decodes the binary protobuf payload from /api/v1/db-points/… endpoints
 * and returns a normalized array of point observations that can be passed
 * directly to buildObsLayer() in the dataProduct definitions.
 *
 * The PointResponse message contains one PointObs per returned point.
 * Each PointObs carries:
 *   - lat / lon        → position for the per-frame UnstructuredGrid
 *   - validTime        → ISO 8601 string for the observation
 *   - variables        → map<string, float> for numeric fields
 *   - metadata         → map<string, string> for categorical fields
 *
 * Unlike gridded data, the UnstructuredGrid is rebuilt per-frame directly
 * from the lat/lon values embedded in the response — no separate grid_info
 * endpoint is needed or used.
 */

import protobuf from 'protobufjs';
import protoJSON from './wxdata.proto.json';

// Build the protobuf root once at module load (shared with protobufGrid.js)
const root = protobuf.Root.fromJSON(protoJSON);
const PointResponse = root.lookupType('wxdata.PointResponse');

/**
 * Decode a PointResponse protobuf ArrayBuffer.
 *
 * Returns an object whose `points` array is already in the shape expected by
 * buildObsLayer():
 *
 *   [
 *     {
 *       coord:      { lat: number, lon: number },
 *       valid_time: string,          // ISO 8601 UTC
 *       data:       {                // merged variables + metadata
 *         <field_name>: number | string | null,
 *         ...
 *       },
 *     },
 *     ...
 *   ]
 *
 * Metadata string values are kept as-is. Numeric variables are floats.
 * NaN values (protobuf float default of 0 for missing) are passed through
 * as-is — the product's formatter is responsible for blanking them.
 *
 * @param {ArrayBuffer} buffer      - raw protobuf bytes from fetch()
 * @returns {{
 *   sourceId:  string,
 *   startTime: string,
 *   endTime:   string,
 *   count:     number,
 *   points:    Array<{ coord: {lat:number, lon:number}, valid_time: string, data: object }>,
 *   meta:      object,
 * }}
 */
export function decodePointResponse(buffer) {
    const msg = PointResponse.decode(new Uint8Array(buffer));

    const points = msg.points.map(obs => {
        // Merge numeric variables and string metadata into a single data dict.
        // Variables take precedence if a key appears in both (shouldn't normally
        // happen, but be safe).
        const data = {};
        for (const [k, v] of Object.entries(obs.metadata || {})) {
            data[k] = v;
        }
        for (const [k, v] of Object.entries(obs.variables || {})) {
            data[k] = v;
        }
        return {
            coord:      { lat: obs.lat, lon: obs.lon },
            valid_time: obs.validTime,
            data,
        };
    });

    return {
        sourceId:  msg.sourceId,
        startTime: msg.startTime,
        endTime:   msg.endTime,
        count:     msg.count,
        points,
        meta:      msg.metadata || {},
    };
}
