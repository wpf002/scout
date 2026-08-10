import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const crtshSource = requireSource("crtsh");

const REQUEST_TIMEOUT_MS = 20_000;

/** crt.sh returns one row per certificate/name pairing. */
const rowSchema = z.object({
  common_name: z.string().nullable().default(null),
  name_value: z.string().nullable().default(null),
  issuer_name: z.string().nullable().default(null),
  serial_number: z.string().nullable().default(null),
  not_before: z.string().nullable().default(null),
  not_after: z.string().nullable().default(null),
});

export type CrtshRow = z.infer<typeof rowSchema>;

const rowsSchema = z.array(rowSchema);

/**
 * Turns crt.sh rows into normalized observations.
 *
 * Each row yields one cert observation plus a subdomain observation for every
 * name on it — `name_value` is newline-separated and routinely holds the SANs
 * that make CT logs a subdomain oracle in the first place.
 *
 * Wildcards are recorded as certificate names but never as subdomains:
 * `*.example.com` is not a host you can resolve, and emitting it as one would
 * put a thing that does not exist onto the findings board.
 */
export function normalizeCrtsh(
  rows: readonly CrtshRow[],
  subject: string,
): InfraObservation[] {
  const observations: InfraObservation[] = [];
  const apex = subject.trim().toLowerCase().replace(/^\*\./, "");

  for (const row of rows) {
    const names = [...new Set(
      (row.name_value ?? "")
        .split("\n")
        .concat(row.common_name ?? "")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0),
    )].sort();

    if (names.length > 0 || row.common_name !== null) {
      observations.push({
        kind: "cert",
        serial: row.serial_number,
        commonName: row.common_name ?? (names[0] ?? apex),
        names,
        issuer: row.issuer_name,
        notBefore: row.not_before,
        notAfter: row.not_after,
      });
    }

    for (const name of names) {
      if (name.startsWith("*.")) continue;
      // Only names actually under the subject — CT rows can carry unrelated
      // SANs, and those are not this domain's subdomains.
      if (name !== apex && !name.endsWith(`.${apex}`)) continue;
      observations.push({
        kind: "subdomain",
        hostname: name,
        firstSeen: row.not_before,
        lastSeen: row.not_after,
      });
    }
  }

  return observations;
}

/**
 * crt.sh, with retries.
 *
 * It returns a 502 under load often enough that a single attempt fails more
 * than it succeeds — three consecutive probes during development returned
 * 200, 502, 502. It is also the only source that produces data with no key at
 * all, so on an unkeyed install its flakiness is the difference between a
 * result table and an empty one.
 *
 * Retries only what is worth retrying: a 502/503/504 or a transport error is
 * transient, while a 4xx means the request itself was wrong and will be just
 * as wrong the second time.
 */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;
const BACKOFF_MS = 700;

async function fetchWithRetry(url: string): Promise<string> {
  let last = "";

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Scout-OSINT/0.1 (+authorized-engagement-tooling)",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) return await response.text();

      last = `crt.sh responded ${response.status}`;
      if (!RETRY_STATUSES.has(response.status)) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    if (attempt < ATTEMPTS) {
      await new Promise((resolve) =>
        setTimeout(resolve, BACKOFF_MS * attempt),
      );
    }
  }

  throw new Error(last === "" ? "crt.sh could not be reached" : last);
}

export async function fetchCrtsh(
  subject: Subject,
): Promise<InfraObservation[]> {
  const domain = subject.value.trim().toLowerCase();
  // `q=domain`, not `q=%.domain`.
  //
  // The wildcard form asks crt.sh's Postgres for a prefix scan across the CT
  // corpus, which is expensive enough to exceed their gateway timeout when the
  // service is under load — and it is under load most of the time. The plain
  // identity query is far cheaper and returns the same names: crt.sh matches
  // the domain against certificate identities, so every subdomain that appears
  // in a CN or SAN comes back anyway. Measured on betterman.com: the plain
  // query returned 352 certificates covering 11 distinct names including
  // store, staging, hubdev and img.emaildelivery, while the wildcard form
  // returned 502 on five attempts out of five.
  const url = `https://crt.sh/?q=${encodeURIComponent(domain)}&output=json`;

  const text = await fetchWithRetry(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("crt.sh returned a non-JSON body");
  }

  return normalizeCrtsh(rowsSchema.parse(parsed), domain);
}
