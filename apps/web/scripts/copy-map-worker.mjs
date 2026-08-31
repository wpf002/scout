/**
 * Put MapLibre's worker somewhere Next will actually serve it.
 *
 * MapLibre resolves its worker as `new URL("./maplibre-gl-worker.mjs",
 * import.meta.url)`. Inside a Next bundle `import.meta.url` is the emitted
 * chunk's URL, so the worker is looked for under `/_next/static/chunks/` —
 * where it does not exist. Next answers with its HTML 404 page, the browser
 * refuses it for having a non-JavaScript MIME type, and the worker pool never
 * comes up.
 *
 * Nothing throws. Raster tiles still draw, because images are decoded on the
 * main thread — but every GeoJSON source needs the worker to tile its data, so
 * all the live layers report their feature counts and then draw nothing. The
 * map looks like it is working.
 *
 * The worker imports the shared runtime as a sibling, so both files have to
 * land here — copying only the worker moves the 404 one hop rather than
 * fixing it.
 *
 * Copying them here rather than committing them keeps the served worker pinned
 * to the installed version instead of drifting from it.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(publicDir, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(dist, file), join(publicDir, file));
}
