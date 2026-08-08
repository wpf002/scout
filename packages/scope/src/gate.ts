import type { Source, Subject } from "@scout/sources";
import {
  emailDomain,
  isWithinDomain,
  normalizeEmail,
  normalizeHostname,
  normalizeIdentifier,
} from "./normalize.js";
import type { ScopeDecision, ScopeEntry } from "./types.js";
import { ScopeError } from "./types.js";

/** Normalizes a scope entry's value the same way subjects are normalized. */
function normalizeEntry(entry: ScopeEntry): string | null {
  if (entry.kind === "domain") return normalizeHostname(entry.value);
  // An identifier may be an email, a username, or an IP. Emails get the email
  // normalizer so `User@EXAMPLE.com` and `user@example.com` are one entry.
  if (entry.value.includes("@")) return normalizeEmail(entry.value);
  return normalizeIdentifier(entry.value);
}

/**
 * Decides whether `subject` falls inside `scope`.
 *
 * This function is pure and knows nothing about cases, the database, or the
 * environment — callers supply the entry list. That is what let Phase 1 swap
 * env-derived scope for case-derived scope without touching the matcher.
 *
 * An empty `scope` is always a denial. Empty means the scoped tiers are OFF;
 * it never means "unrestricted" (locked invariant 1).
 */
export function checkScope(
  subject: Subject,
  scope: readonly ScopeEntry[],
): ScopeDecision {
  if (scope.length === 0) {
    return {
      allowed: false,
      reason: "scope-empty",
      message:
        "No authorization scope is configured, so scoped sources are off. " +
        "Add a scope entry to the case to enable them.",
    };
  }

  const domainEntries = scope.filter((e) => e.kind === "domain");
  const identifierEntries = scope.filter((e) => e.kind === "identifier");

  // What this subject can be matched against, by kind.
  let host: string | null = null;
  let exact: string | null = null;

  switch (subject.kind) {
    case "domain":
    case "ip":
      host = normalizeHostname(subject.value);
      exact = host;
      break;
    case "email":
      exact = normalizeEmail(subject.value);
      host = emailDomain(subject.value);
      break;
    case "username":
    case "person":
    case "company":
    case "keyword":
    case "hash":
      // These never fall under a domain entry — only an explicit identifier.
      exact = normalizeIdentifier(subject.value);
      break;
  }

  if (exact === null && host === null) {
    return {
      allowed: false,
      reason: "unparseable-subject",
      message: `Could not read "${subject.value}" as a ${subject.kind}, so it cannot be matched against scope.`,
    };
  }

  if (exact !== null) {
    for (const entry of identifierEntries) {
      if (normalizeEntry(entry) === exact) {
        return { allowed: true, matched: entry };
      }
    }
  }

  if (host !== null) {
    for (const entry of domainEntries) {
      const scopeDomain = normalizeEntry(entry);
      if (scopeDomain !== null && isWithinDomain(host, scopeDomain)) {
        return { allowed: true, matched: entry };
      }
    }
  }

  return {
    allowed: false,
    reason: "out-of-scope",
    message: `"${subject.value}" is not covered by any of the ${scope.length} scope ${
      scope.length === 1 ? "entry" : "entries"
    } on this case.`,
  };
}

export interface EnforceScopeInput {
  subject: Subject;
  scope: readonly ScopeEntry[];
  source: Source;
  /** The case authorizing this execution. Required — audit needs a home. */
  caseId?: string | null | undefined;
  /** The engagement/permission reference recorded on that case. */
  authorizationRef?: string | null | undefined;
}

/**
 * The adapter-level gate. Every `requiresScope` adapter calls this immediately
 * before its network call, and does nothing if it throws.
 *
 * Route-level checks are not sufficient on their own: routes get refactored,
 * new callers appear, and batch paths get added. Putting the gate in the
 * adapter means the network call itself is unreachable for an out-of-scope
 * subject (locked invariant 1).
 *
 * @returns the scope entry that authorized the call, for the audit row.
 * @throws {ScopeError} 403 with a stable `reason`.
 */
export function enforceScope(input: EnforceScopeInput): ScopeEntry {
  const { subject, scope, source, caseId, authorizationRef } = input;

  if (typeof caseId !== "string" || caseId.trim().length === 0) {
    throw new ScopeError(
      "case-required",
      `${source.name} is a scoped source and can only run inside a case. ` +
        "Open or create a case with an authorization reference first.",
      source.id,
    );
  }

  if (
    typeof authorizationRef !== "string" ||
    authorizationRef.trim().length === 0
  ) {
    throw new ScopeError(
      "authorization-missing",
      `Case ${caseId} has no authorization reference, so ${source.name} cannot run under it.`,
      source.id,
    );
  }

  const decision = checkScope(subject, scope);
  if (!decision.allowed) {
    throw new ScopeError(decision.reason, decision.message, source.id);
  }

  return decision.matched;
}
