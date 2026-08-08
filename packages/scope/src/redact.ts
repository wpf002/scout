import { extractEntities } from "@scout/sources";
import type { Subject } from "@scout/sources";
import { checkScope } from "./gate.js";
import type { ScopeEntry } from "./types.js";

export interface Redaction {
  kind: Subject["kind"];
  /** What was removed. Kept for the operator's own record, never exported. */
  value: string;
  reason: string;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
}

export const REDACTED_MARKER = "[REDACTED: out of scope]";

/**
 * Strips identifiers that fall outside the case's authorization scope out of
 * free text before it leaves the tool.
 *
 * Notes and finding summaries are typed by hand, and hand-typed text picks up
 * things the engagement was never authorized to collect — a bystander's email
 * pasted in while chasing a lead, a third-party domain copied from a header.
 * The scope gate governs what Scout *fetches*; this governs what Scout
 * *emits*, which is the other half of the same promise.
 *
 * It only removes what it can positively identify as an out-of-scope
 * identifier. It is not a general PII scrubber and does not pretend to be:
 * unstructured prose can hide anything, so this reduces leakage rather than
 * guaranteeing its absence. The report says how many identifiers it removed,
 * so a reviewer knows redaction happened rather than assuming it did.
 */
export function redactOutOfScope(
  text: string | null | undefined,
  scope: readonly ScopeEntry[],
): RedactionResult {
  if (typeof text !== "string" || text.length === 0) {
    return { text: text ?? "", redactions: [] };
  }

  const candidates = extractEntities(text, "redaction");
  const redactions: Redaction[] = [];
  let out = text;

  for (const candidate of candidates) {
    const decision = checkScope(
      { kind: candidate.kind, value: candidate.value },
      scope,
    );
    if (decision.allowed) continue;

    redactions.push({
      kind: candidate.kind,
      value: candidate.value,
      reason: decision.reason,
    });

    // Case-insensitive replacement of every occurrence: the extractor
    // lowercases, but the text may not.
    const pattern = new RegExp(
      candidate.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    out = out.replace(pattern, REDACTED_MARKER);
  }

  return { text: out, redactions };
}

/** Redacts several fields at once, pooling the redaction record. */
export function redactAll(
  fields: readonly (string | null | undefined)[],
  scope: readonly ScopeEntry[],
): { texts: string[]; redactions: Redaction[] } {
  const texts: string[] = [];
  const redactions: Redaction[] = [];

  for (const field of fields) {
    const result = redactOutOfScope(field, scope);
    texts.push(result.text);
    redactions.push(...result.redactions);
  }

  return { texts, redactions };
}
