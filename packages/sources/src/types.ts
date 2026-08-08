import { z } from "zod";

/**
 * Tiers in *reach-for order* — the sequence an investigator should work
 * through. The web dashboard renders them in exactly this order (Phase 2),
 * so the array order is load-bearing, not cosmetic.
 */
export const TIERS = [
  "datasets",
  "infra",
  "exposure",
  "people",
  "onion",
  "utils",
] as const;

export type Tier = (typeof TIERS)[number];

export const tierSchema = z.enum(TIERS);

/**
 * `deeplink` — Scout builds a URL and hands it to the investigator's browser.
 *   The subject term NEVER travels through a Scout-owned network call for
 *   these sources (locked invariant 4).
 * `api` — Scout itself makes the upstream call, which means keys, rate limits,
 *   audit rows, and — for `requiresScope` sources — the scope gate.
 */
export const SOURCE_MODES = ["deeplink", "api"] as const;
export type SourceMode = (typeof SOURCE_MODES)[number];
export const sourceModeSchema = z.enum(SOURCE_MODES);

/** The kinds of thing an investigation can be run against. */
export const SUBJECT_KINDS = [
  "domain",
  "ip",
  "email",
  "username",
  "person",
  "company",
  "hash",
  "keyword",
] as const;

export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const subjectKindSchema = z.enum(SUBJECT_KINDS);

export interface Subject {
  kind: SubjectKind;
  value: string;
}

export const subjectSchema = z.object({
  kind: subjectKindSchema,
  value: z.string().trim().min(1).max(512),
});

export interface Source {
  /** Stable slug. Used as the foreign key in Finding/QueryLog rows. */
  id: string;
  name: string;
  tier: Tier;
  mode: SourceMode;
  /**
   * True for person-facing sources. A `requiresScope` source may never execute
   * for a subject outside the case's authorization scope — enforced at the
   * adapter, not just the route (locked invariant 1).
   */
  requiresScope: boolean;
  /**
   * Subject kinds that require scope even though the source itself is not
   * person-facing.
   *
   * Some sources are only person-facing for some of their inputs. Intelligence
   * X searching a domain is dataset research; Intelligence X searching an
   * email address is a lookup about a person. Gating the whole source would
   * block legitimate infrastructure work, and gating none of it would leave a
   * person-facing lookup ungated — so the gate is decided per subject kind.
   *
   * Use `requiresScopeFor(source, kind)` rather than reading this directly.
   */
  scopedKinds?: readonly SubjectKind[];
  /** Subject kinds this source can meaningfully be run against. */
  accepts: readonly SubjectKind[];
  description: string;
  homepage: string;
  /**
   * Env var holding the API key. `null` means keyless (deeplinks, crt.sh).
   * An `api` source whose key env is unset reports `inert` — Scout never
   * guesses or fabricates a result (locked invariant 6).
   */
  keyEnv: string | null;
  /**
   * Builds the URL for the investigator to open. Calling this does not make a
   * network request — it only formats a string.
   *
   * Required when `mode` is `deeplink`. An `api` source may also offer one as
   * a convenience link (crt.sh does), but the guarantee in locked invariant 4
   * — that the subject term never reaches a Scout-owned request — belongs to
   * `mode === "deeplink"` alone. A source with an execution adapter makes
   * Scout-side calls by definition, and the plan shows that as a separate,
   * explicit action.
   */
  deeplink?: (term: string) => string;
}

/** A source stripped of its function-valued fields, safe to send as JSON. */
export type SerializableSource = Omit<Source, "deeplink"> & {
  hasDeeplink: boolean;
};
