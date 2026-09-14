import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { prisma } from "@scout/db";

import { objectStore, TILES_BUCKET, type ObjectStore } from "../storage.js";

/**
 * What every imagery connector shares: a box, a window, the tile index, and
 * the rule that a scene over a box is downloaded once.
 */

export const bboxSchema = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine(([w, s, e, n]) => e > w && n > s, "bbox must be west,south,east,north with east > west and north > south");
export type Bbox = z.infer<typeof bboxSchema>;

/** Half a degree a side, about fifty kilometres: enough for an area of interest, not a province. */
export const MAX_BBOX_DEGREES = 0.5;

export const imageryParamsSchema = z.object({
  bbox: bboxSchema.refine(([w, s, e, n]) => e - w <= MAX_BBOX_DEGREES && n - s <= MAX_BBOX_DEGREES, `bbox may span at most ${MAX_BBOX_DEGREES}° a side`),
  from: z.coerce.date(),
  to: z.coerce.date(),
  maxCloudPct: z.number().int().min(0).max(100).default(30),
  maxScenes: z.number().int().min(1).max(5).default(2),
}).refine((p) => p.to > p.from, "to must be after from");
export type ImageryParams = z.infer<typeof imageryParamsSchema>;

export const bboxHash = (bbox: Bbox): string => createHash("sha256").update(bbox.map((v) => v.toFixed(6)).join(",")).digest("hex").slice(0, 24);

export const centroid = (bbox: Bbox): { lon: number; lat: number } => ({ lon: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 });

/** Pixel size for a box at a native resolution, capped so a request stays inside provider limits. */
export function pixelSize(bbox: Bbox, nativeResolutionM: number, cap = 1024): { width: number; height: number; resolutionM: number } {
  const [w, s, e, n] = bbox;
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const widthM = (e - w) * 111_320 * Math.cos(midLat);
  const heightM = (n - s) * 110_574;
  const scale = Math.max(1, Math.max(widthM, heightM) / (nativeResolutionM * cap));
  const resolutionM = Math.max(nativeResolutionM, Math.round(nativeResolutionM * scale));
  return { width: Math.max(1, Math.round(widthM / resolutionM)), height: Math.max(1, Math.round(heightM / resolutionM)), resolutionM };
}

export interface StoredScene {
  tileId: string;
  sceneId: string;
  sensedAt: Date;
  cloudCoverPct: number | null;
  bbox: Bbox;
  objectKey: string;
  previewKey: string | null;
  bytes: number;
  widthPx: number;
  heightPx: number;
  resolutionM: number;
  /** False when the tile was already in the index and nothing was requested. */
  downloaded: boolean;
}

export interface SceneToStore {
  sceneId: string;
  sensedAt: Date;
  cloudCoverPct: number | null;
  /** Produces the bytes only when they are needed. */
  render(size: { width: number; height: number }): Promise<{ tiff: Uint8Array; png: Uint8Array | null; format: string }>;
}

/**
 * Store a scene over a box once. The index is checked first (for this
 * authorization), then the bucket (shared: the same public scene over the
 * same box is one object however many authorizations look at it); only a
 * scene missing from both is rendered and written. The
 * GeoTIFF is stored as the provider returns it, and `cloudOptimized` is set
 * only if the bytes carry the COG layout marker, never assumed.
 */
export async function storeScene(input: {
  sourceId: string;
  authorizationId: string;
  caseId: string | null;
  bbox: Bbox;
  nativeResolutionM: number;
  scene: SceneToStore;
  store?: ObjectStore | null;
}): Promise<StoredScene> {
  const store = input.store === undefined ? objectStore() : input.store;
  if (store === null) throw new Error("Object storage is not configured (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY); imagery cannot be stored.");
  const hash = bboxHash(input.bbox);
  const existing = await prisma.imageryTile.findUnique({
    where: { sourceId_sceneId_bboxHash_authorizationId: { sourceId: input.sourceId, sceneId: input.scene.sceneId, bboxHash: hash, authorizationId: input.authorizationId } },
  });
  if (existing !== null) {
    return {
      tileId: existing.id, sceneId: existing.sceneId, sensedAt: existing.sensedAt, cloudCoverPct: existing.cloudCoverPct, bbox: input.bbox,
      objectKey: existing.objectKey, previewKey: existing.previewKey, bytes: existing.bytes, widthPx: existing.widthPx, heightPx: existing.heightPx, resolutionM: existing.resolutionM, downloaded: false,
    };
  }

  const size = pixelSize(input.bbox, input.nativeResolutionM);
  const safeScene = input.scene.sceneId.replace(/[^A-Za-z0-9_.-]/g, "_");
  const objectKey = `${input.sourceId}/${safeScene}/${hash}.tif`;
  const previewKey = `${input.sourceId}/${safeScene}/${hash}.png`;
  const bucket = TILES_BUCKET();

  let bytes: number;
  let format = "image/tiff";
  let cloudOptimized = false;
  let hasPreview = false;
  const already = await store.head(bucket, objectKey);
  if (already !== null) {
    bytes = already.size;
    hasPreview = (await store.head(bucket, previewKey)) !== null;
  } else {
    const rendered = await input.scene.render(size);
    format = rendered.format;
    // A COG is worth the conversion: the console and any tile server can
    // range-read one instead of pulling the whole file. When no converter is
    // installed the plain GeoTIFF is stored and cloudOptimized stays false,
    // rather than the row claiming a layout the bytes do not have.
    const cog = rendered.format === "image/tiff" ? await cogify(rendered.tiff) : null;
    const stored = cog ?? rendered.tiff;
    cloudOptimized = cog !== null;
    bytes = stored.byteLength;
    await store.put(bucket, objectKey, stored, rendered.format);
    if (rendered.png !== null) {
      await store.put(bucket, previewKey, rendered.png, "image/png");
      hasPreview = true;
    }
  }

  const [w, s, e, n] = input.bbox;
  const id = `tile_${createHash("sha256").update(`${input.sourceId}|${input.scene.sceneId}|${hash}|${input.authorizationId}`).digest("hex").slice(0, 24)}`;
  await prisma.$executeRaw`
    INSERT INTO "ImageryTile" ("id", "sourceId", "authorizationId", "caseId", "sceneId", "sensedAt", "cloudCoverPct", "bbox", "bboxHash", "geom",
      "objectKey", "previewKey", "bytes", "widthPx", "heightPx", "resolutionM", "format", "cloudOptimized")
    VALUES (${id}, ${input.sourceId}, ${input.authorizationId}, ${input.caseId}, ${input.scene.sceneId}, ${input.scene.sensedAt}, ${input.scene.cloudCoverPct},
      ARRAY[${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8], ${hash},
      ST_MakeEnvelope(${w}, ${s}, ${e}, ${n}, 4326)::geography,
      ${objectKey}, ${hasPreview ? previewKey : null}, ${bytes}, ${size.width}, ${size.height}, ${size.resolutionM}, ${format}, ${cloudOptimized})
    ON CONFLICT ("sourceId", "sceneId", "bboxHash", "authorizationId") DO NOTHING`;

  return {
    tileId: id, sceneId: input.scene.sceneId, sensedAt: input.scene.sensedAt, cloudCoverPct: input.scene.cloudCoverPct, bbox: input.bbox,
    objectKey, previewKey: hasPreview ? previewKey : null, bytes, widthPx: size.width, heightPx: size.height, resolutionM: size.resolutionM, downloaded: already === null,
  };
}

/**
 * A Cloud Optimized GeoTIFF is a TIFF whose IFDs and tiles are laid out
 * for range reads; GDAL writes a "LAYOUT=IFDS_BEFORE_DATA" marker in the
 * image description of one it produced. That marker is the only cheap,
 * honest test without parsing the whole file.
 */
const run = promisify(execFile);

/**
 * The command that turns a GeoTIFF into a Cloud Optimized one, or null when
 * none is installed. `IMAGERY_COG_COMMAND` forces one ("gdal_translate" or
 * "rio"); otherwise the first of gdal_translate then rio that answers
 * `--version` is used. Detection is cached for the process.
 */
let cogCommandCache: "gdal_translate" | "rio" | null | undefined;
export function resetCogCommand(): void {
  cogCommandCache = undefined;
}
async function cogCommand(): Promise<"gdal_translate" | "rio" | null> {
  if (cogCommandCache !== undefined) return cogCommandCache;
  const forced = process.env["IMAGERY_COG_COMMAND"]?.trim();
  const candidates: ReadonlyArray<"gdal_translate" | "rio"> = forced === "gdal_translate" || forced === "rio" ? [forced] : ["gdal_translate", "rio"];
  for (const cmd of candidates) {
    try {
      await run(cmd, ["--version"], { timeout: 10_000 });
      cogCommandCache = cmd;
      return cmd;
    } catch {
      // Not on PATH, or not answering; try the next.
    }
  }
  cogCommandCache = null;
  return null;
}

/**
 * Convert a GeoTIFF's bytes to a Cloud Optimized GeoTIFF, or null when no
 * converter is installed or the conversion fails. Storage falls back to the
 * plain GeoTIFF in that case, and `cloudOptimized` stays false, so the row
 * never claims a layout the bytes do not have.
 */
export async function cogify(tiff: Uint8Array): Promise<Uint8Array | null> {
  const cmd = await cogCommand();
  if (cmd === null) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "scout-cog-"));
    const src = join(dir, "in.tif");
    const dst = join(dir, "out.tif");
    await writeFile(src, tiff);
    const args =
      cmd === "gdal_translate"
        ? ["-q", "-of", "COG", "-co", "COMPRESS=DEFLATE", src, dst]
        : ["cogeo", "create", "--cog-profile", "deflate", src, dst];
    await run(cmd, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const out = await readFile(dst);
    return isCloudOptimized(out) ? new Uint8Array(out) : null;
  } catch {
    return null;
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function isCloudOptimized(tiff: Uint8Array): boolean {
  const head = Buffer.from(tiff.subarray(0, Math.min(tiff.byteLength, 65_536))).toString("latin1");
  return head.includes("LAYOUT=IFDS_BEFORE_DATA");
}
