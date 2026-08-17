import {getForecastProduct} from '../config/forecastSuites.js';

const EPSILON = 1e-10;

function _samePoint(a, b) {
    return Math.abs(a[0] - b[0]) <= EPSILON && Math.abs(a[1] - b[1]) <= EPSILON;
}

function _cross(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) -
        (b[1] - a[1]) * (c[0] - a[0]);
}

function _ringArea(ring) {
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    return twiceArea / 2;
}

function _normalizeRing(coords) {
    const ring = [];
    for (const coord of coords || []) {
        if (!Array.isArray(coord) || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) continue;
        const point = [Number(coord[0]), Number(coord[1])];
        if (!ring.length || !_samePoint(ring[ring.length - 1], point)) ring.push(point);
    }
    if (ring.length > 1 && _samePoint(ring[0], ring[ring.length - 1])) ring.pop();

    // Collinear vertices add numerical ambiguity to ear clipping but do not
    // change the polygon's covered area.
    let changed = true;
    while (changed && ring.length > 3) {
        changed = false;
        for (let i = 0; i < ring.length; i++) {
            const previous = ring[(i - 1 + ring.length) % ring.length];
            const current = ring[i];
            const next = ring[(i + 1) % ring.length];
            if (Math.abs(_cross(previous, current, next)) <= EPSILON) {
                ring.splice(i, 1);
                changed = true;
                break;
            }
        }
    }
    return ring;
}

function _pointInTriangle(point, a, b, c) {
    return _cross(a, b, point) >= -EPSILON &&
        _cross(b, c, point) >= -EPSILON &&
        _cross(c, a, point) >= -EPSILON;
}

/** Triangulate a simple polygon using ear clipping. */
function _triangulate(coords) {
    let ring = _normalizeRing(coords);
    if (ring.length < 3 || Math.abs(_ringArea(ring)) <= EPSILON) return [];
    if (_ringArea(ring) < 0) ring = [...ring].reverse();

    const remaining = ring.map((_, index) => index);
    const triangles = [];
    let guard = ring.length * ring.length;
    while (remaining.length > 3 && guard-- > 0) {
        let clipped = false;
        for (let i = 0; i < remaining.length; i++) {
            const previousIndex = remaining[(i - 1 + remaining.length) % remaining.length];
            const currentIndex = remaining[i];
            const nextIndex = remaining[(i + 1) % remaining.length];
            const a = ring[previousIndex];
            const b = ring[currentIndex];
            const c = ring[nextIndex];
            if (_cross(a, b, c) <= EPSILON) continue;

            const containsVertex = remaining.some(index =>
                index !== previousIndex && index !== currentIndex && index !== nextIndex &&
                _pointInTriangle(ring[index], a, b, c)
            );
            if (containsVertex) continue;

            triangles.push([a, b, c]);
            remaining.splice(i, 1);
            clipped = true;
            break;
        }
        if (!clipped) return [];
    }
    if (remaining.length === 3) {
        triangles.push(remaining.map(index => ring[index]));
    }
    return triangles;
}

function _lineIntersection(start, end, clipStart, clipEnd) {
    const subjectX = end[0] - start[0];
    const subjectY = end[1] - start[1];
    const clipX = clipEnd[0] - clipStart[0];
    const clipY = clipEnd[1] - clipStart[1];
    const denominator = subjectX * clipY - subjectY * clipX;
    if (Math.abs(denominator) <= EPSILON) return [...end];
    const t = ((clipStart[0] - start[0]) * clipY -
        (clipStart[1] - start[1]) * clipX) / denominator;
    return [start[0] + t * subjectX, start[1] + t * subjectY];
}

/** Clip one convex polygon by another; triangles are always convex and CCW. */
function _clipConvex(subject, clip) {
    let output = subject.map(point => [...point]);
    for (let i = 0; i < clip.length && output.length; i++) {
        const clipStart = clip[i];
        const clipEnd = clip[(i + 1) % clip.length];
        const input = output;
        output = [];
        let start = input[input.length - 1];
        for (const end of input) {
            const startInside = _cross(clipStart, clipEnd, start) >= -EPSILON;
            const endInside = _cross(clipStart, clipEnd, end) >= -EPSILON;
            if (endInside) {
                if (!startInside) output.push(_lineIntersection(start, end, clipStart, clipEnd));
                output.push(end);
            } else if (startInside) {
                output.push(_lineIntersection(start, end, clipStart, clipEnd));
            }
            start = end;
        }
    }
    return output;
}

function _bbox(coords) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    coords.forEach(([x, y]) => {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
    });
    return box;
}

/**
 * Return true only when two simple polygon rings share positive area.
 * Touching at an edge or vertex is valid and is not considered overlap.
 */
export function polygonInteriorsOverlap(coordsA, coordsB) {
    const ringA = _normalizeRing(coordsA);
    const ringB = _normalizeRing(coordsB);
    if (ringA.length < 3 || ringB.length < 3) return false;

    const boxA = _bbox(ringA);
    const boxB = _bbox(ringB);
    if (boxA[2] <= boxB[0] + EPSILON || boxB[2] <= boxA[0] + EPSILON ||
        boxA[3] <= boxB[1] + EPSILON || boxB[3] <= boxA[1] + EPSILON) {
        return false;
    }

    const trianglesA = _triangulate(ringA);
    const trianglesB = _triangulate(ringB);
    for (const triangleA of trianglesA) {
        for (const triangleB of trianglesB) {
            const intersection = _clipConvex(triangleA, triangleB);
            if (intersection.length >= 3 && Math.abs(_ringArea(intersection)) > EPSILON) {
                return true;
            }
        }
    }
    return false;
}

function _polygonArea(coords) {
    const triangles = _triangulate(coords);
    let area = 0;
    triangles.forEach(triangle => {
        area += Math.abs(_ringArea(triangle));
    });
    return area;
}

function _polygonIntersectionArea(coordsA, coordsB) {
    const ringA = _normalizeRing(coordsA);
    const ringB = _normalizeRing(coordsB);
    if (ringA.length < 3 || ringB.length < 3) return 0;

    const trianglesA = _triangulate(ringA);
    const trianglesB = _triangulate(ringB);
    let area = 0;

    for (const triangleA of trianglesA) {
        for (const triangleB of trianglesB) {
            const intersection = _clipConvex(triangleA, triangleB);
            if (intersection.length >= 3) area += Math.abs(_ringArea(intersection));
        }
    }
    return area;
}

function _levelValue(product, definition) {
    if (typeof product.levelValue === 'number' && Number.isFinite(product.levelValue)) {
        return product.levelValue;
    }
    const level = [...(definition.levels || []), ...(definition.overlays || [])]
        .find(item => item.id === product.levelId);
    if (typeof level?.rank === 'number' && Number.isFinite(level.rank)) return level.rank;
    return typeof level?.value === 'number' && Number.isFinite(level.value) ? level.value : null;
}

function _containsPolygon(outerCoords, innerCoords) {
    const innerArea = _polygonArea(innerCoords);
    if (innerArea <= EPSILON) return false;
    const overlapArea = _polygonIntersectionArea(outerCoords, innerCoords);
    return overlapArea >= innerArea - EPSILON;
}

function _levelName(product) {
    return product.levelLabel || product.label || product.levelId || `Product ${product.id}`;
}

/** Check mutually exclusive levels within each configured forecast product. */
export function validateForecastProducts(products) {
    const contours = (products || []).filter(product =>
        product.kind === 'contour' && product.suiteId && product.forecastProductId &&
        Array.isArray(product.coords) && product.coords.length >= 4
    );
    const issues = [];

    for (let i = 0; i < contours.length; i++) {
        const first = contours[i];
        const definition = getForecastProduct(first.suiteId, first.forecastProductId);
        if (!definition) continue;

        for (let j = i + 1; j < contours.length; j++) {
            const second = contours[j];
            if (first.suiteId !== second.suiteId ||
                first.forecastProductId !== second.forecastProductId) continue;

            const sameLevel = first.levelId === second.levelId;
            const bothOverlays = first.forecastRole === 'overlay' && second.forecastRole === 'overlay';
            const eitherOverlay = first.forecastRole === 'overlay' || second.forecastRole === 'overlay';
            const shouldBeExclusive = definition.rules?.spatialMode === 'exclusive' && !eitherOverlay;
            const rejectSameLevel = definition.rules?.preventSameLevelOverlap === true &&
                sameLevel && (!eitherOverlay || bothOverlays);
            if (!shouldBeExclusive && !rejectSameLevel) continue;
            if (!polygonInteriorsOverlap(first.coords, second.coords)) continue;

            const firstLevel = _levelName(first);
            const secondLevel = _levelName(second);
            issues.push({
                severity: 'error',
                code: sameLevel ? 'same-level-overlap' : 'cross-level-overlap',
                suiteId: first.suiteId,
                forecastProductId: first.forecastProductId,
                forecastProductLabel: definition.label,
                productIds: [first.id, second.id],
                levelIds: [first.levelId, second.levelId],
                message: sameLevel
                    ? `${definition.label}: two ${firstLevel} areas overlap.`
                    : `${definition.label}: ${firstLevel} overlaps ${secondLevel}.`,
            });
        }
    }

    const bySuiteProduct = new Map();
    contours.forEach(contour => {
        const key = `${contour.suiteId}::${contour.forecastProductId}`;
        if (!bySuiteProduct.has(key)) bySuiteProduct.set(key, []);
        bySuiteProduct.get(key).push(contour);
    });

    bySuiteProduct.forEach(group => {
        if (!group.length) return;

        const definition = getForecastProduct(group[0].suiteId, group[0].forecastProductId);
        if (!definition || definition.rules?.requireNestedLevels !== true) return;

        const levelContours = group
            .filter(item => item.forecastRole !== 'overlay')
            .map(item => ({
                contour: item,
                value: _levelValue(item, definition),
            }))
            .filter(item => item.value !== null)
            .sort((a, b) => a.value - b.value);

        for (let i = 0; i < levelContours.length; i++) {
            const inner = levelContours[i];
            const lowerValues = [...new Set(levelContours
                .filter(item => item.value < inner.value)
                .map(item => item.value))];
            for (const lowerValue of lowerValues) {
                const possibleOuters = levelContours.filter(item => item.value === lowerValue);
                if (!possibleOuters.some(outer => _containsPolygon(outer.contour.coords, inner.contour.coords))) {
                    const outer = possibleOuters[0];
                    issues.push({
                        severity: 'error',
                        code: 'nested-level-violation',
                        suiteId: inner.contour.suiteId,
                        forecastProductId: inner.contour.forecastProductId,
                        forecastProductLabel: definition.label,
                        productIds: [outer.contour.id, inner.contour.id],
                        levelIds: [outer.contour.levelId, inner.contour.levelId],
                        message: `${definition.label}: ${_levelName(inner.contour)} must be contained within ${_levelName(outer.contour)}.`,
                    });
                }
            }
        }
    });

    return issues;
}
