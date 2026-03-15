/**
 * GridFactory.js
 *
 * Converts a GridInfo object (returned by the API /grid_info endpoint)
 * into the autumnplot-gl Grid object needed by RawScalarField, RawVectorField,
 * and RawObsField.
 *
 * This is the single place where API grid descriptors are translated into
 * autumnplot-gl Grid constructors.  No grid geometry is hardcoded anywhere
 * else in the JavaScript codebase.
 *
 * ─── Supported grid types ────────────────────────────────────────────────────
 *   'plate_carree'  → apgl.PlateCarreeGrid
 *   'lambert'       → apgl.LambertGrid  (when autumnplot-gl adds it)
 *                     currently falls back to PlateCarreeGrid with a note
 *   'polar_stereo'  → future: apgl.PolarStereographicGrid
 *   'mercator'      → future: apgl.MercatorGrid
 */

import * as apgl from 'autumnplot-gl';

/**
 * Build an autumnplot-gl Grid from a GridInfo descriptor returned by the API.
 *
 * @param {object} gridInfo  - The 'grid' field from a /grid_info response
 * @returns {object}         - An apgl Grid instance
 */
export function makeApglGrid(gridInfo) {
    if (!gridInfo) throw new Error('makeApglGrid: gridInfo is null or undefined');

    const { grid_type, ni, nj, lat_min, lon_min, dx, dy, proj_params } = gridInfo;

    switch (grid_type) {
        case 'plate_carree':
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, dx, dy);

        case 'lambert': {
            // autumnplot-gl LambertGrid constructor (when available):
            //   new apgl.LambertGrid(ni, nj, lon_sw, lat_sw, dx, dy, lat_0, lon_0, lat_1, lat_2)
            const { lat_0 = 25, lon_0 = -95, lat_1 = 25, lat_2 = 25 } = proj_params ?? {};
            if (typeof apgl.LambertGrid !== 'undefined') {
                return new apgl.LambertGrid(ni, nj, lon_min, lat_min, dx, dy,
                                            lat_0, lon_0, lat_1, lat_2);
            }
            // Fallback until LambertGrid is in autumnplot-gl
            console.warn(
                `[GridFactory] LambertGrid not available in autumnplot-gl; ` +
                `falling back to PlateCarreeGrid for ${ni}×${nj} grid. ` +
                `Projection will be approximate.`
            );
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, dx, dy);
        }

        case 'rotated_plate_carree':
            if (typeof apgl.PlateCarreeRotatedGrid !== 'undefined') {
                const { rot_lat_0, rot_lon_0 } = proj_params ?? {};
                return new apgl.PlateCarreeRotatedGrid(
                    ni, nj, lon_min, lat_min, dx, dy, rot_lat_0, rot_lon_0
                );
            }
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, dx, dy);

        default:
            console.warn(`[GridFactory] Unknown grid_type '${grid_type}', ` +
                         `using PlateCarreeGrid`);
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, dx, dy);
    }
}

/**
 * Build an apgl.UnstructuredGrid from a list of {lat, lon} points.
 * Used for station plots, LSRs, aircraft positions, etc.
 *
 * @param {Array<{lat: number, lon: number}>} coords
 * @returns {apgl.UnstructuredGrid}
 */
export function makeUnstructuredGrid(coords) {
    return new apgl.UnstructuredGrid(coords.map(c => ({ lat: c.lat, lon: c.lon })));
}
