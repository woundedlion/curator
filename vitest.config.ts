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
  },
});
