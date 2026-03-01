/* subscriptRegistry.js — lightweight subscript registry

Provides a simple registry for per-product subscripts that produce
AutumnPlot-GL layer sets for a particular frame/time. Intended for
declarative subscripts or JS factory modules.

API:
  SubscriptRegistry.registerModule(id, factory)
  SubscriptRegistry.registerDeclarative(id, spec)
  SubscriptRegistry.has(id)
  SubscriptRegistry.getLayersForFrame(id, frameTime, ctx) -> Promise<{layers,colorbar,sampler}>

This is intentionally small — it defers heavy parsing to the caller
and provides a consistent async API for LayerManager / main.js.
*/

'use strict';

const SubscriptRegistry = (() => {
    const _modules = {};
    const _declarative = {};

    return {
        registerModule(id, factory) {
            if (typeof factory !== 'function') return console.warn('SubscriptRegistry.registerModule: factory must be function');
            _modules[id] = factory;
        },
        registerDeclarative(id, spec) {
            _declarative[id] = spec;
        },
        has(id) {
            return (id in _modules) || (id in _declarative);
        },
        /**
         * Get layers for a given product at the requested frame time.
         * frameTime may be a Date or index hint; ctx is optional and can
         * provide helpers like zarrOpen, cache, gl, etc.
         */
        async getLayersForFrame(id, frameTime, ctx={}) {
            if (id in _modules) {
                try {
                    const fn = _modules[id];
                    return await fn(frameTime, ctx);
                } catch (err) {
                    console.error('SubscriptRegistry: module', id, 'failed', err);
                    return null;
                }
            }
            if (id in _declarative) {
                // Very small runtime for declarative subscripts — for demo only.
                const spec = _declarative[id];
                try {
                    // For raster specs, call a tiny renderer helper present in ctx
                    if (spec.type === 'raster' && typeof ctx.declarativeRasterRenderer === 'function') {
                        return await ctx.declarativeRasterRenderer(spec, frameTime, ctx);
                    }
                } catch (err) {
                    console.error('SubscriptRegistry: declarative', id, 'failed', err);
                    return null;
                }
            }
            return null;
        }
    };
})();

window.SubscriptRegistry = SubscriptRegistry;
