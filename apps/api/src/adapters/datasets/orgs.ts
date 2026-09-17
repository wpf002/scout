import type { DatasetObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const gleifSource = requireSource("gleif");
export const proPublicaSource = requireSource("propublica-990");

const TIMEOUT_MS = 20_000;
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Responded ${response.status}`);
  return response.json();
}

// ── GLEIF ─────────────────────────────────────────────────────────────────

/**
 * The Global Legal Entity Identifier Foundation.
 *
 * The LEI is the closest thing to a global company primary key: one identifier
 * for a legal entity across jurisdictions, with its registered name, address
 * and status. Where SEC EDGAR is US filings and OpenCorporates is registries,
 * GLEIF is the identity spine that ties them together, and it is keyless.
 */
export function normalizeGleif(raw: unknown, term: string): DatasetObservation[] {
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const attrs = (item as Record<string, unknown>)["attributes"];
    if (typeof attrs !== "object" || attrs === null) return [];
    const a = attrs as Record<string, unknown>;
    const entity = (a["entity"] ?? {}) as Record<string, unknown>;
    const name = (entity["legalName"] as Record<string, unknown> | undefined)?.["name"];
    if (typeof name !== "string") return [];

    const addr = (entity["legalAddress"] ?? {}) as Record<string, unknown>;
    const where = [addr["city"], addr["region"], addr["country"]]
      .filter((x): x is string => typeof x === "string" && x !== "")
      .join(", ");
    const lei = typeof a["lei"] === "string" ? a["lei"] : null;

    return [{
      kind: "dataset-hit",
      datasetId: "gleif",
      title: name,
      entityType: typeof entity["status"] === "string" ? `LEI ${entity["status"]}` : "LEI",
      matchedTerm: term,
      url: lei === null ? null : `https://search.gleif.org/#/record/${lei}`,
      date: null,
      excerpt: [lei === null ? null : `LEI ${lei}`, where === "" ? null : where]
        .filter((x): x is string => x !== null && x !== "")
        .join(" · "),
      entities: [],
    }];
  });
}

export async function fetchGleif(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];
  const url =
    "https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=25&filter%5Bentity.legalName%5D=" +
    encodeURIComponent(term);
  return normalizeGleif(await getJson(url), term);
}

// ── ProPublica Nonprofit Explorer (Form 990) ────────────────────────────────

/**
 * ProPublica's Nonprofit Explorer — every US tax-exempt organization's Form
 * 990. The search names the org, its city and its EIN; the linked record on
 * ProPublica carries the officers and their compensation, which is the part
 * that makes a nonprofit a place to look at people.
 *
 * Open for a company; gated for a person, since a named individual turning up
 * here is an officer or director — a fact about a person.
 */
export function normalizeProPublica(raw: unknown, term: string): DatasetObservation[] {
  const orgs = (raw as { organizations?: unknown }).organizations;
  if (!Array.isArray(orgs)) return [];

  return orgs.slice(0, 40).flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"] : null;
    if (name === null) return [];

    const ein = o["ein"];
    const where = [o["city"], o["state"]]
      .filter((x): x is string => typeof x === "string" && x !== "")
      .join(", ");

    return [{
      kind: "dataset-hit",
      datasetId: "propublica-990",
      title: name,
      entityType: typeof o["ntee_code"] === "string" ? o["ntee_code"] : "Nonprofit",
      matchedTerm: term,
      url: ein == null ? null : `https://projects.propublica.org/nonprofits/organizations/${ein}`,
      date: null,
      excerpt: [where === "" ? null : where, ein == null ? null : `EIN ${ein}`]
        .filter((x): x is string => x !== null && x !== "")
        .join(" · "),
      entities: [],
    }];
  });
}

export async function fetchProPublica(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];
  const url =
    "https://projects.propublica.org/nonprofits/api/v2/search.json?q=" + encodeURIComponent(term);
  return normalizeProPublica(await getJson(url), term);
}
