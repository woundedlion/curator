/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        matched: "#1db954",
        ambiguous: "#f5b400",
        missing: "#7a7a7a",
      },
    },
  },
  plugins: [],
};
