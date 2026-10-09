// MapLibre 6 spawns its worker from `new URL('./maplibre-gl-worker.mjs', import.meta.url)`,
// which Next's bundler does not rewrite. We serve the worker as a static file instead and
// tell MapLibre where it is (components/Globe.tsx: setWorkerUrl). Runs on postinstall.
import { copyFile, mkdir } from "node:fs/promises";

await mkdir("public", { recursive: true });
await copyFile("node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", "public/maplibre-gl-worker.mjs");
console.log("copied maplibre-gl-worker.mjs → public/");
