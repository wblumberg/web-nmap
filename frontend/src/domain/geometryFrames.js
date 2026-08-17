import { estimateValueBytes } from '../services/mapDiagnostics.js';

export const GEOMETRY_DIAGNOSTICS = Symbol('geometryDiagnostics');

function featureIdentity(feature) {
    const p = feature?.properties ?? {};
    const stableId = p.canonical_key ?? p.event_id ?? null;
    if (stableId != null) return `id:${stableId}`;
    if (p.etn != null && p.phen) {
        return `vtec:${p.phen}:${p.significance ?? ''}:${p.etn}:${p.office ?? (p.offices ?? []).join(',')}`;
    }
    return null;
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
    }
    return true;
}

function countCoordinates(value) {
    if (!Array.isArray(value)) return 0;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return 1;
    return value.reduce((sum, child) => sum + countCoordinates(child), 0);
}

function frameStats(data, sharedBytes = 0, sharedFeatures = 0) {
    let featureCount = 0;
    let coordinateCount = 0;
    for (const value of Object.values(data ?? {})) {
        for (const feature of value?.features ?? []) {
            featureCount++;
            coordinateCount += countCoordinates(feature?.geometry?.coordinates);
        }
    }
    const logicalBytes = estimateValueBytes(data);
    return {
        featureCount,
        coordinateCount,
        logicalBytes,
        sharedBytes,
        sharedFeatures,
        retainedBytes: Math.max(0, logicalBytes - sharedBytes),
    };
}

/**
 * Reuse immutable feature objects that are identical in adjacent frames.
 * This preserves separate FeatureCollections and frame membership while their
 * expensive coordinate/property graphs share one JS object identity.
 */
export function shareAdjacentGeometryData(previous, current) {
    if (!current || typeof current !== 'object') return current;
    const priorBySlug = new Map();
    for (const [slug, fc] of Object.entries(previous ?? {})) {
        const byId = new Map();
        for (const feature of fc?.features ?? []) {
            const id = featureIdentity(feature);
            if (id) byId.set(id, feature);
        }
        priorBySlug.set(slug, byId);
    }

    let sharedBytes = 0;
    let sharedFeatures = 0;
    for (const [slug, fc] of Object.entries(current)) {
        if (!Array.isArray(fc?.features)) continue;
        const previousFeatures = priorBySlug.get(slug);
        if (!previousFeatures?.size) continue;
        fc.features = fc.features.map(feature => {
            const prior = previousFeatures.get(featureIdentity(feature));
            if (!prior || !deepEqual(prior, feature)) return feature;
            sharedBytes += estimateValueBytes(feature);
            sharedFeatures++;
            return prior;
        });
    }

    Object.defineProperty(current, GEOMETRY_DIAGNOSTICS, {
        value: frameStats(current, sharedBytes, sharedFeatures),
        configurable: true,
    });
    return current;
}

export function ensureGeometryDiagnostics(data) {
    if (!data || typeof data !== 'object') return null;
    if (!data[GEOMETRY_DIAGNOSTICS]) {
        Object.defineProperty(data, GEOMETRY_DIAGNOSTICS, {
            value: frameStats(data),
            configurable: true,
        });
    }
    return data[GEOMETRY_DIAGNOSTICS];
}
