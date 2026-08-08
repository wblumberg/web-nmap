const PROCEDURES_KEY = 'nmap.procedures.v1';
const ACTIVE_PROCEDURE_KEY = 'nmap.active-procedure.v1';
export const PROCEDURE_SCHEMA_VERSION = 1;

function storageOrDefault(storage) {
    return storage || window.localStorage;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `procedure-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readRecords(storage) {
    try {
        const value = JSON.parse(storageOrDefault(storage).getItem(PROCEDURES_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (_) {
        return [];
    }
}

function writeRecords(records, storage) {
    storageOrDefault(storage).setItem(PROCEDURES_KEY, JSON.stringify(records));
}

export function validateProcedureDefinition(definition) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        throw new Error('Procedure configuration must be an object.');
    }
    if (definition.schemaVersion !== PROCEDURE_SCHEMA_VERSION) {
        throw new Error(`Unsupported procedure schema version: ${definition.schemaVersion ?? 'missing'}.`);
    }
    if (!Array.isArray(definition.display?.sources) || !definition.display.sources.length) {
        throw new Error('A procedure must contain at least one data source.');
    }
    definition.display.sources.forEach((source, index) => {
        if (!source?.sourceId || typeof source.sourceId !== 'string') {
            throw new Error(`Procedure source ${index + 1} is missing a sourceId.`);
        }
        if (source.productId !== null && source.productId !== undefined
                && typeof source.productId !== 'string') {
            throw new Error(`Procedure source ${index + 1} has an invalid productId.`);
        }
    });
    return definition;
}

export function listProcedures(storage) {
    return readRecords(storage)
        .map(clone)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getProcedure(id, storage) {
    const record = readRecords(storage).find(item => item.id === id);
    return record ? clone(record) : null;
}

export function saveProcedure({id = null, name, description = '', definition}, storage) {
    validateProcedureDefinition(definition);
    const trimmedName = String(name || '').trim();
    if (!trimmedName) throw new Error('Enter a procedure name.');
    const records = readRecords(storage);
    const now = new Date().toISOString();
    const existingIndex = id ? records.findIndex(item => item.id === id) : -1;
    const previous = existingIndex >= 0 ? records[existingIndex] : null;
    const record = {
        id: previous?.id || id || makeId(),
        name: trimmedName,
        description: String(description || '').trim(),
        schemaVersion: PROCEDURE_SCHEMA_VERSION,
        ownerId: previous?.ownerId || null,
        visibility: previous?.visibility || 'local',
        syncState: 'local',
        createdAt: previous?.createdAt || now,
        updatedAt: now,
        definition: clone(definition),
    };
    if (existingIndex >= 0) records.splice(existingIndex, 1, record);
    else records.push(record);
    writeRecords(records, storage);
    setActiveProcedureId(record.id, storage);
    return clone(record);
}

export function deleteProcedure(id, storage) {
    const targetStorage = storageOrDefault(storage);
    const records = readRecords(targetStorage);
    const next = records.filter(item => item.id !== id);
    if (next.length === records.length) return false;
    writeRecords(next, targetStorage);
    if (getActiveProcedureId(targetStorage) === id) {
        targetStorage.removeItem(ACTIVE_PROCEDURE_KEY);
    }
    return true;
}

export function importProcedure(value, storage) {
    const imported = typeof value === 'string' ? JSON.parse(value) : value;
    const definition = imported?.definition || imported;
    validateProcedureDefinition(definition);
    return saveProcedure({
        name: imported?.name || definition.name || 'Imported Procedure',
        description: imported?.description || '',
        definition,
    }, storage);
}

export function setActiveProcedureId(id, storage) {
    const targetStorage = storageOrDefault(storage);
    if (id) targetStorage.setItem(ACTIVE_PROCEDURE_KEY, String(id));
    else targetStorage.removeItem(ACTIVE_PROCEDURE_KEY);
}

export function getActiveProcedureId(storage) {
    return storageOrDefault(storage).getItem(ACTIVE_PROCEDURE_KEY) || null;
}

export function procedureExportJSON(record) {
    if (!record?.definition) throw new Error('Cannot export an empty procedure.');
    return JSON.stringify(record, null, 2);
}

export { PROCEDURES_KEY, ACTIVE_PROCEDURE_KEY };
