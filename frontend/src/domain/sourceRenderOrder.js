const RENDER_PRIORITY = Object.freeze({
    imagery: 0,
    field: 100,
    overlay: 200,
    symbols: 300,
});

/** Resolve bottom-to-top display priority independently of procedure source order. */
export function sourceRenderPriority(source, productSuites) {
    const product = productSuites[source.productKey] || {};
    if (Number.isFinite(product.render_priority)) return product.render_priority;

    const endpointType = source.entry?.endpoint_type;
    if (endpointType === 'point_obs' || endpointType === 'profile_obs' || endpointType === 'geometry') {
        return RENDER_PRIORITY.symbols;
    }
    if (product.group === 'overlays') return RENDER_PRIORITY.overlay;
    if (source.entry?.data_category === 'gridded_imagery') return RENDER_PRIORITY.imagery;
    return RENDER_PRIORITY.field;
}

/** Stable sort: retain procedure order among sources in the same display tier. */
export function orderSourcesForRendering(sources, productSuites) {
    return sources
        .map((source, index) => ({source, index}))
        .sort((a, b) =>
            sourceRenderPriority(a.source, productSuites) - sourceRenderPriority(b.source, productSuites) ||
            a.index - b.index
        )
        .map(item => item.source);
}

export { RENDER_PRIORITY };
