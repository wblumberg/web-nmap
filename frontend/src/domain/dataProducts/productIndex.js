// Barrel file — analogous to the full mod_res.tbl combined.
// Each imported module is one "group" of NMAP2 restore configurations.

import basic         from './basic.js';
import instability   from './instability.js';
import moisture      from './moisture.js';
import shear         from './shear.js';
import precipitation from './precipitation.js';
import lift          from './lift.js';
import composite     from './composite.js';
import raster        from './raster.js';
import point         from './point.js';
import misc          from './misc.js';

// Merge all groups into a single flat registry.
// Duplicate IDs across files will throw at import time (good — fail loudly).
export const PRODUCT_SUITES = {
    ...basic,
    ...instability,
    ...moisture,
    ...shear,
    ...precipitation,
    ...lift,
    ...composite,
    ...raster,
    ...point,
    ...misc,
};

// Define the order of product groups for display in the UI.
export const PRODUCT_GROUPS = {
    basic: "1.) Basic Products",
    moisture: "2.) Moisture Products",
    instability: "3.) Instability Products",
    shear: "4.) Shear Products",
    lift: "5.) Lift Products",
    precipitation: "6.) Precipitation Products",
    composite: "7.) Composite Products",
    raster: "8.) Raster Products",
    point: "9.) Point Products",
    misc: "10.) Miscellaneous Products",
    
    goes_conus: "GOES CONUS Products",
    goes_fdisk: "GOES Full Disk Products",
    goes_meso1: "GOES Mesoscale Sector 1 Products",
    goes_meso2: "GOES Mesoscale Sector 2 Products",
    mrms_conus: "MRMS CONUS",
    mrms_alaska: "MRMS Alaska",
    mrms_hawaii: "MRMS Hawaii",
    mrms_guam: "MRMS Guam"
};

/**
 * Returns a list of all unique datasets that have product functions available.
 * Aggregates the "available_for" field from each product.
 * @returns {string[]} Array of unique dataset names (e.g., ['GFS', 'NAM', 'HRRR', 'RAP'])
 */
export function getAvailableDatasets() {
    const datasets = new Set();
    
    Object.values(PRODUCT_SUITES).forEach(product => {
        if (product.available_for && Array.isArray(product.available_for)) {
            product.available_for.forEach(dataset => datasets.add(dataset));
        }
    });
    
    return Array.from(datasets).sort();
}

export default PRODUCT_SUITES;

