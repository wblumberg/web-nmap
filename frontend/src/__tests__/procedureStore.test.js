import {beforeEach, describe, expect, it} from 'vitest';

import {
    deleteProcedure,
    getActiveProcedureId,
    importProcedure,
    listProcedures,
    saveProcedure,
    validateProcedureDefinition,
} from '../services/procedureStore.js';

class MemoryStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
}

const definition = () => ({
    schemaVersion: 1,
    display: {
        sources: [{slotId: 'satellite', sourceId: 'GOES', productId: 'water-vapor'}],
        sourceOrder: ['satellite'],
        dominantSlotId: 'satellite',
    },
    timeline: {anchor: 'latest', numberOfFrames: 12, frameSkip: 1},
});

describe('procedureStore', () => {
    let storage;
    beforeEach(() => { storage = new MemoryStorage(); });

    it('persists, updates, and deletes procedures', () => {
        const saved = saveProcedure({name: 'Water Vapor', definition: definition()}, storage);
        expect(listProcedures(storage)).toHaveLength(1);
        expect(getActiveProcedureId(storage)).toBe(saved.id);

        saveProcedure({id: saved.id, name: 'Updated Procedure', definition: definition()}, storage);
        expect(listProcedures(storage)[0].name).toBe('Updated Procedure');
        expect(deleteProcedure(saved.id, storage)).toBe(true);
        expect(listProcedures(storage)).toEqual([]);
        expect(getActiveProcedureId(storage)).toBeNull();
    });

    it('imports exported record-shaped JSON as a new local record', () => {
        const imported = importProcedure(JSON.stringify({
            name: 'Imported Map',
            description: 'Example',
            definition: definition(),
        }), storage);
        expect(imported.name).toBe('Imported Map');
        expect(imported.syncState).toBe('local');
    });

    it('rejects unsupported or empty definitions', () => {
        expect(() => validateProcedureDefinition({schemaVersion: 2, display: {sources: []}}))
            .toThrow(/Unsupported procedure schema/);
        expect(() => validateProcedureDefinition({schemaVersion: 1, display: {sources: []}}))
            .toThrow(/at least one data source/);
    });
});
