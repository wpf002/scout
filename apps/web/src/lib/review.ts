import type { PairFeatures, ReviewObservation } from "./v2";

/**
 * The arithmetic behind the review queue, kept out of the component so a
 * reviewer's view of a pair is tested on its own: which fields agree, and
 * what the model actually weighed.
 */

export type Agreement = "same" | "differs" | "one-sided";

export interface FieldRow {
  field: string;
  left: string | null;
  right: string | null;
  agreement: Agreement;
}

const norm = (field: string, value: unknown): string => {
  const text = String(value).trim().toLowerCase();
  if (/phone|mmsi|imo|icao|tail|hex/.test(field)) return text.replace(/[^0-9a-z]/g, "");
  return text.replace(/\s+/g, " ");
};

const show = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
};

/**
 * Every field either side carries, side by side. Identifiers come first
 * (they're what the model compares), then the rest of the payload. A field
 * present on one side only is "one-sided", which is what most review pairs
 * come down to: not disagreement, absence.
 */
export function compareFields(left: ReviewObservation | null, right: ReviewObservation | null): FieldRow[] {
  const l = new Map<string, unknown>();
  const r = new Map<string, unknown>();
  const order: string[] = [];
  const take = (into: Map<string, unknown>, o: ReviewObservation | null) => {
    if (o === null) return;
    for (const id of o.identifiers) {
      const key = id.kind.toLowerCase();
      if (!into.has(key)) into.set(key, id.value);
      if (!order.includes(key)) order.push(key);
    }
    for (const [key, value] of Object.entries(o.payload)) {
      const k = key.toLowerCase();
      if (into.has(k)) continue;
      into.set(k, value);
      if (!order.includes(k)) order.push(k);
    }
  };
  take(l, left);
  take(r, right);
  return order.map((field) => {
    const a = show(l.get(field));
    const b = show(r.get(field));
    const agreement: Agreement =
      a === null || b === null ? "one-sided" : norm(field, a) === norm(field, b) ? "same" : "differs";
    return { field, left: a, right: b, agreement };
  });
}

export interface EvidenceRow {
  column: string;
  /** What the comparison found. */
  finding: string;
  /** Which way it pushed, and how hard. */
  weight: string;
  direction: "for" | "against" | "none";
  magnitude: number;
}

/**
 * The model's comparison, column by column, in the order that moved the
 * score most. A Bayes factor above one argued for a match, below one
 * against, exactly one said nothing; a level of -1 means one side had no
 * value to compare. The numbers are shown as they are, beside the words.
 */
export function explainFeatures(features: PairFeatures): EvidenceRow[] {
  const levels = features.levels ?? {};
  const factors = features.bayes_factors ?? {};
  const columns = [...new Set([...Object.keys(levels), ...Object.keys(factors)])];
  return columns
    .map((column) => {
      const level = levels[column] ?? -1;
      const bf = factors[column] ?? 1;
      const magnitude = Math.abs(Math.log10(bf > 0 ? bf : 1));
      const direction: EvidenceRow["direction"] = bf > 1.0001 ? "for" : bf < 0.9999 ? "against" : "none";
      const finding =
        level < 0 ? "not comparable: missing on one side" : level === 0 ? "no match" : `match level ${level}`;
      const weight =
        direction === "none"
          ? "no evidence"
          : direction === "for"
            ? `×${bf >= 100 ? Math.round(bf).toLocaleString("en-US") : bf.toFixed(1)} for`
            : `÷${(1 / bf) >= 100 ? Math.round(1 / bf).toLocaleString("en-US") : (1 / bf).toFixed(1)} against`;
      return { column: column.replace(/_/g, " "), finding, weight, direction, magnitude };
    })
    .sort((a, b) => b.magnitude - a.magnitude || a.column.localeCompare(b.column));
}

/** "88% · weight 2.92": the model's own numbers, read once at the top. */
export function describeScore(scoreBp: number | null, features: PairFeatures): string {
  const parts: string[] = [];
  if (scoreBp !== null) parts.push(`${Math.round(scoreBp / 100)}% (${scoreBp.toLocaleString("en-US").replace(/,/g, " ")} bp)`);
  if (typeof features.match_weight === "number") parts.push(`weight ${features.match_weight.toFixed(2)}`);
  return parts.join(" · ");
}

/** A short handle for one side of a pair: its name if it has one, else its first identifier, else its source. */
export function handleOf(o: ReviewObservation | null): string {
  if (o === null) return "unknown";
  const name = o.identifiers.find((i) => i.kind === "NAME")?.value ?? (typeof o.payload["name"] === "string" ? (o.payload["name"] as string) : null);
  if (name !== null) return name;
  const first = o.identifiers[0];
  return first === undefined ? o.sourceId : `${first.kind.toLowerCase()} ${first.value}`;
}
