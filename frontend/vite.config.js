import { defineConfig } from "vite";
import wasm from "@rollup/plugin-wasm";

export default defineConfig({
  plugins: [wasm()],
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