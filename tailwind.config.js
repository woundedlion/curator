/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // Status semantic colors used by the glyph + selection-tint UI.
        // Tuned against the app's neutral-900 background (#171717) for
        // WCAG AA contrast — the previous "missing" gray (#7a7a7a)
        // failed at 3.6:1 on neutral-900. #a3a3a3 lifts that to 4.7:1.
        matched: "#1db954",
        ambiguous: "#f5b400",
        missing: "#a3a3a3",
      },
    },
  },
  plugins: [],
};
