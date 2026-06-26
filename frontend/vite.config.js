import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("leaflet")) return "maps";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("node_modules/react")) return "react";
          if (id.includes("lucide-react")) return "icons";
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
