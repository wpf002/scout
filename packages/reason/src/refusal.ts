/**
 * A refusal says what was asked, why it can't be answered, and what would
 * change that. "Not permitted" on its own sends an investigator to guess;
 * "requires collection on a subject outside authorization #X" sends them
 * to the person who issues authorizations.
 */

export type RefusalReason =
  | "action-not-permitted"
  | "out-of-scope-subject"
  | "unknown-entity"
  | "budget-exceeded"
  | "cannot-plan"
  | "invalid-plan"
  | "no-evidence"
  | "model-unavailable";

export interface Refusal {
  reason: RefusalReason;
  message: string;
  /** What would need to be true for the question to be answerable. */
  requires: string | null;
  authorizationReference: string;
}

export class ReasonRefusal extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "ReasonRefusal";
    this.refusal = refusal;
  }
}

/** A function declaration, not a const: TypeScript only narrows control flow after a `never` call when the callee is declared this way. */
export function refuse(refusal: Refusal): never {
  throw new ReasonRefusal(refusal);
}
