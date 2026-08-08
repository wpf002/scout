import type {
  AuditView,
  CaseRecord,
  FindingRecord,
  QueryPlan,
  ScopeEntry,
  SourceResult,
  SourceSummary,
  Subject,
  SubjectKind,
  SubjectRecord,
} from "./types";

const BASE =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** A refusal from the API, carrying the stable reason string. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    reason?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }

  /** True when the scope gate refused. Rendered inline, never as a crash. */
  get isScopeDenial(): boolean {
    return this.code === "scope-denied";
  }
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers:
        init?.body === undefined
          ? undefined
          : { "content-type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      0,
      "unreachable",
      `Cannot reach the Scout API at ${BASE}. Is it running?`,
    );
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response
    .json()
    .catch(() => ({ message: response.statusText }));

  if (!response.ok) {
    const body = payload as {
      error?: string;
      message?: string;
      reason?: string;
      issues?: { path: string; message: string }[];
    };
    const detail =
      body.issues !== undefined && body.issues.length > 0
        ? body.issues.map((i) => `${i.path}: ${i.message}`).join("; ")
        : (body.message ?? response.statusText);
    throw new ApiError(
      response.status,
      body.error ?? "error",
      detail,
      body.reason,
    );
  }

  return payload as T;
}

export const api = {
  sources: () =>
    request<{ count: number; sources: SourceSummary[] }>("/sources"),

  health: () =>
    request<{
      status: string;
      database: string;
      sources: { total: number; keyed: number; keyedSourceIds: string[] };
    }>("/health"),

  listCases: () => request<{ count: number; cases: CaseRecord[] }>("/cases"),

  getCase: (id: string) => request<CaseRecord>(`/cases/${id}`),

  createCase: (body: {
    name: string;
    authorizationRef: string;
    notes?: string;
    scope?: { kind: "domain" | "identifier"; value: string; note?: string }[];
  }) => request<CaseRecord>("/cases", { method: "POST", body }),

  closeCase: (id: string, status: "ACTIVE" | "CLOSED") =>
    request<CaseRecord>(`/cases/${id}`, { method: "PATCH", body: { status } }),

  /**
   * Adding scope asserts authorization for the target, so the confirmation is
   * a required field rather than a client-side nicety — the API refuses
   * without it and records the claim in the audit log.
   */
  addScope: (
    caseId: string,
    body: { kind: "domain" | "identifier"; value: string; note?: string },
  ) =>
    request<ScopeEntry>(`/cases/${caseId}/scope`, {
      method: "POST",
      body: { ...body, confirmAuthorized: true },
    }),

  removeScope: (caseId: string, entryId: string) =>
    request<void>(`/cases/${caseId}/scope/${entryId}`, { method: "DELETE" }),

  listSubjects: (caseId: string) =>
    request<{ count: number; subjects: SubjectRecord[] }>(
      `/cases/${caseId}/subjects`,
    ),

  addSubject: (
    caseId: string,
    body: { kind: SubjectKind; value: string; label?: string },
  ) =>
    request<SubjectRecord>(`/cases/${caseId}/subjects`, {
      method: "POST",
      body,
    }),

  /** Plans only. Never executes anything. */
  plan: (body: { subject: Subject; caseId?: string }) =>
    request<QueryPlan>("/query", { method: "POST", body }),

  /**
   * Runs one scoped source against one subject. `confirm` is not optional at
   * the API, which is what makes "one confirmed action at a time" structural
   * rather than a UI convention.
   */
  execute: (path: string, body: { caseId: string; subject: Subject }) =>
    request<SourceResult>(path, {
      method: "POST",
      body: { ...body, confirm: true },
    }),

  listFindings: (caseId: string) =>
    request<{ count: number; findings: FindingRecord[] }>(
      `/cases/${caseId}/findings`,
    ),

  saveFinding: (
    caseId: string,
    body: {
      sourceId: string;
      title: string;
      summary?: string;
      data?: unknown;
      queryTerm: string;
      queryKind: SubjectKind;
      observedAt?: string;
      queryLogId?: string;
    },
  ) =>
    request<FindingRecord>(`/cases/${caseId}/findings`, {
      method: "POST",
      body,
    }),

  audit: (caseId: string) => request<AuditView>(`/cases/${caseId}/audit`),
};
