/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ops: {
          bg: "#0a0a0a",
          panel: "rgba(0, 0, 0, 0.88)",
          line: "rgba(255, 68, 68, 0.32)",
          red: "#ff4444",
          green: "#00cc66",
          teal: "#00bbaa",
          amber: "#ffb300",
          orange: "#ff6600",
          blue: "#3399ff",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
