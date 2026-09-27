/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Black-and-grey dual tone. Severity colour is reserved for the
        // console; the marketing page stays achromatic on purpose.
        ink: "#000000",
        surface: "#0a0a0a",
        panel: "#111111",
        raised: "#171717",
        line: "#1f1f1f",
        "line-lit": "#2e2e2e",
        body: "#ededed",
        muted: "#8a8a8a",
        faint: "#5a5a5a",
        accent: "#d4d4d4",
      },
      fontFamily: {
        sans: ["Rubik", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
