// Shared utility functions for dataProducts

/**
 * Apply a 2D binomial (1-2-1) smoothing kernel to a flat row-major data array.
 * Each pass approximates one application of a Gaussian with σ ≈ 0.85 grid lengths.
 * Use 3–4 passes for 40 km grids to get AWIPS-style smooth contours.
 * The boundary rows/columns are left unchanged (no wrap-around assumed).
 *
 * @param {Float32Array|Float16Array} data   - source array, length nx*ny
 * @param {number} nx      - number of columns (fast dimension)
 * @param {number} ny      - number of rows
 * @param {number} passes  - number of smoothing iterations (default 3)
 * @param {number} missing - sentinel value treated as missing data (default -9999)
 * @returns {Float32Array} smoothed copy
 */
export function smooth2D(data, nx, ny, passes = 3, missing = -9999) {
    let arr = new Float32Array(data);
    // Convert sentinel missing values to NaN so they are excluded from the kernel
    for (let k = 0; k < arr.length; k++) {
        if (arr[k] === missing) arr[k] = NaN;
    }
    for (let p = 0; p < passes; p++) {
        const tmp = new Float32Array(arr);
        for (let j = 1; j < ny - 1; j++) {
            for (let i = 1; i < nx - 1; i++) {
                const idx = j * nx + i;
                if (isNaN(arr[idx])) continue;
                const neighbors = [
                    [arr[idx],          4],
                    [arr[idx - 1],      2],
                    [arr[idx + 1],      2],
                    [arr[idx - nx],     2],
                    [arr[idx + nx],     2],
                    [arr[idx - nx - 1], 1],
                    [arr[idx - nx + 1], 1],
                    [arr[idx + nx - 1], 1],
                    [arr[idx + nx + 1], 1],
                ];
                let sum = 0, weightSum = 0;
                for (const [val, w] of neighbors) {
                    if (!isNaN(val)) {
                        sum += val * w;
                        weightSum += w;
                    }
                }
                tmp[idx] = weightSum > 0 ? sum / weightSum : NaN;
            }
        }
        arr = tmp;
    }
    return arr;
}

/**
 * Return true as soon as a typed/regular array contains a usable number.
 * The early exit keeps valid fields cheap; an entirely missing field is scanned
 * once so expensive downstream contour construction can be avoided.
 */
export function hasFiniteValues(data) {
    if (!data || typeof data.length !== 'number') return false;
    for (let i = 0; i < data.length; i++) {
        if (Number.isFinite(data[i])) return true;
    }
    return false;
}
