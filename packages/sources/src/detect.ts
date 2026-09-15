import type { SubjectKind } from "./types.js";

/**
 * Working out what an investigator pasted.
 *
 * One box takes any indicator, so something has to decide whether `acme.com`
 * is a domain and `j.doe@acme.com` is an email. That decision picks which
 * sources run, and for person-facing sources it picks whether the scope gate
 * applies at all — so a wrong guess is not merely inconvenient.
 *
 * Two rules follow from that. Detection never silently resolves ambiguity: an
 * uncertain result carries its alternatives so the surface can offer them and
 * the investigator can correct it before anything runs. And anything genuinely
 * unrecognisable becomes `keyword`, the least privileged kind, rather than
 * being guessed into `person` — guessing toward a person is guessing toward
 * the gated path with the most consequences.
 */

export type DetectionConfidence = "certain" | "likely" | "guess";

export interface Detection {
  kind: SubjectKind;
  confidence: DetectionConfidence;
  /** Other readings, best first. Empty when the input is unambiguous. */
  alternatives: SubjectKind[];
  /** Input with surrounding noise removed — what should actually be run. */
  normalized: string;
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Deliberately loose. Full IPv6 grammar is not worth the false negatives. */
const IPV6 = /^(?=.*:)[0-9a-f:]+(%[0-9a-z]+)?$/i;

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/** Hex lengths that correspond to a hash rather than a coincidence. */
const HASH_LENGTHS = new Set([32, 40, 64, 96, 128]);
const HEX = /^[0-9a-f]+$/i;

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,38}$/i;

/**
 * A decimal coordinate pair, in the forms people paste: "32.9, -96.7",
 * "32.9 -96.7". Both parts must carry a decimal point — bare "32 96" is far
 * more likely to be something else, and reading it as a place would send a
 * query to the middle of a desert.
 */
const COORDINATE =
  /^(-?\d{1,2}(?:\.\d+)?|-?[0-8]\d(?:\.\d+)?|-?90(?:\.0+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/;

/** Degrees/minutes/seconds with hemisphere letters: 32°55'26"N 96°45'11"W. */
const DMS =
  /^\d{1,3}[°:\s]\s*\d{1,2}[\u2032'":\s]\s*[\d.]+\s*[\u2033"]?\s*[NS][,\s]+\d{1,3}[°:\s]\s*\d{1,2}[\u2032'":\s]\s*[\d.]+\s*[\u2033"]?\s*[EW]$/i;

/**
 * A coordinate pair, or null when the string is not one.
 *
 * Exported because the surfaces need the numbers, not just the verdict: the
 * map flies to them and the place adapter queries around them.
 */
export function asCoordinate(raw: string): { lat: number; lon: number } | null {
  const m = COORDINATE.exec(raw.trim());
  if (m === null) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  // A decimal point on at least one side. "32 96" stays a keyword.
  if (!raw.includes(".")) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * Suffixes that make a multi-word string a company rather than a person.
 * Not exhaustive, and not meant to be — it only has to beat "assume person".
 */
const COMPANY_MARKERS = [
  "inc",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "gmbh",
  "bv",
  "nv",
  "sa",
  "ag",
  "plc",
  "co",
  "company",
  "holdings",
  "group",
  "partners",
  "trust",
  "foundation",
];

/** Strips wrapping and defanging so pasted indicators work as pasted. */
export function normalizeIndicator(raw: string): string {
  let value = raw.trim();

  // Defanged indicators are how they travel in reports and tickets.
  value = value.replace(/\[\.\]/g, ".").replace(/\(\.\)/g, ".");
  value = value.replace(/^hxxps?:/i, (m) => m.replace(/xx/i, "tt"));

  // A pasted URL is a domain question.
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(value);
  if (url?.[1] !== undefined) value = url[1];

  // Strip credentials, port and a trailing dot.
  value = value.replace(/^[^@/\s]*@(?=[^@]*$)/, (m) =>
    EMAIL.test(value) ? m : "",
  );
  value = value.replace(/:\d{1,5}$/, "");
  value = value.replace(/\.$/, "");

  // Angle brackets and quotes come along with copied text.
  value = value.replace(/^[<"'([]+/, "").replace(/[>"')\]]+$/, "");

  return value.trim();
}


/**
 * An IMO ship number: seven digits whose last is a checksum.
 *
 * The check digit is what makes this safe to detect from a bare number. Each
 * of the first six digits is weighted 7..2, and the sum's last digit must equal
 * the seventh. A random seven-digit string passes one time in ten, and the
 * "IMO" prefix removes even that.
 */
export function isImoNumber(digits: string): boolean {
  if (!/^\d{7}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i += 1) {
    sum += Number(digits[i]) * (7 - i);
  }
  return sum % 10 === Number(digits[6]);
}

/**
 * An MMSI: nine digits opening with a Maritime Identification Digit.
 *
 * MIDs run 201–775 and identify the flag state. Requiring one keeps this from
 * swallowing every nine-digit number — an account number or a short phone
 * number is not a ship.
 */
export function isMmsi(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const mid = Number(digits.slice(0, 3));
  return mid >= 201 && mid <= 775;
}

/** Digits only, so "+1 (555) 010-9999" and "15550109999" compare equal. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Street suffixes that make a string an address rather than a company or a
 * person. Short on purpose: it only has to beat "assume keyword".
 */
const STREET_WORDS = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "drive", "dr", "lane", "ln",
  "boulevard", "blvd", "way", "court", "ct", "place", "pl", "terrace", "parkway",
  "pkwy", "highway", "hwy", "circle", "cir", "square", "sq", "suite", "ste",
  "floor", "apt", "unit",
]);

function looksLikeAddress(value: string): boolean {
  const words = value.toLowerCase().replace(/[.,]/g, "").split(/\s+/).filter((w) => w !== "");
  if (words.length < 3) return false;
  // A leading house number plus a street word is the unambiguous shape.
  const hasNumber = /^\d+[a-z]?$/.test(words[0] ?? "");
  const hasStreetWord = words.some((w) => STREET_WORDS.has(w));
  return hasNumber && hasStreetWord;
}

/** Best reading of an indicator, with the runners-up kept. */
export function detectSubjectKind(raw: string): Detection {
  const normalized = normalizeIndicator(raw);
  const value = normalized.toLowerCase();

  if (value.length === 0) {
    return {
      kind: "keyword",
      confidence: "guess",
      alternatives: [],
      normalized,
    };
  }

  // Before IP: "10.5, 20.3" is a coordinate pair, not an address.
  if (asCoordinate(normalized) !== null || DMS.test(normalized)) {
    return {
      kind: "location",
      confidence: "certain",
      alternatives: [],
      normalized,
    };
  }

  if (IPV4.test(value) || (value.includes(":") && IPV6.test(value))) {
    return { kind: "ip", confidence: "certain", alternatives: [], normalized };
  }

  if (EMAIL.test(value)) {
    return {
      kind: "email",
      confidence: "certain",
      alternatives: [],
      normalized,
    };
  }

  if (HEX.test(value) && HASH_LENGTHS.has(value.length)) {
    return {
      kind: "hash",
      confidence: "certain",
      alternatives: [],
      normalized,
    };
  }

  if (DOMAIN.test(value)) {
    // A single-label host with a dot is a domain; anything else with a dot and
    // no recognised suffix could still be a handle like `first.last`.
    const looksLikeHandle = /^[a-z0-9]+\.[a-z0-9]+$/i.test(value) &&
      !/\.(com|net|org|io|co|dev|app|ai|gov|edu|mil|info|biz|[a-z]{2})$/i.test(
        value,
      );
    return looksLikeHandle
      ? {
          kind: "username",
          confidence: "guess",
          alternatives: ["domain"],
          normalized,
        }
      : {
          kind: "domain",
          confidence: "certain",
          alternatives: [],
          normalized,
        };
  }

  // ── Maritime, phone, plate, address ──────────────────────────────────────
  // All of these are digit-shaped, so order is load-bearing: the checksum and
  // the MID range are what keep a phone number from reading as a ship.

  // An ICAO 24-bit address: six hex digits. US aircraft are A00000–ADF7C7,
  // which is specific enough to call certain; other allocations overlap with
  // ordinary hex strings, so they stay a guess with hash offered.
  const icao = /^(?:icao[\s:-]*)?([0-9a-f]{6})$/i.exec(normalized);
  if (icao !== null) {
    const hex = (icao[1] as string).toUpperCase();
    const n = Number.parseInt(hex, 16);
    const isUs = n >= 0xa00000 && n <= 0xadf7c7;
    return {
      kind: "aircraft",
      confidence: isUs ? "certain" : "guess",
      alternatives: isUs ? [] : ["hash", "keyword"],
      normalized: hex,
    };
  }

  // A US tail number: N, then 1–5 alphanumerics. I and O are never used.
  const tail = /^n([0-9][0-9a-hj-np-z]{0,4})$/i.exec(normalized);
  if (tail !== null) {
    return {
      kind: "aircraft",
      confidence: "likely",
      alternatives: ["keyword"],
      normalized: normalized.toUpperCase(),
    };
  }

  const imoTagged = /^imo[\s:-]*(\d{7})$/i.exec(normalized);
  if (imoTagged !== null && isImoNumber(imoTagged[1] as string)) {
    return {
      kind: "vessel",
      confidence: "certain",
      alternatives: [],
      normalized: `IMO${imoTagged[1]}`,
    };
  }

  const mmsiTagged = /^mmsi[\s:-]*(\d{9})$/i.exec(normalized);
  if (mmsiTagged !== null) {
    return { kind: "vessel", confidence: "certain", alternatives: [], normalized: mmsiTagged[1] as string };
  }

  const bare = digitsOf(normalized);

  // A bare nine-digit number with a real MID. Likely, not certain — offer phone.
  if (bare === normalized && isMmsi(bare)) {
    return { kind: "vessel", confidence: "likely", alternatives: ["phone", "keyword"], normalized: bare };
  }

  // E.164, or a punctuated number of plausible length. The leading + is the
  // only unambiguous marker a phone number has.
  if (/^\+\d[\d\s()-]{6,20}$/.test(normalized)) {
    return { kind: "phone", confidence: "certain", alternatives: [], normalized: `+${bare}` };
  }
  if (/[\s()-]/.test(normalized) && bare.length >= 10 && bare.length <= 15 && /^[\d\s()+-]+$/.test(normalized)) {
    return { kind: "phone", confidence: "likely", alternatives: ["keyword"], normalized: bare };
  }

  if (looksLikeAddress(normalized)) {
    return { kind: "address", confidence: "likely", alternatives: ["company", "keyword"], normalized };
  }

  const words = value.split(/\s+/).filter((w) => w.length > 0);

  if (words.length === 1) {
    if (USERNAME.test(value)) {
      return {
        kind: "username",
        confidence: "likely",
        alternatives: ["company", "keyword"],
        normalized,
      };
    }
    return {
      kind: "keyword",
      confidence: "guess",
      alternatives: ["username", "company"],
      normalized,
    };
  }

  const last = words[words.length - 1]?.replace(/[.,]/g, "") ?? "";
  if (COMPANY_MARKERS.includes(last)) {
    return {
      kind: "company",
      confidence: "likely",
      alternatives: ["person", "keyword"],
      normalized,
    };
  }

  // Two or three capitalised words read as a name, but only just — this is the
  // one branch that reaches the gated tier, so it is never better than a guess
  // and always offers the ungated alternatives.
  if (words.length <= 3) {
    return {
      kind: "person",
      confidence: "guess",
      alternatives: ["company", "keyword"],
      normalized,
    };
  }

  return {
    kind: "keyword",
    confidence: "guess",
    alternatives: ["company", "person"],
    normalized,
  };
}
