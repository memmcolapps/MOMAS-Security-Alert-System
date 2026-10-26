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
          // Exact package names: a bare "node_modules/react" prefix also caught
          // react-force-graph-2d and dragged d3 into the chunk every page loads.
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("lucide-react")) return "icons";
        },
      },
    },
  },
  server: {
    port: 5173,
  },
});
