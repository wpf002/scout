"use client";

/**
 * Map symbols, drawn once into the style's image atlas.
 *
 * Every aircraft and vessel Scout draws already carries a heading, and until
 * now that was thrown away to render a plain circle. Heading is the most
 * information-dense pixel on a moving-object map: it answers "where is this
 * going" with no click at all, which is what makes a traffic map readable at
 * a glance rather than a static scatter.
 *
 * The images are SDF — signed distance fields — which means MapLibre can tint
 * a single atlas entry per feature. One aircraft shape therefore serves all
 * four tiers, coloured from the `colour` property the feed already sets,
 * instead of four near-identical PNGs.
 */

export type SymbolId = "aircraft" | "vessel" | "dot";

const SIZE = 64;

/** The outline of each symbol, in a 64x64 box, nose or bow pointing up. */
const PATHS: Record<SymbolId, (path: Path2D) => void> = {
  // A plan-view airframe: nose, swept wings, tailplane.
  aircraft: (p) => {
    p.moveTo(32, 4);
    p.lineTo(36, 22);
    p.lineTo(60, 38);
    p.lineTo(60, 44);
    p.lineTo(36, 36);
    p.lineTo(36, 50);
    p.lineTo(44, 56);
    p.lineTo(44, 60);
    p.lineTo(32, 56);
    p.lineTo(20, 60);
    p.lineTo(20, 56);
    p.lineTo(28, 50);
    p.lineTo(28, 36);
    p.lineTo(4, 44);
    p.lineTo(4, 38);
    p.lineTo(28, 22);
    p.closePath();
  },
  // A hull seen from above: pointed bow, square stern.
  vessel: (p) => {
    p.moveTo(32, 4);
    p.lineTo(46, 26);
    p.lineTo(46, 58);
    p.lineTo(18, 58);
    p.lineTo(18, 26);
    p.closePath();
  },
  // For anything stationary, where a heading would be a lie.
  dot: (p) => {
    p.arc(32, 32, 18, 0, Math.PI * 2);
  },
};

/**
 * An SDF is a greyscale field where the alpha value encodes distance from the
 * shape's edge, so the renderer can scale, outline and tint one image cleanly.
 *
 * The encoding has to match MapLibre's exactly, and the constants are not
 * arbitrary. It reads the edge at alpha 191, not at the midpoint of 128 — the
 * convention comes from TinySDF, where
 *
 *     alpha = 255 - 255 * (distanceOutside / radius + 0.25)
 *
 * putting the boundary a quarter of the way down rather than halfway. Encoding
 * the edge at 128 renders every symbol enormously dilated: everything from 128
 * to 191 is read as interior, so a small aircraft becomes a blob the size of a
 * city.
 */
const EDGE_CUTOFF = 0.25;
function toSdf(draw: (path: Path2D) => void): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;

  const path = new Path2D();
  draw(path);
  context.fillStyle = "#fff";
  context.fill(path);

  const filled = context.getImageData(0, 0, SIZE, SIZE);
  const inside = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < inside.length; i += 1) {
    inside[i] = (filled.data[i * 4 + 3] ?? 0) > 127 ? 1 : 0;
  }

  // Distance to the nearest pixel of the opposite kind, capped at the radius
  // the encoding can represent. A brute-force search over a 64x64 box is a few
  // hundred thousand comparisons, run three times, once, at startup.
  const RADIUS = 8;
  const out = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = y * SIZE + x;
      const self = inside[index] === 1;
      let nearest = RADIUS;

      for (let dy = -RADIUS; dy <= RADIUS && nearest > 0; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= SIZE) continue;
        for (let dx = -RADIUS; dx <= RADIUS; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= SIZE) continue;
          if ((inside[ny * SIZE + nx] === 1) === self) continue;
          const distance = Math.hypot(dx, dy);
          if (distance < nearest) nearest = distance;
        }
      }

      // Positive outside, negative inside — TinySDF's sign convention.
      const distanceOutside = self ? -nearest : nearest;
      const alpha = Math.max(
        0,
        Math.min(
          255,
          Math.round(255 - 255 * (distanceOutside / RADIUS + EDGE_CUTOFF)),
        ),
      );
      out[index * 4] = 255;
      out[index * 4 + 1] = 255;
      out[index * 4 + 2] = 255;
      out[index * 4 + 3] = alpha;
    }
  }

  return new ImageData(out, SIZE, SIZE);
}

const cache = new Map<SymbolId, ImageData>();

/**
 * Add the symbols to a style, if they are not already there.
 *
 * Called after every style load, because `setStyle` discards the image atlas
 * along with everything else — a basemap switch would otherwise leave every
 * symbol layer pointing at an image that no longer exists.
 */
export function ensureSymbols(map: {
  hasImage: (id: string) => boolean;
  addImage: (id: string, image: ImageData, options?: { sdf?: boolean; pixelRatio?: number }) => void;
}): void {
  for (const id of Object.keys(PATHS) as SymbolId[]) {
    if (map.hasImage(id)) continue;

    let image = cache.get(id);
    if (image === undefined) {
      const built = toSdf(PATHS[id]);
      if (built === null) continue;
      cache.set(id, built);
      image = built;
    }

    try {
      map.addImage(id, image, { sdf: true, pixelRatio: 2 });
    } catch {
      // A style that already has it under a race. Harmless.
    }
  }
}
