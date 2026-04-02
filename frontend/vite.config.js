import { defineConfig } from "vite";
import wasm from "@rollup/plugin-wasm";

/**
 * Vite plugin: rewrite autumnplot-gl's Worker instantiation so the browser
 * loads PlotLayer.worker.js as an ES module instead of a classic script.
 *
 * The library does:
 *   new Worker(new URL('./PlotLayer.worker', import.meta.url))
 * which defaults to { type: 'classic' }.  The worker file uses ES imports,
 * so it must be loaded as { type: 'module' }.
 */
function autumnplotWorkerFix() {
  return {
    name: 'autumnplot-worker-fix',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('autumnplot-gl')) return;
      if (!code.includes('PlotLayer.worker')) return;

      const patched = code.replace(
        /new Worker\(\s*(new URL\([^)]*PlotLayer\.worker[^)]*\))\s*\)/g,
        'new Worker($1, { type: "module" })'
      );

      if (patched !== code) {
        return { code: patched, map: null };
      }
    },
  };
}

export default defineConfig({
  optimizeDepts: {
    include: ['autumnplot-gl']
  },
  build: {
    rollupOptions: {
      external: []
    }
  },
  plugins: [autumnplotWorkerFix(), wasm()],
  worker: {
    format: 'es',
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true
      }
    }
  }
});
