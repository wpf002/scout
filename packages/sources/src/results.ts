import type { Source, SubjectKind, Tier } from "./types.js";

/**
 * Outcome of asking a source about a subject.
 *
 * `inert`   — source needs a key and has none. Not an error; nothing was tried.
 * `blocked` — the scope gate refused. Nothing left the process.
 * `error`   — the upstream call failed. Adapters degrade to this, never throw
 *             the whole request.
 */
export type ResultStatus = "ok" | "inert" | "blocked" | "error";

/**
 * Provenance travels with every result and is copied onto any Finding saved
 * from it (locked invariant 5). A result without provenance is a bug.
 */
export interface Provenance {
  sourceId: string;
  sourceName: string;
  tier: Tier;
  /** The exact term submitted to the source. */
  queryTerm: string;
  queryKind: SubjectKind;
  /** ISO-8601. When the observation was made, not when it was saved. */
  observedAt: string;
  /** Audit row this result came from, when one was written. */
  queryLogId?: string;
}

export interface SourceResult<TData = unknown> {
  status: ResultStatus;
  provenance: Provenance;
  /** Present when `status` is `ok`. */
  data?: TData;
  /** Machine-readable reason for `inert` / `blocked` / `error`. */
  reason?: string;
  /** Human-readable explanation, safe to show in the UI. */
  message?: string;
}

export function makeProvenance(
  source: Source,
  queryTerm: string,
  queryKind: SubjectKind,
  extra: { observedAt?: Date; queryLogId?: string } = {},
): Provenance {
  const provenance: Provenance = {
    sourceId: source.id,
    sourceName: source.name,
    tier: source.tier,
    queryTerm,
    queryKind,
    observedAt: (extra.observedAt ?? new Date()).toISOString(),
  };
  if (extra.queryLogId !== undefined) provenance.queryLogId = extra.queryLogId;
  return provenance;
}

/**
 * A breach exposure record. HIBP is the worked example; DeHashed normalizes
 * into the same shape in Phase 5.
 *
 * `pwnCount` is a bigint: the largest known breaches exceed a signed 32-bit
 * int, and counted things do not get to be floats (locked invariant 7).
 */
export interface BreachRecord {
  name: string;
  title: string;
  domain: string | null;
  breachDate: string | null;
  pwnCount: bigint;
  dataClasses: string[];
  verified: boolean;
}

export interface ExposureData {
  subject: string;
  breachCount: number;
  breaches: BreachRecord[];
}
