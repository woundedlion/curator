import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/curator/" : "/",
  plugins: [react()],
  server: { port: 5173 },
  worker: {
    format: "es",
  },
  build: {
    // Pin the output target to match the ES2022 contract in tsconfig.json /
    // .nvmrc rather than relying on Vite's shifting default.
    target: "es2022",
    // Hidden source maps: emit maps for error triage (uploadable to a tracker)
    // without referencing them from the shipped JS, so they aren't served to
    // end users. Keeps production stack traces debuggable without exposing
    // source publicly.
    sourcemap: "hidden",
    // Disable the inline modulepreload polyfill. Vite otherwise injects a small
    // INLINE <script> to polyfill <link rel=modulepreload> for older Safari,
    // which would force 'unsafe-inline' (or a per-build hash) into the CSP
    // script-src in index.html. Modern browsers (our es2022 target) support
    // modulepreload natively, so dropping the polyfill lets the CSP stay strict.
    modulePreload: { polyfill: false },
  },
}));
