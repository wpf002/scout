import type { DatasetObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const fecSource = requireSource("fec");

/**
 * FEC individual contributions.
 *
 * The single richest free source for putting a name to a place of work. Every
 * itemised contribution above $200 carries the donor's name, city, state, zip
 * and — the part nothing else public gives you — their **employer and
 * occupation**, self-reported and required by law.
 *
 * That combination is why this belongs in the person tier rather than the
 * company one. An employer plus a city plus a zip is an identity claim about a
 * named individual, so it is scope-gated for `person` and open for `company`,
 * where the question is instead who gives money on a company's behalf.
 *
 * Names are stored surname-first ("SMITH, BARRY"). A plain "Barry Smith" search
 * returns nothing at all, silently, which is the kind of empty result that
 * reads as "no record" rather than "wrong format" — so both orderings are
 * tried.
 */

const BASE = "https://api.open.fec.gov/v1/schedules/schedule_a/";
const TIMEOUT_MS = 25_000;

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

interface Contribution {
  contributor_name?: string;
  contributor_employer?: string | null;
  contributor_occupation?: string | null;
  contributor_city?: string | null;
  contributor_state?: string | null;
  contributor_zip?: string | null;
  contribution_receipt_amount?: number | null;
  contribution_receipt_date?: string | null;
  committee?: { name?: string | null } | null;
  transaction_id?: string | null;
  sub_id?: string | null;
}

export function normalizeFec(raw: unknown, term: string): DatasetObservation[] {
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Contribution;
    const name = row.contributor_name?.trim();
    if (name === undefined || name === "") return [];

    const where = [row.contributor_city, row.contributor_state, row.contributor_zip]
      .map((x) => x?.trim())
      .filter((x): x is string => x !== undefined && x !== "")
      .join(", ");

    return [{
      kind: "dataset-hit",
      datasetId: "fec",
      title: name,
      // Employer is the reason to look here at all, so it leads.
      entityType: row.contributor_employer?.trim() || null,
      matchedTerm: term,
      url: null,
      date: row.contribution_receipt_date ?? null,
      excerpt: [
        row.contributor_occupation?.trim() || null,
        row.contributor_employer?.trim() || null,
        where === "" ? null : where,
        row.contribution_receipt_amount == null
          ? null
          : money.format(row.contribution_receipt_amount),
        row.committee?.name ?? null,
      ]
        .filter((x): x is string => x !== null && x !== "")
        .join(" · "),
      entities: [],
    }];
  });
}

/** "Barry Smith" as FEC stores it. A single token is left alone. */
export function surnameFirst(term: string): string | null {
  const parts = term.trim().split(/\s+/).filter((p) => p !== "");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1] as string;
  const rest = parts.slice(0, -1).join(" ");
  return `${last}, ${rest}`.toUpperCase();
}

async function ask(term: string, key: string): Promise<DatasetObservation[]> {
  const url =
    `${BASE}?api_key=${encodeURIComponent(key)}` +
    `&contributor_name=${encodeURIComponent(term)}` +
    `&per_page=40&sort=-contribution_receipt_date`;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 429) {
    throw new Error("FEC rate limit reached. DEMO_KEY allows 30 requests an hour; set FEC_API_KEY.");
  }
  if (!response.ok) throw new Error(`FEC responded ${response.status}`);
  return normalizeFec(await response.json(), term);
}

export async function fetchFec(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];

  // The registry declares FEC_API_KEY, so Scout reports this inert when it is
  // unset and never reaches here — which is invariant 6 working. No silent
  // DEMO_KEY fallback: thirty requests an hour looks like a working source
  // right up until it stops, and "inert" is the honest state for that.
  const key = process.env["FEC_API_KEY"]?.trim() ?? "";
  if (key === "") throw new Error("FEC_API_KEY is not set");

  const flipped = surnameFirst(term);
  const rows = await ask(term, key);
  if (rows.length > 0 || flipped === null) return rows;

  // Nothing under the natural ordering. Try the way FEC actually files it
  // before reporting an absence.
  return ask(flipped, key);
}
