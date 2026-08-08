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

export interface SanctionMatch {
  kind: "sanction-match";
  entityId: string;
  caption: string;
  schema: string;
  datasets: string[];
  score: number | null;
  countries: string[];
  topics: string[];
  /** Actually designated, as opposed to merely present in a reference list. */
  sanctioned: boolean;
  entities: ExtractedEntity[];
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

export interface InfraSweepResult {
  subject: Subject;
  caseId: string;
  sources: {
    sourceId: string;
    name: string;
    status: "ok" | "inert" | "error" | "blocked";
    reason: string | null;
    message: string | null;
    observationCount: number;
    queryLogId: string | null;
  }[];
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
