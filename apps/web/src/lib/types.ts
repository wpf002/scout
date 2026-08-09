export const TIER_ORDER = [
  "datasets",
  "infra",
  "exposure",
  "people",
  "onion",
  "utils",
] as const;

export type Tier = (typeof TIER_ORDER)[number];

export const TIER_BLURB: Record<Tier, string> = {
  datasets: "Leaks, corporate registries, sanctions. Start here.",
  infra: "Hosts, certs, DNS. Infrastructure, not people — no scope gate.",
  exposure: "Breach exposure. Person-facing — scope-gated.",
  people: "Identity enumeration. Person-facing — scope-gated.",
  onion: "Hidden-service search. Fallback, not a first move.",
  utils: "Supporting lookups.",
};

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

export interface Subject {
  kind: SubjectKind;
  value: string;
}

export interface SourceSummary {
  id: string;
  name: string;
  tier: Tier;
  mode: "deeplink" | "api";
  requiresScope: boolean;
  accepts: SubjectKind[];
  description: string;
  homepage: string;
  keyEnv: string | null;
  hasDeeplink: boolean;
  keyed: boolean;
  hasAdapter: boolean;
}

export interface ScopeEntry {
  id: string;
  caseId: string;
  kind: "DOMAIN" | "IDENTIFIER";
  value: string;
  note: string | null;
  addedBy: string;
  createdAt: string;
}

export interface CaseRecord {
  id: string;
  name: string;
  status: "ACTIVE" | "CLOSED";
  authorizationRef: string;
  notes: string | null;
  createdAt: string;
  createdBy: string;
  scopeEntries: ScopeEntry[];
  _count?: { subjects: number; findings: number; queryLogs: number };
}

export interface SubjectRecord {
  id: string;
  caseId: string;
  kind: Uppercase<SubjectKind>;
  value: string;
  label: string | null;
  createdAt: string;
}

export interface FindingRecord {
  id: string;
  caseId: string;
  sourceId: string;
  tier: Uppercase<Tier>;
  title: string;
  summary: string | null;
  data: unknown;
  queryTerm: string;
  queryKind: Uppercase<SubjectKind>;
  observedAt: string;
  queryLogId: string | null;
  savedBy: string;
  createdAt: string;
}

export type PlanStatus =
  | "deeplink"
  | "ready"
  | "inert"
  | "blocked"
  | "no-adapter";

export interface PlanEntry {
  sourceId: string;
  name: string;
  tier: Tier;
  mode: "deeplink" | "api";
  requiresScope: boolean;
  status: PlanStatus;
  url?: string;
  reason?: string;
  message?: string;
  matchedScope?: { id?: string; kind: string; value: string };
  execution?: { method: "POST"; path: string; requiresConfirmation: true };
}

export interface QueryPlan {
  executed: false;
  note: string;
  subject: Subject;
  caseId: string | null;
  scopeSource: "case" | "env-fallback";
  scopeEntryCount: number;
  counts: {
    total: number;
    deeplink: number;
    ready: number;
    inert: number;
    blocked: number;
    noAdapter: number;
  };
  plan: PlanEntry[];
}

export interface Provenance {
  sourceId: string;
  sourceName: string;
  tier: Tier;
  queryTerm: string;
  queryKind: SubjectKind;
  observedAt: string;
  queryLogId?: string;
}

export interface SourceResult {
  status: "ok" | "inert" | "blocked" | "error";
  provenance: Provenance;
  data?: unknown;
  reason?: string;
  message?: string;
}

/* ── datasets tier ───────────────────────────────────────────────────── */

export interface ExtractedEntity {
  kind: SubjectKind;
  value: string;
  confidence: "high" | "medium";
  fromSourceId: string;
}

export interface DatasetHit {
  kind: "dataset-hit";
  datasetId: string;
  title: string;
  entityType: string | null;
  matchedTerm: string;
  url: string | null;
  date: string | null;
  excerpt: string | null;
  entities: ExtractedEntity[];
}

/**
 * What a listing actually claims. These are different accusations —
 * `linked-to-sanctioned` means associated with a designated party, not
 * designated — and the UI must not flatten them.
 */
export type Designation =
  | "sanctioned"
  | "linked-to-sanctioned"
  | "debarred"
  | "pep"
  | "listed";

export interface SanctionMatch {
  kind: "sanction-match";
  entityId: string;
  caption: string;
  schema: string;
  datasets: string[];
  score: number | null;
  countries: string[];
  topics: string[];
  designation: Designation;
  /** True ONLY when the entity itself is designated. */
  sanctioned: boolean;
  entities: ExtractedEntity[];
}

export interface SweepExclusion {
  sourceId: string;
  name: string;
  reason: "scope-gated" | "kind-not-accepted";
  message: string;
}

export type DatasetObservation = DatasetHit | SanctionMatch;

export interface DatasetRunResult {
  status: "ok" | "inert" | "blocked" | "error";
  provenance: Provenance;
  reason?: string;
  message?: string;
  /** Whether the gate applied to this subject kind for this source. */
  scopeGated: boolean;
  observations: DatasetObservation[];
  totals: {
    observations: number;
    sanctioned: number;
    suggestedSubjects: number;
  };
  suggestedSubjects: ExtractedEntity[];
}

export interface DatasetAdapterInfo {
  sourceId: string;
  name: string;
  accepts: SubjectKind[];
  keyEnv: string | null;
  requiresScope: boolean;
  scopedKinds: SubjectKind[];
}

/* ── infrastructure tier ─────────────────────────────────────────────── */

export interface HostObservation {
  kind: "host";
  ip: string;
  hostnames: string[];
  ports: number[];
  org: string | null;
  asn: string | null;
  country: string | null;
  lastSeen: string | null;
}

export interface SubdomainObservation {
  kind: "subdomain";
  hostname: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface CertObservation {
  kind: "cert";
  serial: string | null;
  commonName: string;
  names: string[];
  issuer: string | null;
  notBefore: string | null;
  notAfter: string | null;
}

export type InfraObservation =
  | HostObservation
  | SubdomainObservation
  | CertObservation;

export interface AttributedObservation {
  observation: InfraObservation;
  /** Every source that reported this. Never a single winner. */
  sourceIds: string[];
}

export interface SweepSourceReport {
  sourceId: string;
  name: string;
  status: "ok" | "inert" | "error" | "blocked";
  reason: string | null;
  message: string | null;
  observationCount: number;
  queryLogId: string | null;
}

export interface InfraSweepResult {
  subject: Subject;
  caseId: string;
  sources: SweepSourceReport[];
  /** Sources deliberately not run, and why. Never silently omitted. */
  excluded: SweepExclusion[];
  totals: {
    rawObservations: number;
    merged: number;
    subdomain: number;
    host: number;
    cert: number;
  };
  observations: AttributedObservation[];
}

export interface QueryLogRow {
  id: string;
  sourceId: string;
  tier: Uppercase<Tier>;
  requiresScope: boolean;
  phase: "PLAN" | "EXECUTE";
  outcome: "ALLOWED" | "DENIED" | "INERT" | "ERROR";
  reason: string | null;
  subjectKind: Uppercase<SubjectKind>;
  subjectValue: string;
  authorizationRef: string;
  operator: string;
  matchedScopeValue: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AuditEventRow {
  id: string;
  action: string;
  detail: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

export interface AuditView {
  caseId: string;
  authorizationRef: string;
  totals: { returned: number; denied: number };
  queryLogs: QueryLogRow[];
  events: AuditEventRow[];
}

/* ── entity graph ────────────────────────────────────────────────────── */

export type EntityKind =
  | "domain"
  | "ip"
  | "email"
  | "username"
  | "person"
  | "company"
  | "cert"
  | "breach";

export interface ResolvedEntity {
  key: string;
  kind: EntityKind;
  value: string;
  label: string | null;
  /** Every source that reported this. More than one means corroborated. */
  sourceIds: string[];
  findingIds: string[];
  firstSeen: string;
  lastSeen: string;
}

export interface ResolvedLink {
  from: string;
  to: string;
  relation: string;
  /** Findings evidencing this edge. Never empty. */
  findingIds: string[];
  sourceIds: string[];
}

export interface MergeSuggestion {
  id: string;
  kind: EntityKind;
  left: string;
  right: string;
  reason: string;
  confidence: number;
}

export interface CaseSummary {
  draft: true;
  producedBy: string;
  generatedAt: string;
  headline: string;
  paragraphs: string[];
  citedFindingIds: string[];
}

export interface CaseGraph {
  caseId: string;
  entities: ResolvedEntity[];
  links: ResolvedLink[];
  totals: {
    entities: number;
    links: number;
    corroborated: number;
    sources: number;
    findings: number;
  };
  suggestions: MergeSuggestion[];
  summary: CaseSummary;
}

/* ── monitoring ──────────────────────────────────────────────────────── */

export interface MonitorRecord {
  id: string;
  caseId: string;
  name: string;
  subjectKind: string;
  subjectValue: string;
  sourceIds: string[];
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  createdBy: string;
  _count?: { runs: number; changes: number };
}

export interface MonitorRunResult {
  runId: string;
  observationCount: number;
  added: number;
  removed: number;
  /** First run: the snapshot is stored and nothing is reported as new. */
  baseline: boolean;
  errors: { sourceId: string; message: string }[];
}

export interface Alert {
  id: string;
  caseId: string;
  caseName: string | null;
  monitorId: string;
  monitor: { name: string; subjectValue: string; subjectKind: string };
  changeType: "ADDED" | "REMOVED";
  observationKind: string;
  observationKey: string;
  sourceIds: string[];
  acknowledgedAt: string | null;
  createdAt: string;
}

/**
 * A subject handed from one board to another — clicking an entity in the graph
 * and continuing the investigation from it.
 *
 * The `nonce` exists because pivoting to the *same* subject twice is a real
 * action, and a plain value comparison would swallow the second one.
 */
export interface PivotRequest {
  kind: SubjectKind;
  value: string;
  nonce: number;
}

export interface TimelineEntry {
  at: string;
  kind: "query" | "finding" | "event";
  outcome: string | null;
  sourceId: string | null;
  label: string;
  detail: string;
  operator: string;
}
