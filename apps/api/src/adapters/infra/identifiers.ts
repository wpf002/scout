import type { InfraObservation, Subject } from "@scout/sources";
import { isImoNumber, isMmsi, requireSource } from "@scout/sources";
import { fetchPlace } from "./place.js";

export const addressSource = requireSource("osm-address");
export const vesselSource = requireSource("vessel-id");
export const phoneSource = requireSource("phone-id");
export const plateSource = requireSource("plate-id");

const TIMEOUT_MS = 20_000;
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

// ── Address ─────────────────────────────────────────────────────────────────

/**
 * A street address is a place you have to look up first.
 *
 * Geocode, then hand the coordinate to the place adapter — the same code that
 * answers a coordinate typed directly. Reimplementing the radius query here
 * would give two answers to one question depending on how it was asked.
 */
export async function fetchAddress(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "address") return [];

  const url =
    "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
    encodeURIComponent(subject.value);
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`);

  const body = (await response.json()) as Array<{ lat?: string; lon?: string }>;
  const first = Array.isArray(body) ? body[0] : undefined;
  if (first?.lat === undefined || first.lon === undefined) return [];

  return fetchPlace({ kind: "location", value: `${first.lat}, ${first.lon}` });
}

// ── Vessel ──────────────────────────────────────────────────────────────────

/**
 * Maritime Identification Digits — the MMSI's first three, which name the flag
 * state. Abridged to the fleets that actually turn up; an unlisted MID reports
 * the number rather than guessing a country.
 */
const MID: Record<string, string> = {
  "201": "Albania", "205": "Belgium", "209": "Cyprus", "210": "Cyprus", "211": "Germany",
  "212": "Cyprus", "218": "Germany", "219": "Denmark", "220": "Denmark", "224": "Spain",
  "225": "Spain", "226": "France", "227": "France", "228": "France", "230": "Finland",
  "232": "United Kingdom", "233": "United Kingdom", "234": "United Kingdom", "235": "United Kingdom",
  "236": "Gibraltar", "237": "Greece", "238": "Croatia", "239": "Greece", "240": "Greece",
  "241": "Greece", "242": "Morocco", "244": "Netherlands", "245": "Netherlands", "246": "Netherlands",
  "247": "Italy", "248": "Malta", "249": "Malta", "250": "Ireland", "251": "Iceland",
  "252": "Liechtenstein", "253": "Luxembourg", "254": "Monaco", "255": "Madeira", "256": "Malta",
  "257": "Norway", "258": "Norway", "259": "Norway", "261": "Poland", "263": "Portugal",
  "265": "Sweden", "266": "Sweden", "269": "Switzerland", "271": "Türkiye", "272": "Ukraine",
  "273": "Russia", "275": "Latvia", "276": "Estonia", "277": "Lithuania", "278": "Slovenia",
  "279": "Serbia", "303": "Alaska (US)", "308": "Bahamas", "309": "Bahamas", "310": "Bermuda",
  "311": "Bahamas", "316": "Canada", "319": "Cayman Islands", "338": "United States",
  "351": "Panama", "352": "Panama", "353": "Panama", "354": "Panama", "355": "Panama",
  "356": "Panama", "357": "Panama", "366": "United States", "367": "United States",
  "368": "United States", "369": "United States", "370": "Panama", "371": "Panama",
  "372": "Panama", "373": "Panama", "374": "Panama", "375": "St Vincent & Grenadines",
  "376": "St Vincent & Grenadines", "377": "St Vincent & Grenadines", "412": "China",
  "413": "China", "416": "Taiwan", "419": "India", "422": "Iran", "431": "Japan",
  "432": "Japan", "440": "South Korea", "441": "South Korea", "445": "North Korea",
  "477": "Hong Kong", "503": "Australia", "512": "New Zealand", "525": "Indonesia",
  "533": "Malaysia", "563": "Singapore", "564": "Singapore", "565": "Singapore",
  "566": "Singapore", "574": "Vietnam", "605": "Algeria", "636": "Liberia", "637": "Liberia",
  "657": "Nigeria", "710": "Brazil", "725": "Chile", "760": "Peru",
};

/**
 * What a ship's number says on its own.
 *
 * This is arithmetic and a lookup table, not a query: an MMSI encodes its flag
 * state in the first three digits, and an IMO number carries a check digit. No
 * free registry will turn either into an owner — GISIS and the classification
 * societies all sit behind accounts — so the honest output is the identity the
 * number itself carries, plus the position feeds that can be asked about it.
 *
 * The real value is downstream: with `vessel` as a subject kind, OpenSanctions
 * screens it against designated fleets, which is the question that actually
 * matters about a hull.
 */
export function describeVessel(value: string): InfraObservation[] {
  const digits = value.replace(/\D/g, "");
  const out: InfraObservation[] = [];

  if (/^imo/i.test(value) && isImoNumber(digits)) {
    out.push({
      kind: "registration",
      domain: `IMO${digits}`,
      registrar: "IMO number — check digit valid",
      created: null,
      updated: null,
      expires: null,
      nameservers: [],
      statuses: [],
    });
    return out;
  }

  if (isMmsi(digits)) {
    const flag = MID[digits.slice(0, 3)] ?? null;
    out.push({
      kind: "registration",
      domain: digits,
      registrar:
        flag === null
          ? `MMSI — MID ${digits.slice(0, 3)}, flag state not in table`
          : `MMSI — flag state ${flag}`,
      created: null,
      updated: null,
      expires: null,
      nameservers: [],
      statuses: flag === null ? [] : [flag],
    });
  }

  return out;
}

export async function fetchVessel(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "vessel") return [];
  return describeVessel(subject.value);
}

// ── Phone ───────────────────────────────────────────────────────────────────

/** Country calling codes, longest-prefix matched. Abridged to the common set. */
const DIALLING: Array<[string, string]> = [
  ["1", "United States / Canada"], ["20", "Egypt"], ["27", "South Africa"],
  ["30", "Greece"], ["31", "Netherlands"], ["32", "Belgium"], ["33", "France"],
  ["34", "Spain"], ["36", "Hungary"], ["39", "Italy"], ["40", "Romania"],
  ["41", "Switzerland"], ["43", "Austria"], ["44", "United Kingdom"], ["45", "Denmark"],
  ["46", "Sweden"], ["47", "Norway"], ["48", "Poland"], ["49", "Germany"],
  ["52", "Mexico"], ["54", "Argentina"], ["55", "Brazil"], ["56", "Chile"],
  ["57", "Colombia"], ["58", "Venezuela"], ["60", "Malaysia"], ["61", "Australia"],
  ["62", "Indonesia"], ["63", "Philippines"], ["64", "New Zealand"], ["65", "Singapore"],
  ["66", "Thailand"], ["81", "Japan"], ["82", "South Korea"], ["84", "Vietnam"],
  ["86", "China"], ["90", "Türkiye"], ["91", "India"], ["92", "Pakistan"],
  ["93", "Afghanistan"], ["94", "Sri Lanka"], ["95", "Myanmar"], ["98", "Iran"],
  ["212", "Morocco"], ["213", "Algeria"], ["216", "Tunisia"], ["218", "Libya"],
  ["234", "Nigeria"], ["254", "Kenya"], ["255", "Tanzania"], ["256", "Uganda"],
  ["351", "Portugal"], ["352", "Luxembourg"], ["353", "Ireland"], ["354", "Iceland"],
  ["358", "Finland"], ["359", "Bulgaria"], ["370", "Lithuania"], ["371", "Latvia"],
  ["372", "Estonia"], ["380", "Ukraine"], ["381", "Serbia"], ["385", "Croatia"],
  ["386", "Slovenia"], ["420", "Czechia"], ["421", "Slovakia"], ["852", "Hong Kong"],
  ["855", "Cambodia"], ["856", "Laos"], ["880", "Bangladesh"], ["886", "Taiwan"],
  ["960", "Maldives"], ["961", "Lebanon"], ["962", "Jordan"], ["963", "Syria"],
  ["964", "Iraq"], ["965", "Kuwait"], ["966", "Saudi Arabia"], ["967", "Yemen"],
  ["968", "Oman"], ["970", "Palestine"], ["971", "United Arab Emirates"],
  ["972", "Israel"], ["973", "Bahrain"], ["974", "Qatar"], ["975", "Bhutan"],
  ["976", "Mongolia"], ["977", "Nepal"], ["992", "Tajikistan"], ["993", "Turkmenistan"],
  ["994", "Azerbaijan"], ["995", "Georgia"], ["996", "Kyrgyzstan"], ["998", "Uzbekistan"],
];

/**
 * What a phone number says on its own.
 *
 * Deliberately only the country. Carrier and line-type lookups exist, but every
 * one that resolves a number to a subscriber is paid, and the free tiers that
 * claim to are reselling scraped data of unknown provenance. Naming the country
 * from the dialling code is arithmetic on the number itself and is the honest
 * limit of what Scout can say without an account.
 *
 * The number is still worth having as a subject: Intelligence X indexes it as a
 * selector, so a leak or paste carrying it is reachable from here.
 */
export function describePhone(value: string): InfraObservation[] {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7) return [];

  // Longest prefix wins: 1 must not beat 1-for-US against 972 for Israel.
  const match = [...DIALLING]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([code]) => digits.startsWith(code));

  return [{
    kind: "registration",
    domain: `+${digits}`,
    registrar:
      match === undefined
        ? "Country not recognised from the dialling code"
        : `Dialling code +${match[0]} — ${match[1]}`,
    created: null,
    updated: null,
    expires: null,
    nameservers: [],
    statuses: match === undefined ? [] : [match[1]],
  }];
}

export async function fetchPhone(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "phone") return [];
  return describePhone(subject.value);
}

// ── Plate ───────────────────────────────────────────────────────────────────

/**
 * A registration plate, and what cannot be done with one.
 *
 * There is no free reverse-plate lookup, and this is a legal boundary rather
 * than a missing integration. In the United States the Driver's Privacy
 * Protection Act restricts DMV records to enumerated purposes; the services
 * advertising instant plate-to-owner results are either selling access they do
 * not lawfully have or returning nothing. The same holds across the EU.
 *
 * So this source exists to say that, once, in the place an investigator would
 * otherwise go looking — rather than have `plate` silently return an empty
 * result that reads like "no record found".
 */
export function describePlate(value: string): InfraObservation[] {
  const plate = value.trim().toUpperCase();
  if (plate === "") return [];

  return [{
    kind: "registration",
    domain: plate,
    registrar:
      "No public registry. Plate-to-owner is restricted (DPPA in the US, " +
      "equivalent rules in the EU) and no lawful free API exposes it.",
    created: null,
    updated: null,
    expires: null,
    nameservers: [],
    statuses: ["no-public-source"],
  }];
}

export async function fetchPlate(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "plate") return [];
  return describePlate(subject.value);
}
