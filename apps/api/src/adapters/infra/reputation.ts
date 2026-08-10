import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";
import { resolveAddresses } from "./resolve.js";

/**
 * Reputation sources — whether an address is known to be doing something.
 *
 * Everything else here answers "what exists". These answer "is it bad", which
 * is a different question with different failure modes. A blocklist hit on a
 * shared-hosting address tells you about a neighbour, not the target; an
 * absence from every feed means almost nothing, because feeds are thin and
 * stale. So verdicts are always attributed to the service that made them and
 * never collapsed into a score of Scout's own invention.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

/** Addresses checked per domain. These are per-address lookups. */
const MAX_ADDRESSES = 3;

// ── GreyNoise ──────────────────────────────────────────────────────────────

export const greyNoiseSource = requireSource("greynoise");

const greyNoiseSchema = z.object({
  ip: z.string(),
  noise: z.boolean().default(false),
  riot: z.boolean().default(false),
  classification: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  link: z.string().nullable().default(null),
  last_seen: z.string().nullable().default(null),
});

export type GreyNoiseRecord = z.infer<typeof greyNoiseSchema>;

/**
 * GreyNoise answers the question that wastes the most investigative time: is
 * this address aimed at me, or is it spraying the whole internet?
 *
 * `riot` means known-good service infrastructure — a Google crawler, a CDN
 * health check. `noise` means indiscriminate scanning. Neither is a finding
 * about the target, and saying so is the point: an analyst who chases every
 * scanner in their logs has been given busywork by their tooling.
 */
export function normalizeGreyNoise(
  record: GreyNoiseRecord,
): InfraObservation[] {
  const verdict = record.riot
    ? "Known-good service infrastructure"
    : record.noise
      ? `Internet-wide scanner (${record.classification ?? "unclassified"})`
      : "Not observed scanning";

  return [
    {
      kind: "reputation",
      ip: record.ip,
      verdict,
      actor: record.name === "unknown" ? null : record.name,
      noise: record.noise,
      benign: record.riot || record.classification === "benign",
      lastSeen: record.last_seen,
      reportUrl: record.link,
    },
  ];
}

export async function fetchGreyNoise(
  subject: Subject,
): Promise<InfraObservation[]> {
  const value = subject.value.trim().toLowerCase();
  const addresses =
    subject.kind === "ip" ? [value] : await resolveAddresses(value, MAX_ADDRESSES);

  const observations: InfraObservation[] = [];

  for (const address of addresses) {
    const response = await fetch(
      `https://api.greynoise.io/v3/community/${encodeURIComponent(address)}`,
      {
        headers: { accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    // 404 is GreyNoise's "never seen this address", which is an answer rather
    // than a failure — and the most common one for ordinary infrastructure.
    if (response.status === 404) continue;
    if (response.status === 429) {
      throw new Error("GreyNoise rate limit reached for this address.");
    }
    if (!response.ok) {
      throw new Error(`GreyNoise responded ${response.status}`);
    }

    observations.push(
      ...normalizeGreyNoise(greyNoiseSchema.parse(await response.json())),
    );
  }

  return observations;
}

// ── Feodo Tracker ──────────────────────────────────────────────────────────

export const feodoSource = requireSource("feodo");

const feodoSchema = z.array(
  z.object({
    ip_address: z.string(),
    port: z.number().int().nullable().default(null),
    status: z.string().nullable().default(null),
    malware: z.string().nullable().default(null),
    last_online: z.string().nullable().default(null),
  }),
);

/**
 * The whole list, cached.
 *
 * Feodo publishes a blocklist file rather than a lookup endpoint, so the
 * choice is one download per run or one download per hour. It is a few
 * hundred entries; fetching it per address would be rude to a service that
 * gives this away for free.
 */
let cache: { at: number; byIp: Map<string, string> } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

export function indexFeodo(rows: z.infer<typeof feodoSchema>): Map<string, string> {
  const byIp = new Map<string, string>();
  for (const row of rows) {
    const detail = [
      row.malware ?? "botnet C2",
      row.port === null ? null : `port ${row.port}`,
      row.status,
      row.last_online === null ? null : `last online ${row.last_online}`,
    ]
      .filter((part): part is string => part !== null && part.length > 0)
      .join(" · ");
    byIp.set(row.ip_address, detail);
  }
  return byIp;
}

/** Exposed so a test can start from a known state. */
export function clearFeodoCache(): void {
  cache = null;
}

async function feodoIndex(): Promise<Map<string, string>> {
  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.byIp;

  const response = await fetch(
    "https://feodotracker.abuse.ch/downloads/ipblocklist.json",
    {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`Feodo Tracker responded ${response.status}`);
  }

  const byIp = indexFeodo(feodoSchema.parse(await response.json()));
  cache = { at: Date.now(), byIp };
  return byIp;
}

export async function fetchFeodo(
  subject: Subject,
): Promise<InfraObservation[]> {
  const value = subject.value.trim().toLowerCase();
  const addresses =
    subject.kind === "ip" ? [value] : await resolveAddresses(value, MAX_ADDRESSES);

  if (addresses.length === 0) return [];

  const byIp = await feodoIndex();
  const observations: InfraObservation[] = [];

  for (const address of addresses) {
    const detail = byIp.get(address);
    if (detail === undefined) continue;

    observations.push({
      kind: "reputation",
      ip: address,
      verdict: `Listed as botnet command-and-control: ${detail}`,
      actor: null,
      noise: false,
      benign: false,
      lastSeen: null,
      reportUrl: `https://feodotracker.abuse.ch/browse/host/${encodeURIComponent(address)}/`,
    });
  }

  return observations;
}
