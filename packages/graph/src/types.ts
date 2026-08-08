/**
 * The entity graph.
 *
 * Built under a constraint worth stating plainly: the roadmap's own defer
 * criterion for this phase — real cases where several sources overlap on the
 * same entities — is not met. The hard part of entity resolution is deciding
 * which *near* matches are the same thing, and that judgement can only be
 * tuned against real data. Fixtures cannot teach it.
 *
 * So the design draws a hard line down the middle:
 *
 *   Automatic  — only exact identity after normalization. Two sources
 *                reporting `WWW.Example.com` and `www.example.com` are the
 *                same host, and no tuning is needed to know that.
 *   Suggested  — everything else. Near-matching names surface as candidates
 *                an operator confirms, and nothing merges without that.
 *
 * A graph that silently merged two similarly-named people would be worse than
 * no graph, because it would look like a finding.
 */
import type { SubjectKind } from "@scout/sources";

export const ENTITY_KINDS = [
  "domain",
  "ip",
  "email",
  "username",
  "person",
  "company",
  "cert",
  "breach",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityRef {
  kind: EntityKind;
  /** Normalized. `entityKey` is the identity used for automatic merging. */
  value: string;
  /** Human-facing form, when the normalized value is not the readable one. */
  label?: string;
}

/**
 * How two entities relate. Each is evidenced by a finding, so the graph never
 * asserts a relationship it cannot point at a source for.
 */
export const RELATIONS = [
  /** A hostname resolves to an address. */
  "resolves-to",
  /** A certificate covers a hostname. */
  "covers",
  /** A hostname is a subdomain of a registrable domain. */
  "subdomain-of",
  /** An email address belongs to a domain. */
  "email-at",
  /** An identifier appears in a breach corpus. */
  "exposed-in",
  /** Two identifiers were reported together by one source. */
  "co-occurs",
] as const;

export type Relation = (typeof RELATIONS)[number];

/** One entity's appearance in one finding — the unit of provenance. */
export interface Mention {
  entity: EntityRef;
  findingId: string;
  sourceId: string;
  observedAt: string;
}

export interface Link {
  from: EntityRef;
  to: EntityRef;
  relation: Relation;
  /** The finding that evidences this link. Never absent. */
  findingId: string;
  sourceId: string;
}

export interface ExtractionResult {
  mentions: Mention[];
  links: Link[];
}

/** A finding as the extractor needs to see it. */
export interface FindingInput {
  id: string;
  sourceId: string;
  queryTerm: string;
  queryKind: SubjectKind;
  observedAt: string;
  title: string;
  summary?: string | null;
  data?: unknown;
}

export interface ResolvedEntity {
  key: string;
  kind: EntityKind;
  value: string;
  label: string | null;
  /** Every source that reported this entity. Union, never a winner. */
  sourceIds: string[];
  /** Every finding that mentions it. */
  findingIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface ResolvedLink {
  from: string;
  to: string;
  relation: Relation;
  /** Findings evidencing this link — more than one when sources agree. */
  findingIds: string[];
  sourceIds: string[];
}

export interface EntityGraph {
  entities: ResolvedEntity[];
  links: ResolvedLink[];
  /**
   * Entities reported by more than one source. The reason the graph exists —
   * and the count the exit gate cares about.
   */
  corroborated: number;
}

/** A merge the operator must confirm. Never applied automatically. */
export interface MergeSuggestion {
  /** Stable across rebuilds, so a dismissal can stick. */
  id: string;
  kind: EntityKind;
  left: string;
  right: string;
  /** Why the pair looks like a match. Shown to the operator verbatim. */
  reason: string;
  /** 0–1. Advisory only — nothing merges on a score. */
  confidence: number;
}

/** The identity used for automatic merging. Exact, after normalization. */
export function entityKey(ref: { kind: EntityKind; value: string }): string {
  return `${ref.kind}:${ref.value.trim().toLowerCase()}`;
}
