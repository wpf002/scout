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
  value = value.replace(/^[<"'(\[]+/, "").replace(/[>"')\]]+$/, "");

  return value.trim();
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
