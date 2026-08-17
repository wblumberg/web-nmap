import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    clearDiagnosticEvents,
    clearDiagnosticSnapshots,
    clearBackendDiagnostics,
    buildDiagnosticExport,
    estimateValueBytes,
    getDiagnosticEvents,
    recordDiagnostic,
    setDiagnosticSnapshotProvider,
    getDiagnosticSnapshot,
    getDiagnosticSnapshots,
    sampleDiagnosticSnapshot,
    subscribeDiagnostics,
    recordBackendDiagnosticSnapshot,
} from '../services/mapDiagnostics.js';

describe('map diagnostics service', () => {
    beforeEach(() => {
        clearDiagnosticEvents();
        clearDiagnosticSnapshots();
        clearBackendDiagnostics();
    });

    it('reports multi-worker grid cache capacity as a per-process limit', () => {
        const report = instance_id => ({
            instance_id,
            captured_at: Date.now() / 1000,
            active_requests: 0,
            totals: {},
            window: {request_count: 0, top_endpoints: []},
            grid_cache: {entries: 1, bytes: 1024, max_bytes: 512 * 1024 * 1024},
        });
        recordBackendDiagnosticSnapshot(report('worker-a'));
        const aggregate = recordBackendDiagnosticSnapshot(report('worker-b'));

        expect(aggregate.grid_cache.max_bytes).toBe(512 * 1024 * 1024);
        expect(aggregate.grid_cache.max_bytes_per_process).toBe(512 * 1024 * 1024);
        expect(aggregate.grid_cache.aggregate_max_bytes).toBe(1024 * 1024 * 1024);
        expect(aggregate.grid_cache.bytes).toBe(2048);
        expect(aggregate.grid_cache.capacity_scope).toBe('per-process');
    });

    it('estimates shared typed arrays once and includes point payload values', () => {
        const raster = new Float32Array(16);
        const bytes = estimateValueBytes({raster, duplicate: raster, points: [{lat: 35, name: 'KTLX'}]});
        expect(bytes).toBeGreaterThanOrEqual(raster.byteLength + 8 + 8);
        expect(bytes).toBeLessThan(raster.byteLength * 3);
    });

    it('finds typed arrays retained inside Map and Set containers', () => {
        const upload = new Float32Array(32);
        const containers = new Map([
            ['texture', {spec: {image: upload}}],
            ['duplicates', new Set([upload])],
        ]);
        const bytes = estimateValueBytes(containers);
        expect(bytes).toBeGreaterThanOrEqual(upload.byteLength);
        expect(bytes).toBeLessThan(upload.byteLength * 2);
    });

    it('counts multiple views of one transferred buffer once', () => {
        const buffer = new ArrayBuffer(256);
        const bytes = estimateValueBytes({
            field: new Uint8Array(buffer),
            textureSpec: new Uint16Array(buffer),
        });
        expect(bytes).toBeGreaterThanOrEqual(buffer.byteLength);
        expect(bytes).toBeLessThan(buffer.byteLength * 2);
    });

    it('publishes events and exposes live snapshots', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeDiagnostics(listener);
        recordDiagnostic('frame-added', {source: 'MRMS', key: '1200', bytes: 42});
        expect(getDiagnosticEvents()).toHaveLength(1);
        expect(listener).toHaveBeenCalled();
        setDiagnosticSnapshotProvider(() => ({timelineFrames: 12}));
        expect(getDiagnosticSnapshot().timelineFrames).toBe(12);
        sampleDiagnosticSnapshot();
        expect(getDiagnosticSnapshots()).toHaveLength(1);
        expect(getDiagnosticSnapshots()[0].timelineFrames).toBe(12);
        const report = buildDiagnosticExport();
        expect(report.schemaVersion).toBe(1);
        expect(report.summary.sampleCount).toBe(1);
        expect(report.summary.eventTypeCounts['frame-added']).toBe(1);
        unsubscribe();
    });
});
