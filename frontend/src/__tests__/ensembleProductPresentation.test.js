import {describe, expect, it} from 'vitest';
import {getProductPresentation} from '../domain/ensembleProductPresentation.js';

describe('ensemble product presentation', () => {
    it('extracts legacy combined tags from the visible label', () => {
        const result = getProductPresentation({label: '[MX, NP] 4h UH'});
        expect(result.label).toBe('4h UH');
        expect(result.tags.map(tag => tag.label)).toEqual(['MAX', 'NEIGHBORHOOD PROB']);
    });

    it('supports explicit metadata for future products', () => {
        const result = getProductPresentation({label: 'Reflectivity', ensemble_tags: ['PB']});
        expect(result.label).toBe('Reflectivity');
        expect(result.tags[0].title).toBe('Ensemble member paintball');
    });
});
