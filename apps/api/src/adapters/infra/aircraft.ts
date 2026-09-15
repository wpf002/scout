import { prisma } from "@scout/db";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const aircraftSource = requireSource("faa-registry");

/**
 * The FAA registry, answering who an aircraft belongs to.
 *
 * This is the closest public analogue to the thing Scout cannot have. There is
 * no free plate-to-owner lookup because DMV records are restricted — but the
 * civil aircraft registry is published in full, owner name and mailing address
 * included, and it is queryable here because `pnpm faa:sync` holds it locally.
 *
 * The join that makes it matter is `modeSHex`: the ICAO 24-bit address in this
 * table is the same address the live ADS-B layer already draws on the map. An
 * aircraft overhead resolves to a registered owner with no retyping, which is
 * the one place Scout's map and its case file genuinely meet.
 *
 * Two honest limits. The registry says who the aircraft is *registered* to,
 * which for airline and business fleets is routinely a leasing trust — a
 * Wilmington Trust row is a finding about the ownership structure, not an
 * evasion of it. And it is US civil aircraft only: a foreign or military
 * address returns nothing, which is not the same as nothing being there.
 */

/** N123AB, with or without the N, as the registry stores it. */
function tailKey(value: string): string {
  return value.trim().toUpperCase().replace(/^N/, "");
}

function isIcaoHex(value: string): boolean {
  return /^[0-9A-F]{6}$/.test(value.trim().toUpperCase());
}

interface Row {
  nNumber: string;
  modeSHex: string | null;
  ownerName: string;
  ownerType: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  aircraft: string | null;
  yearMfr: number | null;
  statusCode: string | null;
  certIssued: Date | null;
  syncedAt: Date;
}

export function toObservations(rows: Row[]): InfraObservation[] {
  return rows.flatMap((row): InfraObservation[] => {
    const where = [row.city, row.state, row.zip, row.country === "US" ? null : row.country]
      .filter((x): x is string => x !== null && x !== "")
      .join(", ");

    return [{
      kind: "registration",
      domain: `N${row.nNumber}`,
      // The owner is the finding. Type matters as much as name: "Individual"
      // and "Corporation" are different answers to the same question.
      registrar: [
        row.ownerName,
        row.ownerType === null ? null : `(${row.ownerType})`,
      ]
        .filter((x): x is string => x !== null)
        .join(" "),
      created: row.certIssued === null ? null : row.certIssued.toISOString(),
      // Not an expiry. The sync date, so a stale registry reads as stale
      // rather than as current fact.
      updated: row.syncedAt.toISOString(),
      expires: null,
      nameservers: [],
      statuses: [
        ...(row.aircraft === null ? [] : [row.aircraft]),
        ...(row.yearMfr === null ? [] : [String(row.yearMfr)]),
        ...(where === "" ? [] : [where]),
        ...(row.street === null ? [] : [row.street]),
        ...(row.modeSHex === null ? [] : [`ICAO ${row.modeSHex}`]),
      ],
    }];
  });
}

export async function fetchAircraft(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "aircraft") return [];
  const value = subject.value.trim().toUpperCase();
  if (value === "") return [];

  // A six-hex-digit value is the ADS-B address; anything else is a tail
  // number. Both are unique, so either way this is at most one row.
  const rows = (await prisma.aircraftRegistration.findMany({
    where: isIcaoHex(value) ? { modeSHex: value } : { nNumber: tailKey(value) },
    take: 5,
  })) as Row[];

  if (rows.length === 0) {
    const loaded = await prisma.aircraftRegistration.count();
    if (loaded === 0) {
      throw new Error("The FAA registry is not loaded. Run: pnpm faa:sync");
    }
  }

  return toObservations(rows);
}
