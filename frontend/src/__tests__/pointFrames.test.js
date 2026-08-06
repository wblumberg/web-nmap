import { describe, expect, it } from 'vitest';

import {
    buildPointFrames,
    normalizePointPolicy,
    pointRangeForFrames,
    pointWindow,
} from '../domain/pointFrames.js';

const point = (time, stationId, lon = -97, lat = 35) => ({
    coord: { lon, lat },
    valid_time: time,
    data: stationId ? { station_id: stationId, tmpf: 70 } : { peak_current_ka: -12 },
});

describe('point range policy', () => {
    it('normalizes catalog booleans and protobuf metadata strings', () => {
        expect(normalizePointPolicy({
            binflag: 'true',
            before_minutes: '60',
            after_minutes: '5',
            use_most_recent_filter: 'false',
            return_age: 'true',
        })).toEqual({
            binflag: true,
            beforeMinutes: 60,
            afterMinutes: 5,
            useMostRecentFilter: false,
            mostRecentBy: 'geom',
            returnAge: true,
        });
    });

    it('retains asymmetric binflag and symmetric non-binflag windows', () => {
        const center = Date.parse('2026-08-01T12:00:00Z');
        expect(pointWindow(center, {
            binflag: true, before_minutes: 60, after_minutes: 10,
        })).toEqual({
            startMs: Date.parse('2026-08-01T11:00:00Z'),
            endMs: Date.parse('2026-08-01T12:10:00Z'),
        });
        expect(pointWindow(center, {
            binflag: false, before_minutes: 20, after_minutes: 5,
        })).toEqual({
            startMs: Date.parse('2026-08-01T11:40:00Z'),
            endMs: Date.parse('2026-08-01T12:20:00Z'),
        });
    });

    it('calculates one union range for overlapping loop windows', () => {
        const specs = [
            { frameKey: 'a', centerMs: Date.parse('2026-08-01T12:00:00Z') },
            { frameKey: 'b', centerMs: Date.parse('2026-08-01T12:10:00Z') },
        ];
        expect(pointRangeForFrames(specs, {
            binflag: true, before_minutes: 60, after_minutes: 0,
        })).toEqual({
            startMs: Date.parse('2026-08-01T11:00:00Z'),
            endMs: Date.parse('2026-08-01T12:10:00Z'),
        });
    });
});

describe('point frame reconstruction', () => {
    it('reuses lightning observations and computes frame-relative age', () => {
        const strike = point('2026-08-01T11:50:00Z', null);
        const specs = [
            { frameKey: '1200', centerMs: Date.parse('2026-08-01T12:00:00Z') },
            { frameKey: '1210', centerMs: Date.parse('2026-08-01T12:10:00Z') },
        ];
        const frames = buildPointFrames([strike], specs, {
            binflag: true,
            before_minutes: 60,
            after_minutes: 0,
            return_age: true,
        });

        expect(frames.get('1200').obs_json).toHaveLength(1);
        expect(frames.get('1210').obs_json).toHaveLength(1);
        expect(frames.get('1200').age_reference_ms).toBe(Date.parse('2026-08-01T12:00:00Z'));
        expect(frames.get('1210').age_reference_ms).toBe(Date.parse('2026-08-01T12:10:00Z'));
        expect(frames.get('1200').obs_time_ms[0]).toBe(Date.parse(strike.valid_time));
        expect(frames.get('1200').obs_json[0]).toBe(strike);
        expect(frames.get('1210').obs_json[0]).toBe(strike);
        expect(strike.data.age_minutes).toBeUndefined();
    });

    it('selects the newest report per station independently for each frame', () => {
        const reports = [
            point('2026-08-01T11:50:00Z', 'KOUN'),
            point('2026-08-01T12:05:00Z', 'KOUN'),
            point('2026-08-01T11:55:00Z', 'KOKC', -97.6, 35.4),
        ];
        const specs = [
            { frameKey: '1200', centerMs: Date.parse('2026-08-01T12:00:00Z') },
            { frameKey: '1210', centerMs: Date.parse('2026-08-01T12:10:00Z') },
        ];
        const frames = buildPointFrames(reports, specs, {
            binflag: true,
            before_minutes: 60,
            after_minutes: 0,
            use_most_recent_filter: true,
            most_recent_by: 'station_id',
        });

        expect(Object.fromEntries(
            frames.get('1200').obs_json.map(p => [p.data.station_id, p.valid_time])
        )).toEqual({
            KOKC: '2026-08-01T11:55:00Z',
            KOUN: '2026-08-01T11:50:00Z',
        });
        expect(Object.fromEntries(
            frames.get('1210').obs_json.map(p => [p.data.station_id, p.valid_time])
        )).toEqual({
            KOKC: '2026-08-01T11:55:00Z',
            KOUN: '2026-08-01T12:05:00Z',
        });
        expect(frames.get('1200').obs_json.map(p => p.data.station_id)).toEqual(['KOKC', 'KOUN']);
        expect(frames.get('1210').obs_json.map(p => p.data.station_id)).toEqual(['KOKC', 'KOUN']);
    });

    it('normalizes station identifiers before most-recent selection', () => {
        const reports = [
            point('2026-08-01T11:50:00Z', 'koun'),
            point('2026-08-01T11:55:00Z', ' KOUN '),
        ];
        const frames = buildPointFrames(reports, [{
            frameKey: '1200', centerMs: Date.parse('2026-08-01T12:00:00Z'),
        }], {
            binflag: true,
            before_minutes: 60,
            use_most_recent_filter: true,
            most_recent_by: 'station_id',
        });

        expect(frames.get('1200').obs_json).toHaveLength(1);
        expect(frames.get('1200').obs_json[0].valid_time).toBe('2026-08-01T11:55:00Z');
    });

    it('prefers compact epoch-minute timestamps over ISO parsing', () => {
        const compact = {
            coord: { lon: -97, lat: 35 },
            valid_time: '',
            valid_time_ms: Date.parse('2026-08-01T11:50:00Z'),
            data: {},
        };
        const frames = buildPointFrames([compact], [{
            frameKey: '1200', centerMs: Date.parse('2026-08-01T12:00:00Z'),
        }], {
            binflag: true, before_minutes: 60, return_age: true,
        });

        expect(frames.get('1200').obs_json[0]).toBe(compact);
        expect(frames.get('1200').obs_time_ms[0]).toBe(compact.valid_time_ms);
    });
});
