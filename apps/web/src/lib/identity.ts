import type { RunResultRow } from "./api";

/**
 * Candidate people, assembled across sources.
 *
 * Five sources answer a person search and none of them agree on a format:
 * the voter file says MICHAEL BYRON JORDAN, the FEC says JORDAN, MICHAEL A,
 * Wikidata says Michael Jordan. They are shown as five separate lists, so the
 * work of noticing that one of them is in Concord and another is in Burlington
 * falls to the reader.
 *
 * This groups them. Two rules keep it honest:
 *
 * A grouping is a HYPOTHESIS, never an assertion. Two people with one name in
 * one city are still two people, and the panel says what the grouping was based
 * on so a reader can reject it. Nothing here merges records in the database.
 *
 * And a source's answer is only used when its name actually matches the search.
 * OpenSanctions returns "Frank Jordan" for a Michael Jordan query — a fuzzy
 * upstream match, which is correct behaviour there — and folding that into a
 * Michael would manufacture an identity out of a near-miss. Those are dropped
 * and counted, so the count is visible rather than silent.
 */

export interface Identity {
  /** Longest name variant seen, as the label. */
  name: string;
  /** Every spelling any source returned, deduplicated. */
  variants: string[];
  birthYear: number | null;
  /** "CONCORD, NC" where known. Part of the grouping key. */
  locality: string | null;
  employer: string | null;
  occupation: string | null;
  party: string | null;
  address: string | null;
  /** Source ids that contributed, so a one-source identity reads as one. */
  sources: string[];
  /** What the grouping was based on, shown so the reader can reject it. */
  basis: string;
}

export interface IdentityReport {
  identities: Identity[];
  /** Rows whose name did not match the subject, e.g. a fuzzy sanctions hit. */
  discarded: number;
}

interface Parsed {
  first: string;
  last: string;
  full: string;
}

/** "JORDAN, MICHAEL A" and "Michael Byron Jordan" reduce to the same pair. */
export function parsePersonName(raw: string): Parsed | null {
  const cleaned = raw
    .replace(/\b(JR|SR|II|III|IV|MR|MRS|MS|DR|MD|PHD)\.?\b/gi, " ")
    .replace(/[^\p{L}\s,'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return null;

  let words: string[];
  if (cleaned.includes(",")) {
    const [surname, rest] = cleaned.split(",");
    words = [...(rest ?? "").trim().split(" "), ...(surname ?? "").trim().split(" ")];
  } else {
    words = cleaned.split(" ");
  }
  words = words.filter((w) => w !== "");
  if (words.length < 2) return null;

  return {
    first: (words[0] as string).toUpperCase(),
    last: (words[words.length - 1] as string).toUpperCase(),
    full: words.join(" "),
  };
}

/** A US state code plus the town before it, from a formatted address line. */
function localityOf(text: string): string | null {
  const match = /([A-Za-z .'-]{2,30}),\s*([A-Z]{2})(?:,|\s|$)/.exec(text);
  if (match === null) return null;
  return `${(match[1] ?? "").trim().toUpperCase()}, ${match[2]}`;
}

function yearOf(text: string): number | null {
  const match = /\bb\.\s*(\d{4})\b/.exec(text) ?? /\b(19\d{2}|20[0-2]\d)-\d{2}-\d{2}/.exec(text);
  const year = match === null ? NaN : Number(match[1]);
  return year >= 1890 && year <= 2030 ? year : null;
}

interface Claim {
  sourceId: string;
  name: string;
  parsed: Parsed;
  birthYear: number | null;
  locality: string | null;
  employer: string | null;
  occupation: string | null;
  party: string | null;
  address: string | null;
}

/**
 * Per-source extraction, not generic parsing.
 *
 * Each adapter's shape was checked against live output; guessing a schema and
 * then reading fields out of the wrong place is how a tool starts inventing
 * facts that look sourced.
 */
function claimsFrom(row: RunResultRow): Claim[] {
  return row.data.flatMap((raw): Claim[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const o = raw as Record<string, unknown>;

    const name =
      typeof o["title"] === "string"
        ? o["title"]
        : typeof o["caption"] === "string"
          ? o["caption"]
          : null;
    if (name === null) return [];

    const parsed = parsePersonName(name);
    if (parsed === null) return [];

    const dataset = typeof o["datasetId"] === "string" ? o["datasetId"] : row.sourceId;
    const excerpt = typeof o["excerpt"] === "string" ? o["excerpt"] : "";
    const entityType = typeof o["entityType"] === "string" ? o["entityType"] : null;

    const isVoter = dataset.startsWith("voter-file");
    const isFec = dataset === "fec";

    // The voter file's excerpt leads with the address; the FEC's leads with
    // occupation then employer. Both are our own formatting, verified above.
    const parts = excerpt.split(" · ").map((p) => p.trim());

    return [{
      sourceId: row.sourceId,
      name,
      parsed,
      birthYear: yearOf(`${entityType ?? ""} ${excerpt}`),
      locality: localityOf(excerpt),
      employer: isFec ? entityType : null,
      occupation: isFec ? (parts[0] ?? null) : null,
      party: isVoter ? (parts[2] ?? null) : null,
      address: isVoter ? (parts[1] ?? null) : null,
    }];
  });
}

export function buildIdentities(results: RunResultRow[], subject: string): IdentityReport {
  const wanted = parsePersonName(subject);
  const claims = results.flatMap(claimsFrom);

  // Only rows whose name matches what was searched. A fuzzy upstream hit on a
  // different person is not evidence about this one.
  const matching =
    wanted === null
      ? claims
      : claims.filter((c) => c.parsed.first === wanted.first && c.parsed.last === wanted.last);

  // Group on name and locality only. Birth year is an attribute, not part of
  // the key: the FEC never reports one, and keying on it split a person into
  // "the voter record" and "the donation" — the exact join this exists to make.
  const byPlace = new Map<string, Claim[]>();
  for (const claim of matching) {
    const key = `${claim.parsed.first}|${claim.parsed.last}|${claim.locality ?? ""}`;
    byPlace.set(key, [...(byPlace.get(key) ?? []), claim]);
  }

  // Within one place, two DIFFERENT known birth years are two people. A claim
  // with no year attaches to whichever is there rather than becoming a third.
  const groups = new Map<string, Claim[]>();
  for (const [key, place] of byPlace) {
    const years = [...new Set(place.map((c) => c.birthYear).filter((y): y is number => y !== null))];
    if (years.length <= 1) {
      groups.set(key, place);
      continue;
    }
    for (const year of years) {
      groups.set(
        `${key}|${year}`,
        place.filter((c) => c.birthYear === year || c.birthYear === null),
      );
    }
  }

  const identities: Identity[] = [...groups.values()].map((group) => {
    const variants = [...new Set(group.map((c) => c.name))];
    const pick = <K extends keyof Claim>(field: K): Claim[K] | null =>
      group.find((c) => c[field] !== null && c[field] !== "")?.[field] ?? null;

    const locality = pick("locality") as string | null;
    const birthYear = pick("birthYear") as number | null;

    return {
      name: variants.reduce((a, b) => (b.length > a.length ? b : a), variants[0] ?? ""),
      variants,
      birthYear,
      locality,
      employer: pick("employer") as string | null,
      occupation: pick("occupation") as string | null,
      party: pick("party") as string | null,
      address: pick("address") as string | null,
      sources: [...new Set(group.map((c) => c.sourceId))].sort(),
      basis: [
        "name",
        locality === null ? null : "locality",
        birthYear === null ? null : "birth year",
      ]
        .filter((x): x is string => x !== null)
        .join(" + "),
    };
  });

  // Most corroborated first; a person three sources agree on outranks one that
  // only the voter file has ever heard of.
  identities.sort((a, b) => {
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return (b.birthYear ?? 0) - (a.birthYear ?? 0);
  });

  return { identities, discarded: claims.length - matching.length };
}
