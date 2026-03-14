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

// Merge all groups into a single flat registry.
// Duplicate IDs across files will throw at import time (good — fail loudly).
const PRODUCT_SUITES = {
    ...basic,
    ...instability,
    ...moisture,
    ...shear,
    ...precipitation,
    ...lift,
    ...composite,
    ...raster,
    ...point,
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

