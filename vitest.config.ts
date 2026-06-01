import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Default env stays `node` so the pure-logic suite keeps its fast
// startup; component tests opt into happy-dom per-file via the
// `// @vitest-environment happy-dom` pragma at the top of the file.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      // Opt-in only: invoked via `npm run test:coverage`, never the
      // default `npm test`, so the default suite doesn't require the
      // @vitest/coverage-v8 package to be installed.
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/main.tsx",
        "src/**/*.worker.{ts,tsx}",
        "**/*.config.{js,ts}",
        "dist/**",
        "node_modules/**",
      ],
      // Moderate starting thresholds; tune upward once a real coverage
      // run establishes the actual baseline for this codebase.
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
