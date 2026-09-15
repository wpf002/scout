import { prisma } from "@scout/db";
import type { DatasetObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const voterSource = requireSource("voter-file");

/**
 * Voter registration records the operator imported.
 *
 * The one free source that carries a date of birth against a name and address,
 * which is the field everything else lacks — it is what separates three people
 * called Barry Smith from one person seen three times.
 *
 * Person-facing by construction, so it is gated wholesale rather than per kind.
 * Unlike every other source here it reaches no upstream: the operator obtained
 * the file under their own name and permitted purpose, and this reads what they
 * loaded. Scout will not fetch these, because the requester gating is the
 * safeguard and routing around it is what makes the commercial aggregators
 * legally radioactive.
 *
 * Each row names its state and source file, because the use restrictions are
 * per-state and several are criminal — Texas commercial use is a Class A
 * misdemeanor, Washington's a felony.
 */

/** "Barry Smith" and "Smith, Barry" are the same query. */
export function nameParts(term: string): { last: string; first: string | null } | null {
  const value = term.trim();
  if (value === "") return null;

  const comma = value.split(",");
  if (comma.length >= 2) {
    const last = (comma[0] ?? "").trim();
    const first = (comma[1] ?? "").trim().split(/\s+/)[0] ?? "";
    return last === "" ? null : { last: last.toUpperCase(), first: first === "" ? null : first.toUpperCase() };
  }

  const words = value.split(/\s+/).filter((w) => w !== "");
  if (words.length === 1) return { last: (words[0] as string).toUpperCase(), first: null };
  return {
    last: (words[words.length - 1] as string).toUpperCase(),
    first: (words[0] as string).toUpperCase(),
  };
}

export async function fetchVoters(subject: Subject): Promise<DatasetObservation[]> {
  const parts = nameParts(subject.value);
  if (parts === null) return [];

  const loaded = await prisma.voterRecord.count();
  if (loaded === 0) {
    throw new Error("No voter file imported. Run: pnpm voters:import <file> --state=XX");
  }

  const rows = await prisma.voterRecord.findMany({
    where: {
      lastName: parts.last,
      ...(parts.first === null ? {} : { firstName: { startsWith: parts.first } }),
    },
    take: 100,
    orderBy: [{ state: "asc" }, { firstName: "asc" }],
  });

  return rows.map((row) => {
    const name = [row.firstName, row.middleName, row.lastName, row.suffix]
      .filter((x): x is string => x !== null && x !== "")
      .join(" ");

    // The date of birth is the reason this source exists, so it leads. A
    // year-only state says so rather than implying a precision it lacks.
    const born =
      row.birthDate !== null
        ? row.birthDate.toISOString().slice(0, 10)
        : row.birthYear !== null
          ? `b. ${row.birthYear}`
          : null;

    return {
      kind: "dataset-hit" as const,
      datasetId: `voter-file:${row.state.toLowerCase()}`,
      title: name,
      entityType: born,
      matchedTerm: subject.value,
      url: null,
      date: row.birthDate === null ? null : row.birthDate.toISOString(),
      excerpt: [
        born,
        [row.street, row.city, row.state, row.zip]
          .filter((x): x is string => x !== null && x !== "")
          .join(", ") || null,
        row.party,
        row.county === null ? null : `${row.county} County`,
        row.status,
        // Provenance, because the restriction that applies is per-file.
        row.sourceFile,
      ]
        .filter((x): x is string => x !== null && x !== "")
        .join(" · "),
      entities: [],
    };
  });
}
