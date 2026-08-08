/**
 * A small in-memory TTL cache for upstream responses.
 *
 * Deliberately in-memory and deliberately not Redis. Redis and a job queue are
 * a Phase 3 defer: they get built when a single case regularly issues enough
 * infra calls to hit rate limits, not before. This gets the useful 90% —
 * planning the same domain twice in a minute does not bill you twice — without
 * adding a service to run.
 *
 * Consequence, accepted: the cache is per-process and dies on restart. That is
 * correct for a cache and would only be wrong for a store.
 */
export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.maxEntries = options.maxEntries ?? 500;
  }

  get(key: string, now: number = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh insertion order so the eviction below is roughly LRU.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now: number = Date.now()): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** Cache key for one source asking about one subject. */
export function responseCacheKey(
  sourceId: string,
  subjectKind: string,
  subjectValue: string,
): string {
  return `${sourceId}:${subjectKind}:${subjectValue.trim().toLowerCase()}`;
}
