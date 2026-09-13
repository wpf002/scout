import { z } from "zod";
import type { Subject } from "@scout/sources";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { cached } from "../../live/cache.js";
import { getJson } from "../../live/http.js";

/**
 * SEC EDGAR company registry: the first public-records adapter.
 *
 * Jurisdiction: United States, federal securities filings. Every registrant
 * has a Central Index Key, a name and, where listed, a ticker. The data is a
 * US government work in the public domain; the SEC's access policy asks for
 * a declared User-Agent naming a contact and no more than ten requests a
 * second. The whole registry is one file, cached for a day, so a run is one
 * request at most.
 *
 * `SEC_EDGAR_USER_AGENT` must be set to something like
 * "Scout (Your Org) contact@your.org". Without it the collector is inert:
 * sending a made-up contact would break the policy the terms rely on.
 */

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
export const SEC_USER_AGENT_ENV = "SEC_EDGAR_USER_AGENT";

const TICKERS_SCHEMA = z.record(
  z.string(),
  z.object({ cik_str: z.number().int(), ticker: z.string(), title: z.string() }),
);

export interface EdgarCompany {
  /** Ten digits, zero-padded, as EDGAR prints it. */
  cik: string;
  ticker: string;
  title: string;
}

export async function fetchCompanies(userAgent: string): Promise<EdgarCompany[]> {
  return cached("sec:company_tickers", 24 * 60 * 60_000, async () => {
    const body = await getJson(TICKERS_URL, {
      timeoutMs: 20_000,
      headers: { "user-agent": userAgent },
    });
    return Object.values(TICKERS_SCHEMA.parse(body)).map((row) => ({
      cik: String(row.cik_str).padStart(10, "0"),
      ticker: row.ticker,
      title: row.title,
    }));
  });
}

const MAX_MATCHES = 25;

/**
 * Companies matching a subject. A numeric subject is a CIK; anything else is
 * matched as a case-insensitive substring of the registered name, capped so
 * "Inc" does not return the registry.
 */
export function matchCompanies(companies: readonly EdgarCompany[], subject: Subject): EdgarCompany[] {
  const needle = subject.value.trim().toLowerCase();
  if (needle.length === 0) return [];
  if (/^\d+$/.test(needle)) {
    const cik = needle.padStart(10, "0");
    return companies.filter((c) => c.cik === cik);
  }
  return companies.filter((c) => c.title.toLowerCase().includes(needle)).slice(0, MAX_MATCHES);
}

export function normalizeCompanies(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const rows = Array.isArray(raw) ? (raw as EdgarCompany[]) : [];
  return rows.map((c) => ({
    sourceId: secEdgarCollector.id,
    authorizationId: meta.authorizationId,
    collectedAt: meta.collectedAt,
    // The registry file carries no per-record time. The observation is dated
    // to the collection and says so, rather than inventing a filing date.
    observedAt: meta.collectedAt,
    rawPayload: c,
    normalizedPayload: {
      registry: "SEC EDGAR",
      jurisdiction: "US",
      cik: c.cik,
      ticker: c.ticker,
      title: c.title,
      observedAtBasis: "collection",
    },
    position: null,
    confidenceBp: null,
    indeterminate: false,
    ...(meta.caseId === undefined ? {} : { caseId: meta.caseId }),
    identifiers: [
      { kind: "NAME", value: c.title },
      { kind: "DOCUMENT_NO", value: `CIK${c.cik}` },
    ],
  }));
}

export const secEdgarCollector = {
  ...defineCollector(
    {
      id: "sec-edgar",
      name: "SEC EDGAR company registry (US)",
      sourceClass: "PUBLIC_RECORD",
      licensingTerms:
        "United States government work, public domain (17 U.S.C. § 105). SEC fair-access policy applies: " +
        "a declared User-Agent with a contact, and at most ten requests per second.",
      tosUrl: "https://www.sec.gov/os/accessing-edgar-data",
      refreshCadenceSeconds: 86_400,
      rateLimit: { perMinute: 60 },
      temporalLagSeconds: 86_400,
    },
    normalizeCompanies,
  ),
  entityKind: "ORG" as const,
  subjectRequired: true,
  configuredBy: SEC_USER_AGENT_ENV,
  async fetch(input: { subject?: Subject | undefined }): Promise<unknown> {
    const userAgent = process.env[SEC_USER_AGENT_ENV]?.trim();
    if (userAgent === undefined || userAgent.length === 0) {
      throw new Error(
        `${SEC_USER_AGENT_ENV} is not set. The SEC requires a declared User-Agent with a contact; Scout will not invent one.`,
      );
    }
    if (input.subject === undefined) return [];
    return matchCompanies(await fetchCompanies(userAgent), input.subject);
  },
};
