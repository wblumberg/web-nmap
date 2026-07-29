/**
 * titleResolver.js — Resolves title template strings for map products.
 *
 * Placeholder syntax:
 *   {valid_YYYY}  — valid time: 4-digit year
 *   {valid_MM}    — valid time: 2-digit month (01–12)
 *   {valid_DD}    — valid time: 2-digit day   (01–31)
 *   {valid_HH}    — valid time: 2-digit hour  (00–23, UTC)
 *   {valid_mm}    — valid time: 2-digit minute (00–59)
 *   {valid_ss}    — valid time: 2-digit second (00–59)
 *   {cycle_YYYY}  — cycle time: 4-digit year            (forecast sources only)
 *   {cycle_MM}    — cycle time: 2-digit month (01–12)   (forecast sources only)
 *   {cycle_DD}    — cycle time: 2-digit day   (01–31)   (forecast sources only)
 *   {cycle_HH}    — cycle time: 2-digit hour  (00–23)   (forecast sources only)
 *   {cycle_mm}    — cycle time: 2-digit minute (00–59)  (forecast sources only)
 *   {fhr}         — forecast hour (integer, e.g. 12)    (forecast sources only)
 *   {fhr3}        — forecast hour zero-padded to 3 digits (e.g. 012)
 *   {source}      — data source ID (e.g. 'GFS', 'MESOANALYSIS_GRID')
 *
 * Any placeholders that cannot be resolved (missing context data) are silently
 * stripped from the output.  Multiple consecutive spaces produced by stripping
 * are collapsed to at most two spaces so the spacing stays readable.
 */

const _pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * @param {string} template
 * @param {object} context
 * @param {Date}        context.validTime   - frame's valid time (always required)
 * @param {Date|null}   [context.cycleTime] - model cycle time (forecast sources only)
 * @param {number|null} [context.fhr]       - forecast hour integer (forecast sources only)
 * @param {string|null} [context.sourceId]  - data source ID
 * @returns {string}
 */
export function resolveTitle(template, { validTime, cycleTime = null, fhr = null, sourceId = null } = {}) {
    if (!template) return '';
    let out = template;

    if (validTime instanceof Date && Number.isFinite(validTime.getTime())) {
        out = out
            .replaceAll('{valid_YYYY}', _pad(validTime.getUTCFullYear(), 4))
            .replaceAll('{valid_MM}',   _pad(validTime.getUTCMonth() + 1))
            .replaceAll('{valid_DD}',   _pad(validTime.getUTCDate()))
            .replaceAll('{valid_HH}',   _pad(validTime.getUTCHours()))
            .replaceAll('{valid_mm}',   _pad(validTime.getUTCMinutes()))
            .replaceAll('{valid_ss}',   _pad(validTime.getUTCSeconds()));
    }

    if (cycleTime instanceof Date && Number.isFinite(cycleTime.getTime())) {
        out = out
            .replaceAll('{cycle_YYYY}', _pad(cycleTime.getUTCFullYear(), 4))
            .replaceAll('{cycle_MM}',   _pad(cycleTime.getUTCMonth() + 1))
            .replaceAll('{cycle_DD}',   _pad(cycleTime.getUTCDate()))
            .replaceAll('{cycle_HH}',   _pad(cycleTime.getUTCHours()))
            .replaceAll('{cycle_mm}',   _pad(cycleTime.getUTCMinutes()));
    }

    if (fhr !== null && Number.isFinite(fhr)) {
        out = out
            .replaceAll('{fhr}',  String(fhr))
            .replaceAll('{fhr3}', _pad(fhr, 3));
    }

    if (sourceId != null) {
        out = out.replaceAll('{source}', String(sourceId));
    }

    // Strip any remaining unresolved {placeholders} and normalise whitespace
    out = out.replace(/\{[a-zA-Z_0-9]+\}/g, '').replace(/[ \t]{2,}/g, '  ').trim();

    return out;
}
