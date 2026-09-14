import type { z } from "zod";
import type { Subject } from "@scout/sources";
import {
  CollectorRegistry,
  defineCollector,
  type Collector,
  type FusionEntityKind,
  type IdentifierKind,
} from "@scout/fusion";
import { prisma } from "@scout/db";
import { adsbCollector } from "./adsb.js";
import { aisCollector } from "./ais.js";
import { secEdgarCollector } from "./sec-edgar.js";
import { openWebCollector } from "./open-web.js";
import { telemetryCollector } from "./telemetry.js";
import { sentinel2Collector } from "./sentinel2.js";

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
  /**
   * The collector's own parameters, parsed by the route before anything runs
   * so a malformed request is a 400 rather than an audited upstream error.
   */
  paramsSchema?: z.ZodType<unknown>;
  fetch(input: CollectInput): Promise<unknown>;
}

/** What a run is given: the subject, if any, the collector's own parameters, and whose run it is. */
export interface CollectInput {
  subject?: Subject | undefined;
  params?: Record<string, unknown> | undefined;
  authorizationId: string;
  caseId: string;
}

export const collectors = new CollectorRegistry();
collectors.register(adsbCollector);
collectors.register(aisCollector);
collectors.register(secEdgarCollector);
collectors.register(openWebCollector);
collectors.register(telemetryCollector);
collectors.register(sentinel2Collector);

/**
 * A licensed broker is an adapter interface, not a vendor. One registers
 * with a contract reference and the terms it operates under, or not at all;
 * Scout ships no broker and hardcodes none.
 */
export interface BrokerAdapterInput {
  id: string;
  name: string;
  /** The contract this adapter operates under. Required; a broker without one does not register. */
  contractRef: string;
  tosUrl: string;
  licensingTerms: string;
  refreshCadenceSeconds: number;
  entityKind: FusionEntityKind;
  credentialsEnv: string;
  fetch: RunnableCollector["fetch"];
  normalize: Collector["normalize"];
}

export function defineBrokerAdapter(input: BrokerAdapterInput): RunnableCollector {
  if (input.contractRef.trim().length === 0) {
    throw new Error(`Broker adapter "${input.id}" has no contract reference. A licensed broker registers under a contract or not at all.`);
  }
  if (input.credentialsEnv.trim().length === 0) {
    throw new Error(`Broker adapter "${input.id}" names no credentials variable; a broker without credentials cannot be run and should not be registered.`);
  }
  const base = defineCollector(
    {
      id: input.id,
      name: input.name,
      sourceClass: "BROKER",
      licensingTerms: `${input.licensingTerms} Contract: ${input.contractRef}.`,
      tosUrl: input.tosUrl,
      refreshCadenceSeconds: input.refreshCadenceSeconds,
      rateLimit: { perMinute: 30 },
      credentialsRef: input.credentialsEnv,
    },
    input.normalize,
  );
  return { ...base, entityKind: input.entityKind, subjectRequired: true, configuredBy: input.credentialsEnv, fetch: input.fetch };
}

export function registerBroker(adapter: RunnableCollector): void {
  if (adapter.sourceClass !== "BROKER") throw new Error(`${adapter.id} is not a broker adapter.`);
  collectors.register(adapter);
}

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
