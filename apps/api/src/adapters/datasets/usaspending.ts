import type { DatasetObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const usaSpendingSource = requireSource("usaspending");

/**
 * USASpending — federal money, by recipient.
 *
 * Every federal contract, grant, loan and direct payment above the reporting
 * threshold, keyless and without a rate limit worth working around. For a
 * company it answers who pays them and how much. For a person it is thinner —
 * individuals appear mainly as sole proprietors and grant recipients — so the
 * gate applies there and not to companies.
 *
 * It is also how you answer the question one level up: which vendors a given
 * agency buys from. An agency's data-broker contracts are in here under the
 * broker's name, which is why this is the source that documents the purchasing
 * tier rather than merely describing it.
 */

const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
const TIMEOUT_MS = 30_000;

/**
 * Award types, one group per request.
 *
 * The API refuses a mixed list — "award_type_codes must only contain types
 * from one group" — so asking for everything at once is a 422 rather than a
 * complete answer. Contracts and grants are the two groups that matter here:
 * a defence prime shows up in the first, a university or nonprofit in the
 * second, and querying only one silently halves the picture depending on who
 * the recipient happens to be.
 */
const AWARD_GROUPS: Record<string, string[]> = {
  contracts: ["A", "B", "C", "D"],
  grants: ["02", "03", "04", "05"],
};

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function normalizeSpending(raw: unknown, term: string): DatasetObservation[] {
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  return results.flatMap((item): DatasetObservation[] => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;

    const recipient = typeof row["Recipient Name"] === "string" ? row["Recipient Name"] : null;
    if (recipient === null) return [];

    const amount = typeof row["Award Amount"] === "number" ? row["Award Amount"] : null;
    const agency = typeof row["Awarding Agency"] === "string" ? row["Awarding Agency"] : null;
    const awardId = typeof row["Award ID"] === "string" ? row["Award ID"] : null;
    const start = typeof row["Start Date"] === "string" ? row["Start Date"] : null;
    const description = typeof row["Description"] === "string" ? row["Description"] : null;
    const generated = typeof row["generated_internal_id"] === "string" ? row["generated_internal_id"] : null;

    return [{
      kind: "dataset-hit",
      datasetId: "usaspending",
      title: recipient,
      entityType: agency,
      matchedTerm: term,
      url: generated === null ? null : `https://www.usaspending.gov/award/${generated}`,
      date: start,
      // Amount first — the size of the award is the fact that ranks these.
      excerpt: [
        amount === null ? null : money.format(amount),
        agency,
        description,
        awardId,
      ]
        .filter((x): x is string => x !== null && x !== "")
        .join(" · "),
      entities: [],
    }];
  });
}

async function askGroup(term: string, codes: string[]): Promise<DatasetObservation[]> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      filters: { recipient_search_text: [term], award_type_codes: codes },
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Awarding Agency",
        "Start Date",
        "Description",
      ],
      limit: 30,
      sort: "Award Amount",
      order: "desc",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`USASpending responded ${response.status}`);
  return normalizeSpending(await response.json(), term);
}

export async function fetchUsaSpending(subject: Subject): Promise<DatasetObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];

  // Both groups, and one failing must not hide the other — a recipient with
  // contracts and no grants is the normal case, not an error.
  const settled = await Promise.allSettled(
    Object.values(AWARD_GROUPS).map((codes) => askGroup(term, codes)),
  );

  const rows = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (rows.length === 0) {
    const failure = settled.find((r) => r.status === "rejected");
    if (failure !== undefined && failure.status === "rejected") {
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
    }
  }
  return rows;
}
