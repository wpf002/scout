import type { DatasetObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

/**
 * Public-record lookups for people and companies.
 *
 * Person-name was Scout's thinnest subject by a distance: OpenSanctions was the
 * only API that would take one, and the other three "person" sources were
 * deeplinks — a browser tab, not an answer. A person-name investigation was a
 * single-source investigation.
 *
 * These three are all keyless and all genuinely queryable:
 *
 *   - Wikidata      — identity resolution. Turns a name into a Q-number with
 *                     cross-references to other registries.
 *   - CourtListener — US federal and state court records, by party name.
 *   - SEC EDGAR     — full-text search of corporate filings.
 *
 * Both record sources are gated for `person` and open for `company` via
 * `scopedKinds`. Searching a company in public filings is ordinary research;
 * searching a named individual in court records is person-facing, and the
 * scope gate is exactly the check that belongs there.
 */

export const wikidataSource = requireSource("wikidata");
export const courtListenerSource = requireSource("courtlistener");
export const secEdgarSource = requireSource("sec-edgar-fts");

const TIMEOUT_MS = 20_000;

/**
 * SEC and CourtListener both refuse anonymous callers. SEC's fair-access policy
 * asks for a contact address; CourtListener returns a connection error without
 * any UA at all. Scout identifies itself rather than pretending to be a browser.
 */
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Responded ${response.status}`);
  return response.json();
}

// ── Wikidata ────────────────────────────────────────────────────────────────

export function normalizeWikidata(raw: unknown, term: string): DatasetObservation[] {
  const search = (raw as { search?: unknown }).search;
  if (!Array.isArray(search)) return [];

  return search.flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const id = typeof row["id"] === "string" ? row["id"] : null;
    if (id === null) return [];
    const label = typeof row["label"] === "string" ? row["label"] : id;
    const description = typeof row["description"] === "string" ? row["description"] : null;

    return [{
      kind: "dataset-hit",
      datasetId: "wikidata",
      title: label,
      entityType: description,
      matchedTerm: term,
      url: `https://www.wikidata.org/wiki/${id}`,
      date: null,
      // The Q-number is the reason to use Wikidata at all: it is the join key
      // onto other registries, so it belongs in the row, not just the link.
      excerpt: description === null ? id : `${id} — ${description}`,
      entities: [],
    }];
  });
}

export async function fetchWikidata(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];
  const url =
    "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=20&search=" +
    encodeURIComponent(term);
  return normalizeWikidata(await getJson(url), term);
}

// ── CourtListener ───────────────────────────────────────────────────────────

export function normalizeCourtListener(raw: unknown, term: string): DatasetObservation[] {
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.slice(0, 50).flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const caseName =
      typeof row["caseName"] === "string"
        ? row["caseName"]
        : typeof row["case_name"] === "string"
          ? row["case_name"]
          : null;
    if (caseName === null) return [];

    const absolute = typeof row["absolute_url"] === "string" ? row["absolute_url"] : null;
    const court = typeof row["court"] === "string" ? row["court"] : null;
    const filed =
      typeof row["dateFiled"] === "string"
        ? row["dateFiled"]
        : typeof row["date_filed"] === "string"
          ? row["date_filed"]
          : null;
    const docket =
      typeof row["docketNumber"] === "string"
        ? row["docketNumber"]
        : typeof row["docket_number"] === "string"
          ? row["docket_number"]
          : null;

    return [{
      kind: "dataset-hit",
      datasetId: "courtlistener",
      title: caseName,
      entityType: court,
      matchedTerm: term,
      url: absolute === null ? null : `https://www.courtlistener.com${absolute}`,
      date: filed,
      excerpt: [court, docket].filter((x): x is string => x !== null && x !== "").join(" · ") || null,
      entities: [],
    }];
  });
}

export async function fetchCourtListener(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];
  // `type=r` is the RECAP corpus — dockets and filings, where a party name is
  // most likely to appear. Opinions (`type=o`) name far fewer parties.
  const url =
    "https://www.courtlistener.com/api/rest/v4/search/?type=r&order_by=score%20desc&q=" +
    encodeURIComponent(`"${term}"`);
  return normalizeCourtListener(await getJson(url), term);
}

// ── SEC EDGAR full-text ─────────────────────────────────────────────────────

export function normalizeEdgar(raw: unknown, term: string): DatasetObservation[] {
  const hits = (raw as { hits?: { hits?: unknown } }).hits?.hits;
  if (!Array.isArray(hits)) return [];

  return hits.slice(0, 50).flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const src = (row["_source"] ?? {}) as Record<string, unknown>;

    const names = Array.isArray(src["display_names"])
      ? (src["display_names"] as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
    const form = typeof src["form"] === "string" ? src["form"] : null;
    const filed = typeof src["file_date"] === "string" ? src["file_date"] : null;
    const id = typeof row["_id"] === "string" ? row["_id"] : null;

    // "_id" is "<accession>:<document>". The accession, undashed, addresses the
    // filing directory on sec.gov.
    let url: string | null = null;
    const cik = Array.isArray(src["ciks"]) && typeof src["ciks"][0] === "string" ? src["ciks"][0] : null;
    if (id !== null && cik !== null) {
      const [accession, document] = id.split(":");
      if (accession !== undefined) {
        const bare = accession.replace(/-/g, "");
        url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${document ?? ""}`;
      }
    }

    return [{
      kind: "dataset-hit",
      datasetId: "sec-edgar",
      title: names[0] ?? form ?? "Filing",
      entityType: form,
      matchedTerm: term,
      url,
      date: filed,
      excerpt: names.length > 1 ? names.join(" · ") : (form ?? null),
      entities: [],
    }];
  });
}

export async function fetchEdgarFullText(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${term}"`)}`;
  return normalizeEdgar(await getJson(url), term);
}
