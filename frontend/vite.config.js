import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// Emits /sw.js with the list of every built file, so the service worker can
// hold the whole app on the device. The version is a hash of the file names,
// which carry content hashes, so it changes exactly when a deploy changes.
function serviceWorker() {
  return {
    name: "momas-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map"))
        .map((name) => (name === "index.html" ? "/" : `/${name}`))
        .sort();
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const source = readFileSync(new URL("./sw/service-worker.js", import.meta.url), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(files)};\n\n${source}`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
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
