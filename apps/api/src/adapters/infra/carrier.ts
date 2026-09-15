import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const carrierSource = requireSource("fmcsa");

/**
 * FMCSA — commercial motor carriers, by USDOT number or name.
 *
 * This is as close to a plate lookup as anything lawful gets. Passenger-car
 * registration is sealed by the DPPA, but a commercial truck carries its USDOT
 * number painted on the door by federal rule, and the census behind that number
 * is public: legal name, physical address, fleet size, driver count and safety
 * rating. A number readable from a photograph resolves to an operator.
 *
 * Keyless through the Socrata endpoint. The QCMobile API that most integrations
 * reach for needs a webKey; this dataset does not, and carries the same census.
 *
 * What it is not is a vehicle lookup. It identifies the *carrier*, not the
 * truck, and a large fleet has one record covering thousands of vehicles.
 */

const ENDPOINT = "https://data.transportation.gov/resource/az4n-8mr2.json";
const TIMEOUT_MS = 25_000;

/** Safety ratings, as FMCSA codes them. */
const RATING: Record<string, string> = {
  S: "Satisfactory",
  C: "Conditional",
  U: "Unsatisfactory",
};

interface Carrier {
  legal_name?: string;
  dba_name?: string;
  dot_number?: string;
  phy_street?: string;
  phy_city?: string;
  phy_state?: string;
  phy_zip?: string;
  phone?: string;
  power_units?: string;
  truck_units?: string;
  total_drivers?: string;
  safety_rating?: string;
  business_org_desc?: string;
  docket1prefix?: string;
  docket1?: string;
  status_code?: string;
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? n : null;
}

export function normalizeCarriers(rows: Carrier[]): InfraObservation[] {
  return rows.flatMap((row): InfraObservation[] => {
    const name = row.legal_name?.trim();
    if (name === undefined || name === "") return [];

    const where = [row.phy_street, row.phy_city, row.phy_state, row.phy_zip]
      .map((x) => x?.trim())
      .filter((x): x is string => x !== undefined && x !== "")
      .join(", ");

    const trucks = num(row.power_units) ?? num(row.truck_units);
    const drivers = num(row.total_drivers);
    const docket =
      row.docket1prefix !== undefined && row.docket1 !== undefined
        ? `${row.docket1prefix}${row.docket1}`
        : null;

    return [{
      kind: "registration",
      domain: row.dot_number === undefined ? name : `USDOT ${row.dot_number}`,
      registrar: [name, row.dba_name?.trim() === undefined || row.dba_name.trim() === "" ? null : `dba ${row.dba_name.trim()}`]
        .filter((x): x is string => x !== null)
        .join(" "),
      created: null,
      updated: null,
      expires: null,
      nameservers: [],
      statuses: [
        ...(where === "" ? [] : [where]),
        ...(row.business_org_desc === undefined ? [] : [row.business_org_desc]),
        ...(trucks === null ? [] : [`${trucks} power units`]),
        ...(drivers === null ? [] : [`${drivers} drivers`]),
        // A missing rating means never rated, which is the common case and not
        // the same as a clean one.
        ...(row.safety_rating === undefined
          ? []
          : [`Safety: ${RATING[row.safety_rating] ?? row.safety_rating}`]),
        ...(docket === null ? [] : [docket]),
        ...(row.phone === undefined || row.phone.trim() === "" ? [] : [row.phone]),
        ...(row.status_code === "I" ? ["Inactive"] : []),
      ],
    }];
  });
}

/** Socrata string literals are single-quoted; a quote in the term must double. */
function soqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export async function fetchCarrier(subject: Subject): Promise<InfraObservation[]> {
  const term = subject.value.trim();
  if (term === "") return [];

  // A bare number is a USDOT number. Anything else is a name.
  const where = /^\d{1,8}$/.test(term)
    ? `dot_number='${soqlLiteral(term)}'`
    : `upper(legal_name) like '%${soqlLiteral(term.toUpperCase())}%'`;

  const url = `${ENDPOINT}?$where=${encodeURIComponent(where)}&$limit=25`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`FMCSA responded ${response.status}`);

  const body = (await response.json()) as unknown;
  return normalizeCarriers(Array.isArray(body) ? (body as Carrier[]) : []);
}
