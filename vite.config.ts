import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  base: command === "build" ? "/curator/" : "/",
  plugins: [react()],
  server: { port: 5173 },
  worker: {
    format: "es",
  },
}));
