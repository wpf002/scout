import { BASE, getOperatorToken, request } from "./api";

/**
 * The v2 routes, typed. Read paths only in the console; every one of them is
 * logged on the server, which is the point.
 */

export type EntityKind = "PERSON" | "ORG" | "VESSEL" | "AIRCRAFT" | "VEHICLE" | "ACCOUNT" | "LOCATION" | "DEVICE" | "INFRASTRUCTURE";
export const ENTITY_KINDS: EntityKind[] = ["PERSON", "ORG", "VESSEL", "AIRCRAFT", "VEHICLE", "ACCOUNT", "LOCATION", "DEVICE", "INFRASTRUCTURE"];
export const SOURCE_CLASSES = ["OWNED", "LICENSED", "PUBLIC_RECORD", "OPEN_WEB", "BROKER", "SENSOR", "SATELLITE", "FIRST_PARTY"] as const;
export const ACTION_CLASSES = ["COLLECT", "RESOLVE", "READ_GRAPH", "BIOMETRIC_COMPARE", "PROPOSE", "APPROVE_CONSEQUENTIAL"] as const;

export interface Authorization {
  id: string;
  reference: string;
  issuedBy: string;
  boundary: { scope: { kind: string; value: string }[]; entityKinds: string[] };
  sourceClasses: string[];
  actionClasses: string[];
  validFrom: string;
  validUntil: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  status: "active" | "revoked" | "expired" | "not-started";
}

export interface Collector {
  id: string;
  name: string;
  sourceClass: string;
  entityKind: EntityKind;
  subjectRequired: boolean;
  licensingTerms: string;
  tosUrl: string | null;
  configured: boolean;
  configuredBy: string | null;
}

export interface Observation {
  id: string;
  sourceId: string;
  authorizationId: string;
  collectedAt: string;
  observedAt: string;
  normalizedPayload: Record<string, unknown>;
  rawPayload?: unknown;
  contentHash: string;
  position: { lon: number; lat: number } | null;
  confidenceBp: number | null;
  indeterminate: boolean;
  identifiers: { kind: string; value: string; normalizedValue: string; normalizationVersion: string }[];
}

export interface EntityMember {
  observationId: string;
  sourceId: string;
  observedAt: string;
  collectedAt: string;
  scoreBp: number;
  method: string;
  addedBy: "SYSTEM" | "ANALYST";
  addedAt: string;
}

export interface Entity {
  id: string;
  kind: EntityKind;
  canonicalLabel: string;
  status: "RESOLVED" | "PROVISIONAL" | "UNRESOLVED" | "DISPUTED";
  lastResolvedAt: string | null;
  run: { id: string; modelVersion: string; startedAt: string } | null;
  sourceIds: string[];
  members: EntityMember[];
}

export interface SourceCoverage {
  sourceId: string;
  observations: number;
  lastObservedAt: string | null;
}

export interface GraphNode {
  id: string;
  kind: EntityKind;
  label: string;
  status: string;
  hop?: number;
}

export interface GraphEdge {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  validFrom: string;
  validUntil: string | null;
  confidenceBp: number;
  basis: string | null;
  evidenceObservationIds: string[];
}

export type Decision = "MATCH" | "NON_MATCH" | "INDETERMINATE";

export interface ReviewObservation {
  id: string;
  sourceId: string;
  observedAt: string;
  identifiers: { kind: string; value: string }[];
  payload: Record<string, unknown>;
}

export interface PairFeatures {
  match_weight?: number;
  probability?: number;
  levels?: Record<string, number>;
  bayes_factors?: Record<string, number>;
  pinned?: boolean;
}

export interface ReviewPair {
  decisionId: string;
  runId: string;
  kind: EntityKind | "UNKNOWN";
  scoreBp: number | null;
  blockingKey: string;
  features: PairFeatures;
  left: ReviewObservation | null;
  right: ReviewObservation | null;
}

export interface ReviewKind {
  kind: EntityKind | "UNKNOWN";
  runId: string;
  modelVersion: string;
  startedAt: string;
  open: number;
  adjudicatedSinceRun: number;
}

export interface AdjudicationRow {
  id: string;
  pairKey: string;
  leftObservationId: string;
  rightObservationId: string;
  decision: Decision;
  adjudicatedBy: string;
  note: string;
  createdAt: string;
}

export interface ResolveResult {
  runId: string;
  modelVersion: string;
  counts: { entities: number; match: number; review: number; disputed: number; pinned: number };
}

export interface Claim {
  text: string;
  observationIds: string[];
  basis: "observations" | "collection-log";
  sourceIds?: string[];
  entityIds?: string[];
}

export interface Refusal {
  reason: string;
  message: string;
  requires: string | null;
  authorizationReference: string;
}

export interface AskResult {
  question: string;
  plan: { steps: Array<{ id: string; op: string } & Record<string, unknown>> } | null;
  plannedBy: "rules" | "model" | null;
  shape: string | null;
  cost: number | null;
  trace: Array<{ id: string; op: string; nodes: number; edges: number; events: number; sources: number }>;
  answer: {
    status: "answered" | "insufficient-evidence" | "refused";
    text: string;
    claims: Claim[];
    citations: string[];
    refusal: Refusal | null;
    synthesizedBy: "rules" | "model" | null;
  };
}

export interface ImageryTile {
  id: string;
  sourceId: string;
  sceneId: string;
  sensedAt: string;
  cloudCoverPct: number | null;
  /** west, south, east, north */
  bbox: [number, number, number, number];
  hasPreview: boolean;
  bytes: number;
  widthPx: number;
  heightPx: number;
  resolutionM: number;
  format: string;
  cloudOptimized: boolean;
}

export type Modality = "FACE" | "VOICE";
export const LAWFUL_BASES = ["CONSENT", "COURT_ORDER", "STATUTORY_AUTHORITY", "EMPLOYMENT", "CONTRACT"] as const;
export const MEDIA_ORIGINS = ["consented-upload", "court-ordered", "employment-record"] as const;

export interface GallerySummary {
  id: string;
  name: string;
  purpose: string;
  custodianOrg: string;
  lawfulBasis: string;
  lawfulBasisDocumentRef: string;
  reviewDueAt: string;
  reviewOverdue: boolean;
  enrollments: number;
  comparisons: number;
  createdAt: string;
  createdBy: string;
}

export interface Enrollment {
  id: string;
  entityId: string;
  label: string | null;
  kind: string | null;
  modality: Modality;
  enrolledAt: string;
  enrolledBy: string;
  lawfulBasisDocumentRef: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
}

export interface ComparisonRecord {
  id: string;
  requestedAt: string;
  requestedBy: string;
  modality: Modality;
  decision: "MATCH" | "NO_MATCH" | "INDETERMINATE";
  probeHash: string;
  thresholdBp: number;
  topMatches: Array<{ enrollmentId: string; distanceBp: number; entityId: string | null; label: string | null }>;
}

export interface GalleryDetail {
  enabled: boolean;
  gallery: GallerySummary & { reviewOverdue: boolean };
  enrollments: Enrollment[];
  comparisons: ComparisonRecord[];
}

export interface SpeakerOutcome {
  comparisonId: string;
  speaker: string | null;
  seconds: number | null;
  probeHash: string;
  compared: number;
  decision: "MATCH" | "NO_MATCH" | "INDETERMINATE";
  reason: string;
  matches: CompareOutcome["matches"];
}

export interface CompareOutcome {
  comparisonId: string;
  comparisonIds: string[];
  diariser: string | null;
  speakers: SpeakerOutcome[] | null;
  galleryId: string;
  modality: Modality;
  probeHash: string;
  compared: number;
  thresholdBp: number;
  marginBp: number;
  decision: "MATCH" | "NO_MATCH" | "INDETERMINATE";
  reason: string;
  model: string;
  matches: Array<{ enrollmentId: string; entityId: string | null; label: string | null; kind: string | null; distanceBp: number; withinThreshold: boolean }>;
}

export interface TimelineEvent {
  at: string;
  kind: "observation" | "membership" | "edge-start" | "edge-end";
  observationId?: string;
  sourceId?: string;
  edgeId?: string;
  relation?: string;
  otherEntityId?: string;
  detail: string;
}

const q = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

export const v2 = {
  authorization: (caseId: string) =>
    request<{ caseId: string; authorization: Authorization | null }>(`/cases/${caseId}/authorization`),

  createAuthorization: (
    caseId: string,
    body: { issuedBy: string; sourceClasses: string[]; actionClasses: string[]; validUntil: string; entityKinds?: string[]; confirmAuthorized: true },
  ) => request<Authorization>(`/cases/${caseId}/authorization`, { method: "POST", body }),

  revokeAuthorization: (caseId: string, reason: string) =>
    request<Authorization>(`/cases/${caseId}/authorization/revoke`, { method: "POST", body: { reason } }),

  collectors: () => request<{ count: number; collectors: Collector[] }>("/v2/collectors"),

  observations: (caseId: string, limit = 2_000, raw = false) =>
    request<{ count: number; observations: Observation[] }>(`/v2/observations?${q({ caseId, limit, raw: raw ? "true" : "false" })}`),

  entities: (caseId: string, kind?: EntityKind, limit = 500) =>
    request<{ count: number; sources: SourceCoverage[]; entities: Entity[] }>(`/v2/entities?${q({ caseId, kind, limit })}`),

  galleries: () => request<{ enabled: boolean; count: number; galleries: GallerySummary[] }>("/v2/galleries"),

  gallery: (galleryId: string, caseId?: string) => request<GalleryDetail>(`/v2/galleries/${encodeURIComponent(galleryId)}?${q({ caseId })}`),

  createGallery: (body: { name: string; purpose: string; custodianOrg: string; lawfulBasis: string; lawfulBasisDocumentRef: string; reviewDueAt: string; confirmLawfulBasis: true }) =>
    request<GallerySummary>("/v2/galleries", { method: "POST", body }),

  enroll: (
    galleryId: string,
    body: { caseId: string; entityId: string; modality: Modality; mediaB64: string; contentType: string; origin: string; lawfulBasisDocumentRef: string; expiresAt: string },
  ) => request<{ enrollment: Enrollment; model: string; dims: number; mediaHash: string }>(`/v2/galleries/${encodeURIComponent(galleryId)}/enroll`, { method: "POST", body }),

  revokeEnrollment: (galleryId: string, enrollmentId: string, reason: string) =>
    request<Enrollment>(`/v2/galleries/${encodeURIComponent(galleryId)}/enrollments/${encodeURIComponent(enrollmentId)}/revoke`, { method: "POST", body: { reason } }),

  compare: (body: { caseId: string; galleryId: string; modality: Modality; mediaB64: string; contentType: string; topN?: number; diarize?: boolean }) =>
    request<CompareOutcome>("/v2/compare", { method: "POST", body }),

  imageryTiles: (caseId: string) => request<{ count: number; tiles: ImageryTile[] }>(`/v2/imagery/tiles?${q({ caseId })}`),

  /** The stored preview as an object URL the map can draw. The caller revokes it. */
  imageryPreview: async (caseId: string, tileId: string): Promise<string> => {
    const token = getOperatorToken();
    const response = await fetch(`${BASE}/v2/imagery/preview/${encodeURIComponent(tileId)}?${q({ caseId })}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Preview ${tileId} answered ${response.status}.`);
    return URL.createObjectURL(await response.blob());
  },

  ask: (caseId: string, question: string) => request<AskResult>("/v2/ask", { method: "POST", body: { caseId, question } }),

  review: (caseId: string, kind?: EntityKind, limit = 500) =>
    request<{ count: number; kinds: ReviewKind[]; pairs: ReviewPair[] }>(`/v2/review?${q({ caseId, kind, limit })}`),

  adjudicate: (caseId: string, body: { leftObservationId: string; rightObservationId: string; decision: Decision; note: string }) =>
    request<AdjudicationRow>("/v2/adjudicate", { method: "POST", body: { caseId, ...body } }),

  resolve: (caseId: string, entityKind: EntityKind) =>
    request<ResolveResult>("/v2/resolve", { method: "POST", body: { caseId, entityKind } }),

  edges: (caseId: string, asOf?: string, knownAs?: string) =>
    request<{ asOf: string; knownAs: string; count: number; nodes: GraphNode[]; edges: GraphEdge[] }>(`/v2/graph/edges?${q({ caseId, asOf, knownAs })}`),

  neighbors: (caseId: string, entityId: string, asOf?: string, knownAs?: string, hops = 1) =>
    request<{ asOf: string; knownAs: string; root: GraphNode; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>(`/v2/graph/neighbors?${q({ caseId, entityId, asOf, knownAs, hops })}`),

  timeline: (caseId: string, entityId: string, asOf?: string, knownAs?: string) =>
    request<{ asOf: string; knownAs: string; entity: GraphNode; events: TimelineEvent[] }>(`/v2/graph/timeline?${q({ caseId, entityId, asOf, knownAs })}`),
};
