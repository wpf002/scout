import { cached } from "./cache.js";
import { availableLayers, type LayerDef } from "./registry.js";

/**
 * Filling the layer cache before anyone asks for it.
 *
 * A cold layer is expensive in a way a warm one is not: satellites means
 * propagating sixteen thousand orbits to the current instant, and aircraft
 * means classifying fourteen thousand tracks. Warm, both answer in tens of
 * milliseconds; cold, both take about ten seconds — and that whole cost landed
 * on whoever flipped the switch first, who had no way to know why.
 *
 * So the server pays it, on its own time, before the switch is flipped.
 */

/**
 * How many layers to warm at once.
 *
 * The first pass used to be strictly sequential with a pause after every load,
 * which was polite and far too slow: a cold start took minutes, and the whole
 * point is to be finished before anybody flips a switch. These are thirty
 * different hosts, so warming several at once is not pressure on any one of
 * them — the politeness that matters is per host, and no host appears twice in
 * the roster.
 */
const CONCURRENCY = 6;

/**
 * The state of one layer's cache, as far as the warmer knows.
 *
 * "warm" is the only one that means a switch will answer instantly. "failed"
 * is not the same as "cold": the upstream answered and said no, or did not
 * answer at all, and no amount of waiting on this end will change it.
 */
export interface LayerHealth {
  id: string;
  name: string;
  state: "warm" | "failed" | "cold";
  /** How long the last load took, in ms. */
  ms: number | null;
  /** Why it failed, verbatim from the upstream where there is a message. */
  error: string | null;
  /** When it was last attempted. */
  at: number | null;
}

const health = new Map<string, LayerHealth>();

/**
 * Layers not worth warming.
 *
 * Everything else is, including the slow ones — especially the slow ones. A
 * cold layer that takes half a minute does not merely feel slow: the dashboard
 * proxies these, and a proxy has a timeout, so the layer arrives as a 500 with
 * no reason attached. Warming is what keeps that from being the first thing an
 * operator sees.
 *
 * These three are excluded because warming them means either a per-viewport
 * computation with no fixed answer, or a request to somebody's camera.
 */
const NEVER_WARM = new Set(["day_night", "terrain_3d", "cctv_previews"]);

function worthWarming(layer: LayerDef): boolean {
  return !NEVER_WARM.has(layer.id);
}

/** Whether this layer's cache entry is old enough to be worth replacing. */
function due(layer: LayerDef, now: number): boolean {
  const entry = health.get(layer.id);
  if (entry?.at === undefined || entry.at === null) return true;
  return now - entry.at >= layer.ttlMs;
}

/** Everything the warmer knows, for the readiness endpoint. */
export function layerHealth(): LayerHealth[] {
  return availableLayers()
    .filter(worthWarming)
    .map(
      (layer) =>
        health.get(layer.id) ?? {
          id: layer.id,
          name: layer.name,
          state: "cold" as const,
          ms: null,
          error: null,
          at: null,
        },
    );
}

async function warmOne(layer: LayerDef): Promise<void> {
  const started = Date.now();
  try {
    await cached(`layer:${layer.id}`, layer.ttlMs, layer.load);
    health.set(layer.id, {
      id: layer.id,
      name: layer.name,
      state: "warm",
      ms: Date.now() - started,
      error: null,
      at: Date.now(),
    });
  } catch (error) {
    // Recorded, not thrown. A dead upstream is a fact about the world, and the
    // layer reports it for itself when asked; a warm-up must never be the thing
    // that takes the server down.
    health.set(layer.id, {
      id: layer.id,
      name: layer.name,
      state: "failed",
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      at: Date.now(),
    });
  }
}

/**
 * One pass over the layers that are due.
 *
 * Bounded concurrency rather than one at a time. Failures are recorded against
 * the layer and the pass continues.
 */
export async function warmLayers(
  onDone?: (id: string, ms: number, ok: boolean) => void,
): Promise<void> {
  const queue = availableLayers()
    .filter(worthWarming)
    .filter((layer) => due(layer, Date.now()));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const layer = queue[index];
      if (layer === undefined) return;

      await warmOne(layer);
      const entry = health.get(layer.id);
      onDone?.(layer.id, entry?.ms ?? 0, entry?.state === "warm");
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker),
  );
}

/**
 * Keeps them warm.
 *
 * Re-checks on the shortest TTL among the warmable layers, so a cache entry is
 * replaced shortly after it expires rather than shortly before someone asks.
 * Returns a stop function; the timer is unref'd so it cannot hold the process
 * open on shutdown.
 */
export function keepWarm(
  onDone?: (id: string, ms: number, ok: boolean) => void,
): () => void {
  const warmable = availableLayers().filter(worthWarming);
  if (warmable.length === 0) return () => undefined;

  const every = Math.max(
    15_000,
    Math.min(...warmable.map((layer) => layer.ttlMs)),
  );

  // Passes must not overlap: the slow first pass is exactly when the timer
  // would fire, and two passes racing means two cold loads of the same layer.
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await warmLayers(onDone);
    } finally {
      running = false;
    }
  };

  void pass();
  const timer = setInterval(() => void pass(), every);
  timer.unref?.();
  return () => clearInterval(timer);
}
