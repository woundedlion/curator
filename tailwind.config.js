/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // Status semantic colors used by the glyph + selection-tint UI.
        // `missing` is intentionally a darker gray than the idle hollow
        // outline (text-neutral-500 / #2d2d2d) so the filled "known
        // missing" circle reads as a deliberate result rather than
        // blending with the muted-row tint or the idle outline. Used
        // for both Spotify "missing" and MB "failed" — they're the
        // same semantic shape (we looked and there was nothing).
        matched: "#1db954",
        ambiguous: "#f5b400",
        missing: "#2d2d2d",
      },
    },
  },
  plugins: [],
};
