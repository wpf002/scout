import type {
  Alert,
  AuditView,
  CaseGraph,
  CaseRecord,
  DatasetAdapterInfo,
  DatasetRunResult,
  FindingRecord,
  InfraSweepResult,
  MonitorRecord,
  MonitorRunResult,
  QueryPlan,
  ScopeEntry,
  SourceResult,
  SourceSummary,
  Subject,
  SubjectKind,
  SubjectRecord,
  TimelineEntry,
} from "./types";

/**
 * Where the API lives, from the browser's point of view.
 *
 * Empty by default, which means same-origin `/api/…` — Next rewrites that to
 * the real API server. One URL to open, and no cross-origin request, so a
 * mistyped port or a stale CORS allowlist cannot produce a page that loads and
 * then silently shows nothing.
 */
const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ""}/api`;

const TOKEN_KEY = "scout.operatorToken";

/**
 * The operator token, held in sessionStorage.
 *
 * Deliberately NOT a NEXT_PUBLIC_ env var: that would bake a credential into
 * the client bundle, where it ships to everyone who loads the page and lives
 * in the build output. sessionStorage keeps it to one tab, one session, and
 * out of the repository.
 */
export function getOperatorToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function setOperatorToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token === null || token.trim().length === 0) {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } else {
    window.sessionStorage.setItem(TOKEN_KEY, token.trim());
  }
}

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
  const token = getOperatorToken();
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (token !== null) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      0,
      "unreachable",
      "Cannot reach the Scout API. Start it with `pnpm --filter @scout/api dev`, " +
        "or run `./scripts/start.sh` to bring up everything at once.",
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
      response.status === 401
        ? "This Scout requires an operator token. Set one from the header."
        : body.issues !== undefined && body.issues.length > 0
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

  /**
   * Runs several infrastructure sources at once and merges their output.
   *
   * Batch execution is permitted here precisely because these sources are not
   * person-facing — they look at hosts and certificates. The API draws only
   * from its infra adapter registry, so a scoped source cannot be swept.
   */
  infraSweep: (body: { caseId: string; subject: Subject }) =>
    request<InfraSweepResult>("/infra/sweep", {
      method: "POST",
      body: { ...body, confirm: true },
    }),

  datasetAdapters: () =>
    request<{ count: number; adapters: DatasetAdapterInfo[] }>(
      "/datasets/adapters",
    ),

  /**
   * Runs one dataset source. There is no sweep here on purpose: dataset
   * sources are not uniformly non-scoped — Intelligence X is gated for email
   * selectors — so they run one at a time.
   *
   * `confirm` is required only when the gate applies to this subject kind; the
   * API rejects the call without it and says so.
   */
  runDataset: (
    sourceId: string,
    body: { caseId: string; subject: Subject; confirm?: true },
  ) =>
    request<DatasetRunResult>(`/datasets/${sourceId}`, {
      method: "POST",
      body,
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

  timeline: (caseId: string) =>
    request<{ count: number; timeline: TimelineEntry[] }>(
      `/cases/${caseId}/timeline`,
    ),

  /* ── monitoring ─────────────────────────────────────────────────────── */

  listMonitors: (caseId: string) =>
    request<{ count: number; monitors: MonitorRecord[] }>(
      `/cases/${caseId}/monitors`,
    ),

  /**
   * Creates a standing watch. The API rejects any source that is gated for
   * this subject kind — you can watch infrastructure, never a person on a
   * timer.
   */
  createMonitor: (
    caseId: string,
    body: {
      name: string;
      subject: Subject;
      sourceIds: string[];
      intervalMinutes?: number;
    },
  ) =>
    request<MonitorRecord>(`/cases/${caseId}/monitors`, {
      method: "POST",
      body,
    }),

  runMonitor: (caseId: string, monitorId: string) =>
    request<MonitorRunResult>(`/cases/${caseId}/monitors/${monitorId}/run`, {
      method: "POST",
    }),

  setMonitorEnabled: (caseId: string, monitorId: string, enabled: boolean) =>
    request<MonitorRecord>(`/cases/${caseId}/monitors/${monitorId}`, {
      method: "PATCH",
      body: { enabled },
    }),

  deleteMonitor: (caseId: string, monitorId: string) =>
    request<void>(`/cases/${caseId}/monitors/${monitorId}`, {
      method: "DELETE",
    }),

  alerts: (caseId?: string) =>
    request<{ count: number; unacknowledged: number; alerts: Alert[] }>(
      caseId === undefined ? "/alerts" : `/alerts?caseId=${caseId}`,
    ),

  acknowledgeAlerts: (ids: string[]) =>
    request<{ acknowledged: number }>("/alerts/acknowledge", {
      method: "POST",
      body: { ids },
    }),

  /** The entity graph, recomputed from findings on every read. */
  graph: (caseId: string) => request<CaseGraph>(`/cases/${caseId}/graph`),

  /**
   * Confirms two entities are the same thing. Never inferred from a score —
   * the operator asserts it, and the assertion is audited.
   */
  mergeEntities: (
    caseId: string,
    body: { winningKey: string; losingKey: string; reason: string },
  ) =>
    request<unknown>(`/cases/${caseId}/graph/merge`, {
      method: "POST",
      body: { ...body, confirm: true },
    }),

  undoMerge: (caseId: string, losingKey: string) =>
    request<void>(
      `/cases/${caseId}/graph/merge/${encodeURIComponent(losingKey)}`,
      { method: "DELETE" },
    ),

  dismissSuggestion: (caseId: string, suggestionId: string) =>
    request<unknown>(`/cases/${caseId}/graph/dismiss`, {
      method: "POST",
      body: { suggestionId },
    }),
};
