import { z } from "zod";
import type { DatasetHit, Subject } from "@scout/sources";
import { dedupeEntities, extractEntities, requireSource } from "@scout/sources";

export const intelxSource = requireSource("intelligence-x");

/**
 * Intelligence X splits accounts across API instances, and a key issued for
 * one returns 401 against another — which reads as a bad key when it is a
 * wrong address. Free accounts live on `free.intelx.io`, paid ones on
 * `2.intelx.io`; nothing in the key says which.
 *
 * So rather than making the operator find this out, both are tried: the
 * configured or default host first, and the other one only on a 401. One extra
 * request in the wrong-host case, none in the right-host case, and a genuinely
 * invalid key still ends up reported as 401.
 */
const FALLBACK_HOSTS = ["https://free.intelx.io", "https://2.intelx.io"];

function hosts(): string[] {
  const configured = process.env["INTELX_BASE_URL"]?.trim().replace(/\/$/, "");
  const ordered =
    configured !== undefined && configured.length > 0
      ? [configured, ...FALLBACK_HOSTS]
      : FALLBACK_HOSTS;
  return [...new Set(ordered)];
}
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
  // The start call also settles which host this key belongs to.
  let base = "";
  let id = "";
  let lastStatus = 0;

  for (const host of hosts()) {
    const started = await fetch(`${host}/intelligent/search`, {
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

    if (started.ok) {
      base = host;
      id = searchStartSchema.parse(await started.json()).id;
      break;
    }

    lastStatus = started.status;
    // Only a 401 is worth trying elsewhere — it is the wrong-instance
    // signature. Any other status is a real failure at the right host.
    if (started.status !== 401) break;
  }

  if (base === "" || id === "") {
    throw new Error(
      lastStatus === 401
        ? "Intelligence X rejected the key on every known API instance (401). " +
          "Check the API URL on your Developer tab and set INTELX_BASE_URL."
        : `Intelligence X responded ${lastStatus}`,
    );
  }

  for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt += 1) {
    const response = await fetch(
      `${base}/intelligent/search/result?id=${encodeURIComponent(id)}&limit=50`,
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
