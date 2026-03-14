/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["'IBM Plex Mono'", "monospace"],
        sans: ["'DM Sans'", "sans-serif"],
      },
      colors: {
        ink:   "#0A0E14",
        panel: "#0F1923",
        card:  "#141F2E",
        border:"#1E3048",
        dim:   "#2A4060",
        muted: "#4A6480",
        text:  "#C8D8E8",
        bright:"#E8F4FF",
        accent:"#1E90FF",
        teal:  "#00C8A0",
        amber: "#F5A623",
        red:   "#E84057",
      },
      animation: {
        "scan": "scan 2s linear infinite",
        "pulse-slow": "pulse 3s ease-in-out infinite",
        "fade-up": "fadeUp 0.5s ease forwards",
      },
      keyframes: {
        scan: {
          "0%":   { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        fadeUp: {
          "0%":   { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        }
      }
    }
  },
  plugins: []
}
