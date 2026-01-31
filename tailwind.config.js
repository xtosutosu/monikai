/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"Share Tech Mono"', "monospace"],
      },
      colors: {
        // Główna paleta UI – odcienie bieli
        surface: {
          50:  "rgba(255,255,255,0.02)",
          100: "rgba(255,255,255,0.04)",
          200: "rgba(255,255,255,0.06)",
          300: "rgba(255,255,255,0.08)",
          400: "rgba(255,255,255,0.12)",
          500: "rgba(255,255,255,0.18)",
        },

        // Tekst
        ink: {
          50:  "rgba(255,255,255,0.35)",
          100: "rgba(255,255,255,0.55)",
          200: "rgba(255,255,255,0.75)",
          300: "rgba(255,255,255,0.9)",
        },

        // Obramowania / separatory
        line: {
          100: "rgba(255,255,255,0.08)",
          200: "rgba(255,255,255,0.12)",
          300: "rgba(255,255,255,0.18)",
        },
      },
    },
  },
  plugins: [],
};
