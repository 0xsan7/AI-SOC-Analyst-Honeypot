/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Matches the SOC console palette so the two views feel like one product.
        surface: "#0a0812",
        panel: "#14101f",
        accent: "#7c6cf0",
        lime: "#c2ef4e",
      },
      fontFamily: {
        sans: ["Rubik", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
