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

/* ── infrastructure tier ─────────────────────────────────────────────────
 *
 * Every infra source normalizes into one of these three shapes, so Shodan,
 * Censys, SecurityTrails and crt.sh all feed a single board instead of four
 * source-shaped silos. Adding an infra source means writing a normalizer, not
 * a new view.
 */

export interface HostObservation {
  kind: "host";
  ip: string;
  hostnames: string[];
  /** Integers. Counted/enumerated things never become floats. */
  ports: number[];
  org: string | null;
  asn: string | null;
  country: string | null;
  lastSeen: string | null;
}

export interface SubdomainObservation {
  kind: "subdomain";
  hostname: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface CertObservation {
  kind: "cert";
  serial: string | null;
  commonName: string;
  /** Every name on the certificate, including SANs. */
  names: string[];
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
}

export type InfraObservation =
  | HostObservation
  | SubdomainObservation
  | CertObservation;

/** One observation plus every source that reported it. */
export interface AttributedObservation {
  observation: InfraObservation;
  /** Never empty. Dedupe unions these rather than picking a winner. */
  sourceIds: string[];
}

/**
 * Identity for dedupe purposes. Two observations with the same key are the
 * same real-world thing seen by different sources.
 */
export function observationKey(observation: InfraObservation): string {
  switch (observation.kind) {
    case "host":
      return `host:${observation.ip}`;
    case "subdomain":
      return `subdomain:${observation.hostname.toLowerCase()}`;
    case "cert":
      // Serial is the real identity; fall back to CN + validity window for
      // sources that do not expose one.
      return observation.serial !== null
        ? `cert:${observation.serial.toLowerCase()}`
        : `cert:${observation.commonName.toLowerCase()}:${observation.notBefore ?? ""}`;
  }
}

function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function unionPorts(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

/** Keeps whichever value actually says something. */
function coalesce(a: string | null, b: string | null): string | null {
  return a !== null && a.length > 0 ? a : b;
}

/**
 * Puts a single observation into canonical form: lowercased names, sorted and
 * deduped lists.
 *
 * Applied on the way in, not only when two sources collide — otherwise a
 * hostname seen by exactly one source would keep whatever shape that adapter
 * happened to produce, and the board would be uniform only by luck.
 */
function canonicalize(observation: InfraObservation): InfraObservation {
  switch (observation.kind) {
    case "host":
      return {
        ...observation,
        hostnames: unionSorted(observation.hostnames, []),
        ports: unionPorts(observation.ports, []),
      };
    case "subdomain":
      return {
        ...observation,
        hostname: observation.hostname.trim().toLowerCase(),
      };
    case "cert":
      return { ...observation, names: unionSorted(observation.names, []) };
  }
}

function mergePair(
  a: InfraObservation,
  b: InfraObservation,
): InfraObservation {
  if (a.kind === "host" && b.kind === "host") {
    return {
      kind: "host",
      ip: a.ip,
      hostnames: unionSorted(a.hostnames, b.hostnames),
      ports: unionPorts(a.ports, b.ports),
      org: coalesce(a.org, b.org),
      asn: coalesce(a.asn, b.asn),
      country: coalesce(a.country, b.country),
      lastSeen: coalesce(a.lastSeen, b.lastSeen),
    };
  }
  if (a.kind === "subdomain" && b.kind === "subdomain") {
    return {
      kind: "subdomain",
      hostname: a.hostname,
      firstSeen: coalesce(a.firstSeen, b.firstSeen),
      lastSeen: coalesce(a.lastSeen, b.lastSeen),
    };
  }
  if (a.kind === "cert" && b.kind === "cert") {
    return {
      kind: "cert",
      serial: coalesce(a.serial, b.serial),
      commonName: a.commonName,
      names: unionSorted(a.names, b.names),
      issuer: coalesce(a.issuer, b.issuer),
      notBefore: coalesce(a.notBefore, b.notBefore),
      notAfter: coalesce(a.notAfter, b.notAfter),
    };
  }
  // Different kinds cannot collide — observationKey is prefixed by kind.
  return a;
}

/**
 * Merges observations from several sources into one deduped list.
 *
 * Attribution is a union, never a winner: if crt.sh and SecurityTrails both
 * report `admin.example.com`, the result names both. Dropping one would lose
 * provenance, and provenance is not optional (locked invariant 5).
 *
 * Input order is preserved for first-seen keys, so the output is stable.
 */
export function mergeObservations(
  items: readonly { sourceId: string; observation: InfraObservation }[],
): AttributedObservation[] {
  const merged = new Map<string, AttributedObservation>();

  for (const item of items) {
    const observation = canonicalize(item.observation);
    const key = observationKey(observation);
    const existing = merged.get(key);

    if (existing === undefined) {
      merged.set(key, { observation, sourceIds: [item.sourceId] });
      continue;
    }

    existing.observation = mergePair(existing.observation, observation);
    if (!existing.sourceIds.includes(item.sourceId)) {
      existing.sourceIds.push(item.sourceId);
    }
  }

  return [...merged.values()];
}
