/**
 * TimeMatchingEngine.test.js
 *
 * ─── What is a unit test? ────────────────────────────────────────────────────
 *
 * A unit test checks that one small piece of code (a "unit" — usually a single
 * function) behaves correctly for a known set of inputs.
 *
 * The pattern for every test is:
 *   1. ARRANGE  — set up the inputs
 *   2. ACT      — call the function
 *   3. ASSERT   — check the output matches what we expected
 *
 * ─── Vitest API used here ────────────────────────────────────────────────────
 *
 * describe(name, fn)    — groups related tests together under a heading
 * it(name, fn)          — defines one individual test case
 * expect(value)         — starts an assertion chain
 *   .toBe(x)            — strict equality (===)
 *   .toEqual(x)         — deep equality (checks nested objects/arrays)
 *   .toBeCloseTo(x, d)  — floating-point comparison within d decimal places
 *   .toThrow()          — expects the function to throw an error
 *   .toContain(x)       — checks an array contains x
 *   .toBeLessThan(x)    — numeric comparison
 *   .toBeGreaterThan(x) — numeric comparison
 */

import { describe, it, expect } from 'vitest';

import {
    parseCycle,
    parseValidTime,
    keyToEpochMs,
    findBestMatch,
    buildMatchMap,
    epochMsToLabel,
} from '../TimeMatchingEngine.js';

// ════════════════════════════════════════════════════════════════════════════
// parseCycle
// ════════════════════════════════════════════════════════════════════════════

describe('parseCycle', () => {
    // parseCycle converts a model cycle string like '2025030218' into a
    // JavaScript Date object. This is the foundation of all time matching.

    it('parses a standard cycle string to the correct UTC date', () => {
        // ARRANGE: a typical GFS cycle string
        const cycle = '2025030200';

        // ACT: call the function
        const result = parseCycle(cycle);

        // ASSERT: the Date should represent 2025-03-02 00:00 UTC
        expect(result.getUTCFullYear()).toBe(2025);
        expect(result.getUTCMonth()).toBe(2);    // months are 0-indexed: 2 = March
        expect(result.getUTCDate()).toBe(2);
        expect(result.getUTCHours()).toBe(0);
    });

    it('parses a cycle at 18Z correctly', () => {
        const result = parseCycle('2025030218');
        expect(result.getUTCHours()).toBe(18);
        expect(result.getUTCDate()).toBe(2);
    });

    it('parses a cycle that crosses a month boundary', () => {
        // March 31 → April 1 boundary
        const result = parseCycle('2025033100');
        expect(result.getUTCMonth()).toBe(2);    // March (0-indexed)
        expect(result.getUTCDate()).toBe(31);
    });

    it('returns a Date object (not a string or number)', () => {
        const result = parseCycle('2025030200');
        // `instanceof Date` returns true only for real Date objects
        expect(result instanceof Date).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// parseValidTime
// ════════════════════════════════════════════════════════════════════════════

describe('parseValidTime', () => {
    // parseValidTime handles the two common valid-time string formats:
    //   '20250302_1800'  (with underscore separator)
    //   '202503021800'   (without separator)

    it('parses a valid time with underscore separator', () => {
        const result = parseValidTime('20250302_1800');
        expect(result.getUTCFullYear()).toBe(2025);
        expect(result.getUTCMonth()).toBe(2);     // March
        expect(result.getUTCDate()).toBe(2);
        expect(result.getUTCHours()).toBe(18);
        expect(result.getUTCMinutes()).toBe(0);
    });

    it('parses a valid time without underscore separator', () => {
        const result = parseValidTime('202503021800');
        expect(result.getUTCHours()).toBe(18);
        expect(result.getUTCDate()).toBe(2);
    });

    it('parses minutes correctly for sub-hourly valid times', () => {
        // MRMS data is sometimes available every 2 minutes
        const result = parseValidTime('20250302_1832');
        expect(result.getUTCHours()).toBe(18);
        expect(result.getUTCMinutes()).toBe(32);
    });

    it('produces the same result whether underscore is present or not', () => {
        const with_us    = parseValidTime('20250302_1800');
        const without_us = parseValidTime('202503021800');
        // Both should give the same epoch milliseconds
        expect(with_us.getTime()).toBe(without_us.getTime());
    });
});

// ════════════════════════════════════════════════════════════════════════════
// keyToEpochMs
// ════════════════════════════════════════════════════════════════════════════

describe('keyToEpochMs', () => {
    // keyToEpochMs is the bridge between a MultiPlotLayer key string and a
    // comparable epoch millisecond value. This is what makes time matching
    // possible across different data sources that use different key formats.

    it('converts a forecast-hour key to epoch ms correctly', () => {
        // A GFS run starting at 2025-03-02 00Z, forecast hour 6
        // The valid time should be 2025-03-02 06Z
        const descriptor = {
            type:  'fhr',
            cycle: '2025030200',
            keys:  ['000', '006', '012'],
        };

        const result = keyToEpochMs('006', descriptor);

        // Expected: 2025-03-02 06:00 UTC as epoch ms
        const expected = new Date('2025-03-02T06:00:00Z').getTime();
        expect(result).toBe(expected);
    });

    it('forecast hour 0 gives the same time as the cycle', () => {
        const descriptor = {
            type:  'fhr',
            cycle: '2025030200',
            keys:  ['000'],
        };
        const result   = keyToEpochMs('000', descriptor);
        const expected = new Date('2025-03-02T00:00:00Z').getTime();
        expect(result).toBe(expected);
    });

    it('converts a valid-time key to epoch ms correctly', () => {
        const descriptor = {
            type: 'valid_time',
            keys: ['20250302_1800', '20250302_1900'],
        };
        const result   = keyToEpochMs('20250302_1800', descriptor);
        const expected = new Date('2025-03-02T18:00:00Z').getTime();
        expect(result).toBe(expected);
    });

    it('throws an error for an unknown descriptor type', () => {
        const badDescriptor = { type: 'unknown', keys: ['000'] };
        // expect(...).toThrow() verifies that calling the function throws
        // rather than silently failing or returning a wrong value
        expect(() => keyToEpochMs('000', badDescriptor)).toThrow();
    });

    it('handles forecast hour 48 spanning two days', () => {
        const descriptor = {
            type:  'fhr',
            cycle: '2025030200',
            keys:  ['048'],
        };
        const result   = keyToEpochMs('048', descriptor);
        const expected = new Date('2025-03-04T00:00:00Z').getTime();
        expect(result).toBe(expected);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// findBestMatch
// ════════════════════════���═══════════════════════════════════════════════════

describe('findBestMatch', () => {
    // findBestMatch is the heart of time matching. Given a dominant source's
    // active time and a secondary source's list of available times, it finds
    // the secondary key whose valid time is closest to the dominant's time.
    //
    // This replicates NMAP2's time-matching behavior when looping with
    // multiple data sources.

    // ── Set up descriptors reused across several tests ──────────────────────

    // Dominant: RAP analysis, hourly from 00Z to 12Z on 2025-03-02
    const rapDescriptor = {
        type:  'fhr',
        cycle: '2025030200',
        keys:  ['000', '001', '002', '003', '004', '005', '006',
                '007', '008', '009', '010', '011', '012'],
    };

    // Secondary: MRMS obs, every 5 minutes from 00:00 to 00:20 UTC
    const mrmsDescriptor = {
        type: 'valid_time',
        keys: ['20250302_0000', '20250302_0005', '20250302_0010',
               '20250302_0015', '20250302_0020'],
    };

    // Secondary: GFS, every 6 hours
    const gfsDescriptor = {
        type:  'fhr',
        cycle: '2025030200',
        keys:  ['000', '006', '012', '018', '024'],
    };

    it('exact match: returns the same valid time when available', () => {
        // RAP hour 0 = 2025-03-02 00:00 UTC
        // MRMS has a 00:00 valid time — should be an exact match
        const result = findBestMatch('000', rapDescriptor, mrmsDescriptor.keys, mrmsDescriptor);
        expect(result).toBe('20250302_0000');
    });

    it('nearest match: returns the closest available time when no exact match', () => {
        // RAP hour 3 = 2025-03-02 03:00 UTC
        // MRMS only goes up to 00:20 UTC — closest is the last available: 00:20
        const result = findBestMatch('003', rapDescriptor, mrmsDescriptor.keys, mrmsDescriptor);
        expect(result).toBe('20250302_0020');
    });

    it('matches across different source types (fhr vs valid_time)', () => {
        // RAP hour 6 = 2025-03-02 06:00 UTC
        // GFS keys: 000=00Z, 006=06Z, 012=12Z → exact match at 006
        const result = findBestMatch('006', rapDescriptor, gfsDescriptor.keys, gfsDescriptor);
        expect(result).toBe('006');
    });

    it('picks earlier time on a tie (NMAP2 convention)', () => {
        // RAP hour 3 = 2025-03-02 03:00 UTC
        // GFS has 000 (00Z, 3hrs before) and 006 (06Z, 3hrs after) — both
        // are exactly 3 hours away. Should pick 000 (earlier) on tie.
        const result = findBestMatch('003', rapDescriptor, gfsDescriptor.keys, gfsDescriptor);
        expect(result).toBe('000');
    });

    it('works when secondary has only one key (always returns that key)', () => {
        // If MRMS only has one valid time, there is nothing to match — always
        // return that single key regardless of dominant time
        const singleKeyDescriptor = {
            type: 'valid_time',
            keys: ['20250302_1200'],
        };
        const result = findBestMatch('000', rapDescriptor,
                                     singleKeyDescriptor.keys, singleKeyDescriptor);
        expect(result).toBe('20250302_1200');
    });

    it('works when dominant and secondary are both fhr types on different cycles', () => {
        // Dominant: NAM 00Z cycle, hour 3 = 03Z valid
        const namDescriptor = {
            type:  'fhr',
            cycle: '2025030200',
            keys:  ['000', '003', '006'],
        };
        // Secondary: HRRR 01Z cycle, hours 0-5 → valid times 01Z-06Z
        const hrrrDescriptor = {
            type:  'fhr',
            cycle: '2025030201',  // 01Z cycle
            keys:  ['000', '001', '002', '003', '004', '005'],
        };
        // NAM hour 3 valid = 03Z
        // HRRR 01Z + 002 = 03Z → exact match
        const result = findBestMatch('003', namDescriptor, hrrrDescriptor.keys, hrrrDescriptor);
        expect(result).toBe('002');
    });

    it('throws when secondaryKeys is empty', () => {
        expect(() => findBestMatch('000', rapDescriptor, [], mrmsDescriptor))
            .toThrow();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// buildMatchMap
// ════════════════════════════════════════════════════════════════════════════

describe('buildMatchMap', () => {
    // buildMatchMap pre-computes ALL time matches upfront so that time-stepping
    // at runtime is a pure O(1) lookup. Think of it as a lookup table:
    //   matchMap[dominantKey][secondarySourceId] = bestMatchKey

    // Dominant: RAP analysis, 3 hourly steps
    const rapDescriptor = {
        type:  'fhr',
        cycle: '2025030200',
        keys:  ['000', '003', '006'],
    };

    // Secondary source A: MRMS, valid-time observations every 5 minutes
    const mrmsDescriptor = {
        type: 'valid_time',
        keys: ['20250302_0000', '20250302_0005', '20250302_0300'],
    };

    // Secondary source B: GFS, 6-hourly
    const gfsDescriptor = {
        type:  'fhr',
        cycle: '2025030200',
        keys:  ['000', '006'],
    };

    it('returns an object with one entry per dominant key', () => {
        const secondarySources = { mrms: mrmsDescriptor };
        const matchMap = buildMatchMap(rapDescriptor, secondarySources);

        // Should have entries for every dominant key
        expect(Object.keys(matchMap)).toEqual(['000', '003', '006']);
    });

    it('each dominant key has one entry per secondary source', () => {
        const secondarySources = { mrms: mrmsDescriptor, gfs: gfsDescriptor };
        const matchMap = buildMatchMap(rapDescriptor, secondarySources);

        // Every dominant key should have both 'mrms' and 'gfs' entries
        for (const dominantKey of rapDescriptor.keys) {
            expect(matchMap[dominantKey]).toHaveProperty('mrms');
            expect(matchMap[dominantKey]).toHaveProperty('gfs');
        }
    });

    it('produces correct matches for hour 000', () => {
        const secondarySources = { mrms: mrmsDescriptor, gfs: gfsDescriptor };
        const matchMap = buildMatchMap(rapDescriptor, secondarySources);

        // RAP hour 000 = 2025-03-02 00:00 UTC
        // MRMS: '20250302_0000' is an exact match
        expect(matchMap['000']['mrms']).toBe('20250302_0000');
        // GFS: '000' is an exact match
        expect(matchMap['000']['gfs']).toBe('000');
    });

    it('produces correct matches for hour 003', () => {
        const secondarySources = { mrms: mrmsDescriptor, gfs: gfsDescriptor };
        const matchMap = buildMatchMap(rapDescriptor, secondarySources);

        // RAP hour 003 = 2025-03-02 03:00 UTC
        // MRMS: '20250302_0300' is an exact match
        expect(matchMap['003']['mrms']).toBe('20250302_0300');
        // GFS: 000=00Z (3h before) vs 006=06Z (3h after) → tie → picks 000
        expect(matchMap['003']['gfs']).toBe('000');
    });

    it('returns an empty object when secondarySources is empty', () => {
        const matchMap = buildMatchMap(rapDescriptor, {});
        // Each dominant key should map to an empty object
        for (const key of rapDescriptor.keys) {
            expect(matchMap[key]).toEqual({});
        }
    });

    it('the match map is a plain object (can be JSON-serialized)', () => {
        const secondarySources = { mrms: mrmsDescriptor };
        const matchMap = buildMatchMap(rapDescriptor, secondarySources);
        // If JSON.stringify doesn't throw, it's a plain serializable object
        expect(() => JSON.stringify(matchMap)).not.toThrow();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// epochMsToLabel
// ���═══════════════════════════════════════════════════════════════════════════

describe('epochMsToLabel', () => {
    // epochMsToLabel turns a raw epoch milliseconds value into a human-readable
    // string for display in the UI's time readout.

    it('formats a known UTC time correctly', () => {
        const ms     = new Date('2025-03-02T18:30:00Z').getTime();
        const result = epochMsToLabel(ms);
        expect(result).toBe('2025-03-02 18:30 UTC');
    });

    it('pads single-digit months and days with a leading zero', () => {
        // January 5th = month 01, day 05
        const ms     = new Date('2025-01-05T06:00:00Z').getTime();
        const result = epochMsToLabel(ms);
        expect(result).toBe('2025-01-05 06:00 UTC');
    });

    it('always appends "UTC" to the label', () => {
        const ms     = new Date('2025-06-15T12:00:00Z').getTime();
        const result = epochMsToLabel(ms);
        expect(result).toContain('UTC');
    });

    it('handles midnight correctly (00:00)', () => {
        const ms     = new Date('2025-03-02T00:00:00Z').getTime();
        const result = epochMsToLabel(ms);
        expect(result).toBe('2025-03-02 00:00 UTC');
    });
});
