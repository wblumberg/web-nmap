/**
 * point.formatters.test.js
 *
 * Tests for the formatter functions defined in products/point.js.
 *
 * ─── Why test formatters? ────────────────────────────────────────────────────
 *
 * The formatter functions (fmtTemp, fmtMSLP, fmtAlti, etc.) are the logic
 * that converts raw numerical observation values into the short strings shown
 * on station plots. Getting these wrong produces incorrect map labels —
 * for example, displaying "103" for an MSLP of 1013.2 mb instead of "132".
 *
 * These are pure functions (input → output, no side effects), which makes
 * them ideal unit tests — no mocking needed.
 *
 * ─── How we test private functions ──────────────────────────────────────────
 *
 * The formatter functions in point.js are declared as `const` inside the
 * module (not exported). To test them in isolation we re-declare them here
 * identically. This is acceptable for pure utility functions; alternatively
 * you could export them from point.js and import them directly.
 */

import { describe, it, expect } from 'vitest';

// ─── Re-declare the formatter functions here for isolated testing ─────────────
// (These must stay in sync with the implementations in products/point.js)

const fmtTemp   = val => val === null || isNaN(val) ? '' : Math.round(val).toString();
const fmtDwpt   = val => val === null || isNaN(val) ? '' : Math.round(val).toString();
const fmtMSLP   = val => {
    if (val === null || isNaN(val)) return '';
    const encoded = Math.round(val * 10) % 1000;
    return encoded.toString().padStart(3, '0');
};
const fmtAlti   = val => {
    if (val === null || isNaN(val)) return '';
    const encoded = Math.round(val * 100) % 1000;
    return encoded.toString().padStart(3, '0');
};
const fmtVsby   = val => val === null || isNaN(val) ? '' : val.toFixed(1);
const fmtPrecip = val => (val === null || isNaN(val) || val === 0) ? '' : val.toFixed(2);
const fmtNum1   = val => val === null || isNaN(val) ? '' : val.toFixed(1);

// ════════════════════════════════════════════════════════════════════════════
// fmtTemp — temperature formatter
// ════════════════════════════════════════════════════════════════════════════

describe('fmtTemp', () => {
    // Temperature is displayed as a rounded integer with no decimal point.
    // This matches the classic station model appearance.

    it('rounds a positive float to integer string', () => {
        expect(fmtTemp(72.6)).toBe('73');
    });

    it('rounds a negative float to integer string', () => {
        expect(fmtTemp(-4.4)).toBe('-4');
    });

    it('returns empty string for null (missing observation)', () => {
        // Missing obs should display as blank, not "null" or "NaN"
        expect(fmtTemp(null)).toBe('');
    });

    it('returns empty string for NaN', () => {
        expect(fmtTemp(NaN)).toBe('');
    });

    it('handles exactly 0 degrees', () => {
        expect(fmtTemp(0)).toBe('0');
    });

    it('rounds 0.5 up to 1', () => {
        // JavaScript Math.round(0.5) = 1
        expect(fmtTemp(0.5)).toBe('1');
    });

    it('handles very cold temperatures', () => {
        expect(fmtTemp(-40)).toBe('-40');
    });

    it('handles very hot temperatures', () => {
        expect(fmtTemp(114.9)).toBe('115');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// fmtMSLP — mean sea level pressure formatter
// ════════════════════════════════════════════════════════════════════════════

describe('fmtMSLP', () => {
    // MSLP uses the WMO 3-digit encoding:
    //   Take pressure in mb (hPa), multiply by 10, take last 3 digits.
    //   1013.2 mb → 10132 → last 3 digits → 132
    //   982.4 mb  → 9824  → last 3 digits → 824
    //   1001.8 mb → 10018 → last 3 digits → 018  (padded to 3 digits)
    //
    // This encoding lets you reconstruct the pressure:
    //   If last digit < 5: prepend 10, e.g. 132 → 1013.2
    //   If last digit >= 5: prepend 9, e.g. 824 → 982.4
    // (This decoding logic lives in the receiver, not here)

    it('encodes 1013.2 mb as "132"', () => {
        expect(fmtMSLP(1013.2)).toBe('132');
    });

    it('encodes 982.4 mb as "824"', () => {
        expect(fmtMSLP(982.4)).toBe('824');
    });

    it('encodes 1001.8 mb as "018" (with leading zero)', () => {
        // Leading zeros are important! "018" not "18"
        expect(fmtMSLP(1001.8)).toBe('018');
    });

    it('encodes exactly 1000.0 mb as "000"', () => {
        expect(fmtMSLP(1000.0)).toBe('000');
    });

    it('encodes 1020.0 mb as "200"', () => {
        expect(fmtMSLP(1020.0)).toBe('200');
    });

    it('returns empty string for null', () => {
        expect(fmtMSLP(null)).toBe('');
    });

    it('returns empty string for NaN', () => {
        expect(fmtMSLP(NaN)).toBe('');
    });

    it('always produces exactly 3 characters', () => {
        // Test a range of typical pressures
        [980.0, 1000.0, 1013.2, 1025.0, 990.5].forEach(p => {
            const result = fmtMSLP(p);
            expect(result.length).toBe(3);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// fmtAlti — altimeter setting formatter
// ════════════════════════════════════════════════════════════════════════════

describe('fmtAlti', () => {
    // Altimeter setting is encoded similarly to MSLP but in inHg:
    //   29.92 inHg → multiply by 100 → 2992 → last 3 digits → 992
    //   30.12 inHg → multiply by 100 → 3012 → last 3 digits → 012

    it('encodes 29.92 inHg as "992"', () => {
        expect(fmtAlti(29.92)).toBe('992');
    });

    it('encodes 30.12 inHg as "012" (with leading zero)', () => {
        expect(fmtAlti(30.12)).toBe('012');
    });

    it('encodes 30.00 inHg as "000"', () => {
        expect(fmtAlti(30.00)).toBe('000');
    });

    it('returns empty string for null', () => {
        expect(fmtAlti(null)).toBe('');
    });

    it('always produces exactly 3 characters', () => {
        [28.50, 29.92, 30.00, 30.50, 31.00].forEach(a => {
            expect(fmtAlti(a).length).toBe(3);
        });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// fmtVsby — visibility formatter
// ════════════════════════════════════════════════════════════════════════════

describe('fmtVsby', () => {
    // Visibility is shown to one decimal place in miles.

    it('shows one decimal place', () => {
        expect(fmtVsby(10.0)).toBe('10.0');
    });

    it('shows fractional visibility', () => {
        expect(fmtVsby(0.25)).toBe('0.3');  // rounded to 1 decimal
    });

    it('shows zero visibility as "0.0"', () => {
        expect(fmtVsby(0)).toBe('0.0');
    });

    it('returns empty string for null', () => {
        expect(fmtVsby(null)).toBe('');
    });

    it('returns empty string for NaN', () => {
        expect(fmtVsby(NaN)).toBe('');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// fmtPrecip — precipitation formatter
// ════════════════════════════════════════════════════════════════════════════

describe('fmtPrecip', () => {
    // Precipitation is shown to 2 decimal places in inches.
    // Zero and missing are both shown as blank (to keep the station plot clean
    // when there's no precipitation — which is most of the time).

    it('shows non-zero precip to 2 decimal places', () => {
        expect(fmtPrecip(0.25)).toBe('0.25');
    });

    it('shows trace amounts (very small but non-zero)', () => {
        expect(fmtPrecip(0.01)).toBe('0.01');
    });

    it('returns empty string for zero (no precip to display)', () => {
        // Zero precip is extremely common — blank keeps the station model clean
        expect(fmtPrecip(0)).toBe('');
    });

    it('returns empty string for null (missing)', () => {
        expect(fmtPrecip(null)).toBe('');
    });

    it('returns empty string for NaN', () => {
        expect(fmtPrecip(NaN)).toBe('');
    });

    it('shows heavy rain amounts correctly', () => {
        expect(fmtPrecip(2.47)).toBe('2.47');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// fmtNum1 — generic 1-decimal formatter
// ════════════════════════════════════════════════════════════════════════════

describe('fmtNum1', () => {
    it('shows value to 1 decimal place', () => {
        expect(fmtNum1(3.7)).toBe('3.7');
    });

    it('shows integer values with .0 suffix', () => {
        expect(fmtNum1(5)).toBe('5.0');
    });

    it('returns empty string for null', () => {
        expect(fmtNum1(null)).toBe('');
    });

    it('handles negative values', () => {
        expect(fmtNum1(-2.3)).toBe('-2.3');
    });
});
