import { z } from "zod";
import type { Subject } from "@scout/sources";
import { checkScope } from "./gate.js";
import {
  ScopeError,
  scopeEntrySchema,
  type ScopeDecision,
  type ScopeEntry,
} from "./types.js";

/**
 * The v2 scope context.
 *
 * v1 authorizes with two facts: a case has an `authorizationRef`, and a case
 * has scope entries. That is enough to gate a person-facing lookup and it is
 * not enough for collection, resolution, graph reads or biometrics, which need
 * to know who issued the authorization, what it permits, and when it stops.
 *
 * This type carries all of that. Every v2 function that reads or writes data
 * takes a `ScopeContext` as a required parameter, and there is no public
 * constructor: the only way to obtain one is `ScopeContext.build()` from a
 * parsed authorization record, which refuses a revoked, expired or not-yet-
 * started authorization. A function that forgets the parameter does not
 * compile; a caller that has one has already passed the window check.
 *
 * v1 is untouched. `checkScope()` and `enforceScope()` keep gating the case
 * tiers exactly as before, and `SCOUT_AUTHORIZE_ALL` still applies to them and
 * only to them. Nothing in this file reads that setting.
 */

export const SOURCE_CLASSES = [
  "OWNED",
  "LICENSED",
  "PUBLIC_RECORD",
  "OPEN_WEB",
  "BROKER",
  "SENSOR",
  "SATELLITE",
  "FIRST_PARTY",
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
export const sourceClassSchema = z.enum(SOURCE_CLASSES);

/**
 * What an authorization can permit. Deliberately coarse: an investigator is
 * authorized to collect, to resolve, to read the graph, to compare against a
 * gallery, to have the agent propose, or to approve a consequential action.
 * Finer distinctions live in the subject boundary, not here.
 */
export const ACTION_CLASSES = [
  "COLLECT",
  "RESOLVE",
  "READ_GRAPH",
  "BIOMETRIC_COMPARE",
  "PROPOSE",
  "APPROVE_CONSEQUENTIAL",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
export const actionClassSchema = z.enum(ACTION_CLASSES);

/**
 * Who and what the authorization covers.
 *
 * `scope` reuses v1's entries verbatim so the same matcher answers "is this
 * subject inside the boundary" for both generations. `entityKinds` limits which
 * kinds of entity may be resolved or read under it; empty means any kind.
 */
export const boundarySchema = z.object({
  scope: z.array(scopeEntrySchema),
  entityKinds: z.array(z.string().min(1)).default([]),
});

export const authorizationSchema = z
  .object({
    id: z.string().min(1),
    /** The engagement reference. The same string a v1 Case carries. */
    reference: z.string().min(1),
    /** Issuing authority: a court, a client, a statute, a contract. */
    issuedBy: z.string().min(1),
    boundary: boundarySchema,
    sourceClasses: z.array(sourceClassSchema),
    actionClasses: z.array(actionClassSchema),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
    revokedAt: z.coerce.date().nullable().default(null),
  })
  .refine((a) => a.validUntil > a.validFrom, {
    message: "validUntil must be after validFrom",
    path: ["validUntil"],
  });

export type AuthorizationRecord = z.infer<typeof authorizationSchema>;

function assertWindow(auth: AuthorizationRecord, now: Date): void {
  if (auth.revokedAt !== null) {
    throw new ScopeError(
      "authorization-revoked",
      `Authorization ${auth.reference} was revoked at ${auth.revokedAt.toISOString()}.`,
    );
  }
  if (now < auth.validFrom) {
    throw new ScopeError(
      "authorization-not-started",
      `Authorization ${auth.reference} is not valid until ${auth.validFrom.toISOString()}.`,
    );
  }
  if (now >= auth.validUntil) {
    throw new ScopeError(
      "authorization-expired",
      `Authorization ${auth.reference} expired at ${auth.validUntil.toISOString()}.`,
    );
  }
}

export interface BuildScopeContextInput {
  /** The authorization row, or anything shaped like one. Parsed, not trusted. */
  authorization: unknown;
  /** Who is acting. Written to every access log row. */
  operator: string;
  /** Injectable clock, for tests. */
  now?: Date;
}

export class ScopeContext {
  private constructor(
    readonly authorization: AuthorizationRecord,
    readonly operator: string,
    /** When the window was last checked. */
    readonly checkedAt: Date,
  ) {}

  /**
   * The only constructor. Parses the record, checks the window, and refuses
   * with a stable `DenyReason` if the authorization cannot act right now.
   */
  static build(input: BuildScopeContextInput): ScopeContext {
    const auth = authorizationSchema.parse(input.authorization);
    const now = input.now ?? new Date();
    assertWindow(auth, now);
    return new ScopeContext(auth, input.operator, now);
  }

  get authorizationId(): string {
    return this.authorization.id;
  }

  get reference(): string {
    return this.authorization.reference;
  }

  get issuingAuthority(): string {
    return this.authorization.issuedBy;
  }

  get scope(): readonly ScopeEntry[] {
    return this.authorization.boundary.scope;
  }

  /**
   * Re-checks the window. A context built at the start of a long resolution
   * run can outlive its authorization; call this before each write.
   */
  assertLive(now: Date = new Date()): void {
    assertWindow(this.authorization, now);
  }

  permitsAction(action: ActionClass): boolean {
    return this.authorization.actionClasses.includes(action);
  }

  assertAction(action: ActionClass): void {
    if (!this.permitsAction(action)) {
      throw new ScopeError(
        "action-not-permitted",
        `Authorization ${this.reference} does not permit ${action}. ` +
          `It permits: ${this.authorization.actionClasses.join(", ") || "nothing"}.`,
      );
    }
  }

  permitsSourceClass(sourceClass: SourceClass): boolean {
    return this.authorization.sourceClasses.includes(sourceClass);
  }

  assertSourceClass(sourceClass: SourceClass): void {
    if (!this.permitsSourceClass(sourceClass)) {
      throw new ScopeError(
        "source-class-not-permitted",
        `Authorization ${this.reference} does not permit collection from ${sourceClass} sources.`,
      );
    }
  }

  permitsEntityKind(kind: string): boolean {
    const kinds = this.authorization.boundary.entityKinds;
    return kinds.length === 0 || kinds.includes(kind);
  }

  /** Whether a subject falls inside the boundary. The v1 matcher decides. */
  covers(subject: Subject): ScopeDecision {
    return checkScope(subject, this.scope);
  }

  assertCovers(subject: Subject): ScopeEntry {
    const decision = this.covers(subject);
    if (!decision.allowed) {
      throw new ScopeError(decision.reason, decision.message);
    }
    return decision.matched;
  }

  /** What the access log records about this context. Never the boundary. */
  toAuditFields(): { authorizationId: string; actor: string } {
    return { authorizationId: this.authorization.id, actor: this.operator };
  }
}
