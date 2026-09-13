import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Two caches, because two kinds of upstream.
 *
 * Most feeds want a plain in-memory TTL: they move continuously, and a restart
 * losing the cache costs one fetch.
 *
 * A few actively punish re-fetching. CelesTrak answers HTTP 403 with "GP data
 * has not updated since your last successful download" if you ask again inside
 * its two-hour window — so a restart that re-fetches does not get slower data,
 * it gets *no* data. Those are cached to disk, and the disk copy is what a
 * refused refetch falls back to.
 */

interface Entry<T> {
  at: number;
  value: T;
}

const memory = new Map<string, Entry<unknown>>();

/**
 * Loads currently running, keyed the same as the cache.
 *
 * Without this, a cold key being asked for twice at once runs `load` twice.
 * That is not merely wasteful: several of these upstreams are rate limited per
 * address, so the second call can be the one that gets the address refused —
 * and the expensive ones are expensive precisely because they are the ones
 * everybody asks for at the same moment, on a restart or when the server warms
 * itself. Sixteen thousand orbits, propagated twice, for one answer.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function clearLiveCache(): void {
  memory.clear();
  inFlight.clear();
}

export async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = memory.get(key) as Entry<T> | undefined;
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;

  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running !== undefined) return running;

  // The stale fallback lives inside the shared promise, not around it, so every
  // caller waiting on one load gets the same answer. Outside, the first caller
  // would fall back to the last good value while everyone who joined the same
  // load got the error instead.
  const attempt = (async (): Promise<T> => {
    try {
      const value = await load();
      memory.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      // Stale beats nothing. A feed that fails on refresh keeps showing what it
      // last knew rather than emptying the layer under the operator.
      if (hit !== undefined) return hit.value;
      throw error;
    }
  })();

  // Cleared in a `finally` so a failed load does not wedge the key against
  // every later attempt, and identity-checked so a slow failure cannot delete
  // the entry a newer attempt has since registered.
  inFlight.set(key, attempt);
  try {
    return await attempt;
  } finally {
    if (inFlight.get(key) === attempt) inFlight.delete(key);
  }
}

const DISK = join(tmpdir(), "scout-live-cache");

function diskPath(key: string): string {
  return join(DISK, `${key.replace(/[^a-z0-9_-]/gi, "_")}.json`);
}

function readDisk<T>(key: string): Entry<T> | null {
  try {
    return JSON.parse(readFileSync(diskPath(key), "utf8")) as Entry<T>;
  } catch {
    return null;
  }
}

function writeDisk<T>(key: string, entry: Entry<T>): void {
  try {
    mkdirSync(DISK, { recursive: true });
    writeFileSync(diskPath(key), JSON.stringify(entry));
  } catch {
    // A cache that cannot write is slower, not broken.
  }
}

/**
 * Cached through a restart, for upstreams that refuse a refetch.
 *
 * `maxStaleMs` is how long the disk copy stays usable when the upstream is
 * refusing or unreachable — well beyond the TTL, because for these sources
 * hours-old orbital elements are still correct to within a rounding error,
 * while an empty layer is simply wrong.
 */
export async function persistent<T>(
  key: string,
  ttlMs: number,
  maxStaleMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hot = memory.get(key) as Entry<T> | undefined;
  if (hot !== undefined && Date.now() - hot.at < ttlMs) return hot.value;

  const cold = hot ?? readDisk<T>(key);
  if (cold !== null && cold !== undefined && Date.now() - cold.at < ttlMs) {
    memory.set(key, cold);
    return cold.value;
  }

  try {
    const value = await load();
    const entry = { at: Date.now(), value };
    memory.set(key, entry);
    writeDisk(key, entry);
    return value;
  } catch (error) {
    if (cold !== null && cold !== undefined && Date.now() - cold.at < maxStaleMs) {
      memory.set(key, cold);
      return cold.value;
    }
    throw error;
  }
}

/** How old the cached copy of something is, for the honesty of the readout. */
export function ageMs(key: string): number | null {
  const hit = memory.get(key);
  return hit === undefined ? null : Date.now() - hit.at;
}
