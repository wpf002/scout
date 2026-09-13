import { request } from "./api";

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

  edges: (caseId: string, asOf?: string, knownAs?: string) =>
    request<{ asOf: string; knownAs: string; count: number; nodes: GraphNode[]; edges: GraphEdge[] }>(`/v2/graph/edges?${q({ caseId, asOf, knownAs })}`),

  neighbors: (caseId: string, entityId: string, asOf?: string, knownAs?: string, hops = 1) =>
    request<{ asOf: string; knownAs: string; root: GraphNode; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>(`/v2/graph/neighbors?${q({ caseId, entityId, asOf, knownAs, hops })}`),

  timeline: (caseId: string, entityId: string, asOf?: string, knownAs?: string) =>
    request<{ asOf: string; knownAs: string; entity: GraphNode; events: TimelineEvent[] }>(`/v2/graph/timeline?${q({ caseId, entityId, asOf, knownAs })}`),
};
