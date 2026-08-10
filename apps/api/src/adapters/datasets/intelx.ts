import { z } from "zod";
import type { DatasetHit, Subject } from "@scout/sources";
import { dedupeEntities, extractEntities, requireSource } from "@scout/sources";

export const intelxSource = requireSource("intelligence-x");

/**
 * Intelligence X assigns each account its own API instance, and the host is
 * shown on the account's Developer tab alongside the key. `2.intelx.io` is the
 * common one but it is not universal — a key issued against a different
 * instance returns 401 here, which reads as a bad key when it is a wrong
 * address. Override with INTELX_BASE_URL when the Developer tab shows another.
 */
const BASE = (
  process.env["INTELX_BASE_URL"]?.trim() ?? "https://2.intelx.io"
).replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 20_000;
/** How long to wait for the provider's async search to settle. */
const RESULT_ATTEMPTS = 4;
const RESULT_DELAY_MS = 700;

const searchStartSchema = z.object({ id: z.string() });

const recordSchema = z.object({
  systemid: z.string().default(""),
  name: z.string().default(""),
  description: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  bucket: z.string().default(""),
  media: z.number().int().nullable().default(null),
  typeh: z.string().nullable().default(null),
});

const resultSchema = z.object({
  records: z.array(recordSchema).default([]),
  status: z.number().int().default(0),
});

export type IntelxResult = z.infer<typeof resultSchema>;

/**
 * Intelligence X classifies each record by "bucket" — the collection it came
 * from. That bucket is the provenance an investigator actually needs: a hit in
 * `leaks.public` means something very different from one in `pastes`.
 */
export function normalizeIntelx(
  payload: IntelxResult,
  matchedTerm: string,
): DatasetHit[] {
  return payload.records.map((record) => {
    const excerpt = record.description;
    return {
      kind: "dataset-hit" as const,
      datasetId: record.bucket.length > 0 ? record.bucket : "intelx",
      title: record.name.length > 0 ? record.name : record.systemid,
      entityType: record.typeh,
      matchedTerm,
      // The provider's viewer, for the investigator to open themselves.
      url:
        record.systemid.length > 0
          ? `https://intelx.io/?did=${encodeURIComponent(record.systemid)}`
          : null,
      date: record.date,
      excerpt,
      // Pattern-matched out of free text, so medium confidence and offered as
      // a suggestion — never auto-linked into the case.
      entities: dedupeEntities([
        ...extractEntities(record.name, intelxSource.id),
        ...extractEntities(excerpt, intelxSource.id),
      ]),
    };
  });
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchIntelx(subject: Subject): Promise<DatasetHit[]> {
  const key = process.env["INTELX_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("INTELX_API_KEY is not configured");
  }

  const term = subject.value.trim();
  const headers = {
    "x-key": key,
    "content-type": "application/json",
    accept: "application/json",
  };

  // Intelligence X search is two-step: start a search, then poll for results.
  const started = await fetch(`${BASE}/intelligent/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      term,
      maxresults: 50,
      media: 0,
      sort: 4,
      terminate: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!started.ok) {
    throw new Error(`Intelligence X responded ${started.status}`);
  }

  const { id } = searchStartSchema.parse(await started.json());

  for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt += 1) {
    const response = await fetch(
      `${BASE}/intelligent/search/result?id=${encodeURIComponent(id)}&limit=50`,
      { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );

    if (!response.ok) {
      throw new Error(`Intelligence X responded ${response.status}`);
    }

    const payload = resultSchema.parse(await response.json());

    // status 0 = results present, 1 = no more, 2 = still running.
    if (payload.status !== 2 || payload.records.length > 0) {
      return normalizeIntelx(payload, term);
    }
    await sleep(RESULT_DELAY_MS);
  }

  // Timed out waiting. Report nothing found rather than inventing partial
  // results — an empty answer the investigator can retry beats a wrong one.
  return [];
}
