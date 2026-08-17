const TAG_DEFINITIONS = Object.freeze({
    MN:   {label: 'MEAN', title: 'Ensemble mean', tone: 'statistic'},
    MNSD: {label: 'MEAN + SD', title: 'Ensemble mean and standard deviation', tone: 'spread'},
    MX:   {label: 'MAX', title: 'Ensemble maximum', tone: 'statistic'},
    P50:  {label: 'P50', title: '50th percentile (median)', tone: 'statistic'},
    PR:   {label: 'PROBABILITY', title: 'Ensemble probability', tone: 'probability'},
    NP:   {label: 'NEIGHBORHOOD PROB', title: 'Neighborhood probability', tone: 'probability'},
    PB:   {label: 'PAINTBALL', title: 'Ensemble member paintball', tone: 'member'},
    SP:   {label: 'SPAGHETTI', title: 'Ensemble member spaghetti', tone: 'member'},
    TEST: {label: 'EXPERIMENTAL', title: 'Experimental product', tone: 'experimental'},
});

function normalizeCodes(value) {
    const codes = Array.isArray(value) ? value : [];
    return [...new Set(codes.map(code => String(code).trim().toUpperCase()).filter(Boolean))];
}

/** Resolve explicit ensemble_tags metadata, with legacy [MN, NP] label support. */
export function getProductPresentation(product = {}, fallback = '') {
    const rawLabel = String(product.label || fallback);
    const legacy = rawLabel.match(/^\s*\[([^\]]+)]\s*/);
    const explicitCodes = normalizeCodes(product.ensemble_tags);
    const legacyCodes = legacy ? normalizeCodes(legacy[1].split(',')) : [];
    const codes = explicitCodes.length ? explicitCodes : legacyCodes;
    const label = legacy ? rawLabel.slice(legacy[0].length).trim() : rawLabel;
    const tags = codes.map(code => ({
        code,
        ...(TAG_DEFINITIONS[code] || {label: code, title: code, tone: 'other'}),
    }));
    return {label, tags};
}

export function productPresentationMarkup(product, fallback = '') {
    const presentation = getProductPresentation(product, fallback);
    const badges = presentation.tags.map(tag =>
        `<span class="ens-product-badge ens-product-badge-${tag.tone}" title="${tag.title}">${tag.label}</span>`
    ).join('');
    return { ...presentation, badges };
}

export {TAG_DEFINITIONS};
