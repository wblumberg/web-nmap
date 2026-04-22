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
 *   'geostationary'  → apgl.GeostationaryImage (when autumnplot-gl adds it)
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

    const { grid_type, ni, nj, lat_min, lon_min, lat_max, lon_max, dx, dy, ll_x, ll_y, ur_x, ur_y, sat_lon, proj_params } = gridInfo;
    console.warn('[GridFactory] makeApglGrid input:', JSON.stringify({ grid_type, ni, nj, lat_min, lon_min, lat_max, lon_max, dx, dy, ll_x, ll_y, ur_x, ur_y, sat_lon, proj_params }));

    switch (grid_type) {
        case 'plate_carree':
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, lon_max, lat_max);

        case 'lambert': {
            // autumnplot-gl LambertGrid constructor (when available):
            //   new apgl.LambertGrid(ni, nj, lon_sw, lat_sw, dx, dy, lat_0, lon_0, lat_1, lat_2)
            const { lat_0 = 25, lon_0 = -95, lat_1 = 25, lat_2 = 25 } = proj_params ?? {};
            
            if (typeof apgl.LambertGrid !== 'undefined') {
                return apgl.LambertGrid.fromLLCornerLonLat(ni, nj, lon_0, lat_0, lat_1, lon_min, lat_min, dx*1000., dy*1000.);
            }
            // Fallback until LambertGrid is in autumnplot-gl
            console.warn(
                `[GridFactory] LambertGrid not available in autumnplot-gl; ` +
                `falling back to PlateCarreeGrid for ${ni}×${nj} grid. ` +
                `Projection will be approximate.`
            );
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, lat_max, lon_max);
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
        
        case 'geostationary':
            if (typeof apgl.GeostationaryImage !== 'undefined') {
                console.warn(`[GridFactory] Creating GeostationaryImage grid with sat_lon=${sat_lon}, ll_x=${ll_x}, ll_y=${ll_y}, ur_x=${ur_x}, ur_y=${ur_y}`);
                return new apgl.GeostationaryImage(ni, nj, ll_x, ll_y, ur_x, ur_y, sat_lon);
            }
            console.warn(`[GridFactory] GeostationaryImage grid not available in autumnplot-gl; ` +
                         `falling back to PlateCarreeGrid for ${ni}×${nj} grid. ` +
                         `Projection will be approximate.`);
            return new apgl.PlateCarreeGrid(ni, nj, lon_min, lat_min, lon_max, lat_max);
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
