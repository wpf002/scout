import type { Subject } from "@scout/sources";
import {
  CollectorRegistry,
  type Collector,
  type FusionEntityKind,
  type IdentifierKind,
} from "@scout/fusion";
import { prisma } from "@scout/db";
import { adsbCollector } from "./adsb.js";
import { secEdgarCollector } from "./sec-edgar.js";

/**
 * A collector the API can actually run.
 *
 * `@scout/fusion` defines a collector as a declaration plus a pure
 * `normalize`. The API adds the part that talks to the world: `fetch`, which
 * returns whatever `normalize` expects. Keeping fetch out of the package
 * keeps the package free of upstream code, and keeps both existing connector
 * systems (the case-tier registry and the live map) untouched — a fetch here
 * calls into them rather than duplicating them.
 */
export interface RunnableCollector extends Collector {
  /** What this collector produces entities of. Checked against the boundary. */
  entityKind: FusionEntityKind;
  /** Whether a subject is required, and therefore checked against scope. */
  subjectRequired: boolean;
  /**
   * Env var this collector needs to be configured, if any. Absent means the
   * collector reports itself inert rather than guessing (locked invariant 6).
   */
  configuredBy?: string;
  fetch(input: { subject?: Subject | undefined }): Promise<unknown>;
}

export const collectors = new CollectorRegistry();
collectors.register(adsbCollector);
collectors.register(secEdgarCollector);

export function getRunnable(id: string): RunnableCollector | undefined {
  return collectors.get(id) as RunnableCollector | undefined;
}

export function listRunnable(): readonly RunnableCollector[] {
  return collectors.list() as readonly RunnableCollector[];
}

/** Whether the collector's configuration is present. */
export function isConfigured(collector: RunnableCollector): boolean {
  if (collector.configuredBy === undefined) return true;
  const value = process.env[collector.configuredBy];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Records the collector in the database so every observation can be traced to
 * a licence. Idempotent; a re-registration updates the terms.
 */
export async function ensureCollectionSource(collector: RunnableCollector): Promise<void> {
  const data = {
    name: collector.name,
    class: collector.sourceClass,
    licensingTerms: collector.licensingTerms,
    tosUrl: collector.tosUrl ?? null,
    refreshCadenceSeconds: collector.refreshCadenceSeconds,
    spatialResolutionMeters: collector.spatialResolutionMeters ?? null,
    temporalLagSeconds: collector.temporalLagSeconds ?? null,
    credentialsRef: collector.credentialsRef ?? collector.configuredBy ?? null,
  };
  await prisma.collectionSource.upsert({
    where: { id: collector.id },
    update: data,
    create: { id: collector.id, ...data },
  });
}

/**
 * The naive normalizer, version "naive-1".
 *
 * Enough to make exact matches find each other: case folding, whitespace,
 * digits-only phones. The real per-kind normalizers (E.164, provider dot
 * rules, transliteration, libpostal) live in services/resolution and carry
 * their own version, so a record normalized here is re-normalized there and
 * the version on the row says which happened.
 */
export const NORMALIZATION_VERSION = "naive-1";

export function naiveNormalize(kind: IdentifierKind, value: string): string {
  const trimmed = value.trim();
  switch (kind) {
    case "PHONE":
      return trimmed.replace(/\D/g, "");
    case "ICAO_HEX":
    case "EMAIL":
    case "HANDLE":
    case "DOMAIN":
    case "URL":
    case "NAME":
    case "ADDRESS":
      return trimmed.replace(/\s+/g, " ").toLowerCase();
    case "TAIL_NUMBER":
    case "PLATE":
    case "MMSI":
    case "IMO":
    case "DOCUMENT_NO":
    case "HASH":
    case "DEVICE_ID":
    case "IP":
      return trimmed.replace(/\s+/g, "").toUpperCase();
  }
}
