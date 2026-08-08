import { z } from "zod";

/**
 * A scope entry is one authorized target.
 *
 * `domain`     — the domain and everything under it.
 * `identifier` — one exact identifier: an email, a username, an IP.
 */
export const SCOPE_KINDS = ["domain", "identifier"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];
export const scopeKindSchema = z.enum(SCOPE_KINDS);

export interface ScopeEntry {
  /** Database id when the entry came from a case; absent for env-derived scope. */
  id?: string;
  kind: ScopeKind;
  value: string;
}

export const scopeEntrySchema = z.object({
  id: z.string().optional(),
  kind: scopeKindSchema,
  value: z.string().trim().min(1).max(253),
});

/**
 * Why a scoped lookup was refused. These strings are stable — they are written
 * into `QueryLog.reason` and rendered in the UI, so treat them as an API.
 */
export const DENY_REASONS = [
  /** No scope entries at all. Empty scope means OFF, never open. */
  "scope-empty",
  /** Scope exists; this subject is not in it. */
  "out-of-scope",
  /** A scoped source was invoked without a case to authorize it. */
  "case-required",
  /** The case exists but carries no authorization reference. */
  "authorization-missing",
  /** The subject value could not be parsed into something matchable. */
  "unparseable-subject",
] as const;

export type DenyReason = (typeof DENY_REASONS)[number];

export type ScopeDecision =
  | { allowed: true; matched: ScopeEntry }
  | { allowed: false; reason: DenyReason; message: string };

/** Thrown by `enforceScope`. Carries a 403 and a stable machine reason. */
export class ScopeError extends Error {
  readonly statusCode = 403;
  readonly reason: DenyReason;
  readonly sourceId: string | undefined;

  constructor(reason: DenyReason, message: string, sourceId?: string) {
    super(message);
    this.name = "ScopeError";
    this.reason = reason;
    this.sourceId = sourceId;
  }
}
