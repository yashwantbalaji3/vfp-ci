// Copies MapLibre's background worker next to the app's own files, so the map loads it from
// our own address (no outside host). Runs before `next build` and `next dev`. The copy is not
// committed; it is rebuilt from the locked package version every time.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("node_modules/maplibre-gl/package.json", "utf8"));
mkdirSync("public/vendor", { recursive: true });
const target = `public/vendor/maplibre-gl-worker-${pkg.version}.mjs`;
copyFileSync("node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", target);
console.log(`Copied the map worker to ${target}`);
