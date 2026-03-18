/**
 * timematcher.js — Time matching utilities for web-nmap data products.
 *
 * Provides deterministic matching of source/product valid times to a master
 * timeline (e.g., dominant source frames in LayerManager).
 *
 * Public API:
 *   TimeMatcher.normalizeTimes(times)
 *   TimeMatcher.findNearest(targetTime, candidateTimes, opts)
 *   TimeMatcher.matchSeries(masterTimes, sourceTimes, opts)
 *
 * Notes:
 * - Inputs may be Date, ISO strings, epoch ms, or objects with a valid date at
 *   one of: .valid, .time, .dt, .timestamp
 * - Output records always include Date objects (UTC-aware via JS Date)
 */
'use strict';

const TimeMatcher = (() => {

    function _toDate(value) {
        if (value instanceof Date) {
            return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
        }
        if (typeof value === 'number') {
            const d = new Date(value);
            return Number.isFinite(d.getTime()) ? d : null;
        }
        if (typeof value === 'string') {
            const d = new Date(value);
            return Number.isFinite(d.getTime()) ? d : null;
        }
        if (value && typeof value === 'object') {
            for (const k of ['valid', 'time', 'dt', 'timestamp']) {
                if (value[k] == null) continue;
                const d = _toDate(value[k]);
                if (d) return d;
            }
        }
        return null;
    }

    function _uniqSortDates(dates) {
        const seen = new Set();
        const out = [];
        for (const d of dates) {
            const ms = d.getTime();
            if (seen.has(ms)) continue;
            seen.add(ms);
            out.push(d);
        }
        out.sort((a, b) => a.getTime() - b.getTime());
        return out;
    }

    function normalizeTimes(times) {
        if (!Array.isArray(times)) return [];
        const parsed = [];
        for (const t of times) {
            const d = _toDate(t);
            if (d) parsed.push(d);
        }
        return _uniqSortDates(parsed);
    }

    /**
     * Find the best candidate time for a target. 
     * NMAP2 allows for four modes:
     * - 'exact'   : only exact matches (1)
     * - 'backward': only before or equal times (2)
     * - 'forward' : only after or equal times (3)
     * - 'nearest' : closest time either before or after (4)
     *
     * @param {Date|string|number|object} targetTime
     * @param {Array<Date|string|number|object>} candidateTimes
     * @param {Object} [opts]
     * @param {'nearest'|'backward'|'forward'|'exact'} [opts.mode='nearest']
     * @param {number} [opts.toleranceMs=Infinity] - max allowed absolute delta
     * @param {'earlier'|'later'} [opts.tieBreak='earlier'] - for nearest ties
     * @returns {{matched:boolean, target:Date|null, matchedTime:Date|null, index:number, deltaMs:number|null}}
     */
    function findNearest(targetTime, candidateTimes, opts = {}) {
        const mode = opts.mode || 'nearest';
        const toleranceMs = Number.isFinite(opts.toleranceMs) ? Math.max(0, opts.toleranceMs) : Infinity;
        const tieBreak = opts.tieBreak === 'later' ? 'later' : 'earlier';

        const target = _toDate(targetTime);
        if (!target) {
            return { matched: false, target: null, matchedTime: null, index: -1, deltaMs: null };
        }

        const candidates = normalizeTimes(candidateTimes);
        if (!candidates.length) {
            return { matched: false, target, matchedTime: null, index: -1, deltaMs: null };
        }

        const tMs = target.getTime();
        let bestIdx = -1;
        let bestAbs = Infinity;
        let bestSigned = null;

        for (let i = 0; i < candidates.length; i++) {
            const cMs = candidates[i].getTime();
            const signed = cMs - tMs;
            const abs = Math.abs(signed);

            if (mode === 'exact' && abs !== 0) continue;
            if (mode === 'backward' && signed > 0) continue;
            if (mode === 'forward' && signed < 0) continue;

            if (abs < bestAbs) {
                bestAbs = abs;
                bestSigned = signed;
                bestIdx = i;
                continue;
            }

            if (abs === bestAbs && mode === 'nearest' && bestIdx !== -1) {
                if (tieBreak === 'earlier') {
                    if (signed < bestSigned) {
                        bestSigned = signed;
                        bestIdx = i;
                    }
                } else if (signed > bestSigned) {
                    bestSigned = signed;
                    bestIdx = i;
                }
            }
        }

        if (bestIdx === -1 || bestAbs > toleranceMs) {
            return { matched: false, target, matchedTime: null, index: -1, deltaMs: null };
        }

        return {
            matched: true,
            target,
            matchedTime: candidates[bestIdx],
            index: bestIdx,
            deltaMs: candidates[bestIdx].getTime() - tMs,
        };
    }

    /**
     * Match each master time to the best source time.
     *
     * @param {Array<Date|string|number|object>} masterTimes
     * @param {Array<Date|string|number|object>} sourceTimes
     * @param {Object} [opts] - same options as findNearest()
     * @returns {Array<{master:Date, matched:boolean, source:Date|null, sourceIndex:number, deltaMs:number|null}>}
     */
    function matchSeries(masterTimes, sourceTimes, opts = {}) {
        const masters = normalizeTimes(masterTimes);
        const sources = normalizeTimes(sourceTimes);

        return masters.map((master) => {
            const hit = findNearest(master, sources, opts);
            return {
                master,
                matched: hit.matched,
                source: hit.matched ? hit.matchedTime : null,
                sourceIndex: hit.index,
                deltaMs: hit.deltaMs,
            };
        });
    }

    return {
        normalizeTimes,
        findNearest,
        matchSeries,
    };
})();

window.TimeMatcher = TimeMatcher;
