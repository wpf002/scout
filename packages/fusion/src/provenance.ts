import { createHash } from "node:crypto";
import { observationInputSchema, type ObservationInput } from "./types.js";

/** Thrown when an observation is missing any of its four provenance fields. */
export class ProvenanceError extends Error {
  readonly statusCode = 422;
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Refused to write an observation without provenance. Missing: ${missing.join(", ")}.`,
    );
    this.name = "ProvenanceError";
    this.missing = missing;
  }
}

export const PROVENANCE_FIELDS = [
  "sourceId",
  "authorizationId",
  "collectedAt",
  "observedAt",
] as const;

/**
 * Validates an observation before it goes anywhere near the database.
 *
 * Provenance missing is a write failure, not a warning. The database enforces
 * the same four columns as NOT NULL, so this is not the only line, but it is
 * the one that says which field in plain words rather than a constraint name.
 */
export function assertProvenance(input: unknown): ObservationInput {
  const record =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};

  const missing = PROVENANCE_FIELDS.filter((field) => {
    const value = record[field];
    return value === undefined || value === null || value === "";
  });
  if (missing.length > 0) throw new ProvenanceError(missing);

  return observationInputSchema.parse(input);
}

/** Sorts keys recursively so the same content hashes the same way. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The dedupe key. Computed from the normalized payload, not the raw one, so
 * the same fact delivered with different whitespace or key order is one row.
 */
export function contentHash(normalizedPayload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(normalizedPayload)), "utf8")
    .digest("hex");
}
