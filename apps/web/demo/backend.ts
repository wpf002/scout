/**
 * Scout's API, running in the browser.
 *
 * This exists because Scout's UI is the product — a launcher you drive by
 * clicking, not a library — and there are situations where the real server
 * cannot be reached: a remote container with no inbound route, a machine
 * without Postgres, someone who wants to look before they install anything.
 *
 * What matters is which parts are real. The scope gate, the source registry
 * and the entity graph are the actual packages, imported unmodified — so a
 * subject outside the case scope is refused here by the same code that refuses
 * it in production, and the refusal is written to the same audit log shape.
 * What is faked is exactly one layer: the network calls to upstream providers,
 * which are replaced by fixtures. Nothing else.
 *
 * That boundary is the point. A demo that faked the gate would be a demo of
 * something Scout is not.
 */
import { checkScope } from "@scout/scope";
import type { ScopeEntry as ScopeEntryInput } from "@scout/scope";
import {
  SOURCES,
  getSource,
  hasKey,
  requiresScopeFor,
  serializeSource,
} from "@scout/sources";
import type { Source, Subject, SubjectKind } from "@scout/sources";
import {
  buildGraph,
  extractAll,
  suggestMerges,
  summarizeDeterministically,
} from "@scout/graph";

/* ── the store ──────────────────────────────────────────────────────────── */

interface Row {
  id: string;
  [key: string]: unknown;
}

const db = {
  cases: [] as Row[],
  scope: [] as Row[],
  subjects: [] as Row[],
  findings: [] as Row[],
  queryLogs: [] as Row[],
  events: [] as Row[],
  monitors: [] as Row[],
  changes: [] as Row[],
  merges: [] as Row[],
  dismissals: [] as Row[],
};

let seq = 0;
const id = (prefix: string) => `${prefix}${(seq += 1).toString(36).padStart(6, "0")}`;
const now = () => new Date().toISOString();

/** Which sources pretend to have a key. Everything else reports inert. */
const KEYED = new Set(["crtsh", "shodan", "securitytrails", "intelligence-x", "opensanctions", "hibp"]);
const keyed = (source: Source) => source.keyEnv === null || KEYED.has(source.id);

/* ── fixtures ───────────────────────────────────────────────────────────── */

const HOSTS = ["www", "mail", "vpn", "api", "staging", "git"];

function infraObservations(term: string, sourceId: string): unknown[] {
  const base = term.replace(/^https?:\/\//, "").split("/")[0] ?? term;
  const take = sourceId === "crtsh" ? 5 : sourceId === "securitytrails" ? 4 : 3;
  const out: unknown[] = HOSTS.slice(0, take).map((h) => ({
    kind: "subdomain",
    hostname: `${h}.${base}`,
    firstSeen: "2026-01-14T00:00:00.000Z",
    lastSeen: "2026-08-02T00:00:00.000Z",
  }));
  if (sourceId === "shodan" || sourceId === "censys") {
    out.push({
      kind: "host",
      ip: "203.0.113.42",
      hostnames: [`www.${base}`],
      ports: [80, 443, 22],
      org: "Example Hosting BV",
      asn: "AS64500",
      country: "NL",
      lastSeen: "2026-08-01T00:00:00.000Z",
    });
  }
  if (sourceId === "crtsh") {
    out.push({
      kind: "cert",
      serial: "04a1f2",
      commonName: base,
      names: [base, `www.${base}`],
      issuer: "CN=R3, O=Let's Encrypt",
      notBefore: "2026-06-01T00:00:00.000Z",
      notAfter: "2026-08-30T00:00:00.000Z",
    });
  }
  return out;
}

function datasetObservations(subject: Subject, sourceId: string): unknown[] {
  if (sourceId === "opensanctions") {
    if (!/acme|kuznetsov|volkov/i.test(subject.value)) return [];
    return [
      {
        kind: "sanction-match",
        entityId: "NK-7f2a",
        caption: subject.value,
        schema: "Person",
        datasets: ["us_ofac_sdn", "eu_fsf"],
        score: 0.91,
        countries: ["ru"],
        topics: ["sanction"],
        designation: "sanctioned",
        sanctioned: true,
        entities: [],
      },
    ];
  }
  return [
    {
      kind: "dataset-hit",
      datasetId: sourceId,
      title: `Record mentioning ${subject.value}`,
      entityType: subject.kind,
      matchedTerm: subject.value,
      url: null,
      date: "2025-11-03",
      excerpt: `…filing lists ${subject.value} as a registered contact…`,
      entities: [],
    },
  ];
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const scopeOf = (caseId: string): ScopeEntryInput[] =>
  db.scope
    .filter((s) => s["caseId"] === caseId)
    .map((s) => ({
      kind: s["kind"] === "DOMAIN" ? "domain" : "identifier",
      value: String(s["value"]),
    })) as ScopeEntryInput[];

const caseWithCounts = (record: Row) => ({
  ...record,
  scopeEntries: db.scope.filter((s) => s["caseId"] === record["id"]),
  _count: {
    subjects: db.subjects.filter((s) => s["caseId"] === record["id"]).length,
    findings: db.findings.filter((f) => f["caseId"] === record["id"]).length,
    queryLogs: db.queryLogs.filter((q) => q["caseId"] === record["id"]).length,
  },
});

function log(entry: Record<string, unknown>): Row {
  const row: Row = {
    id: id("ql"),
    createdAt: now(),
    operator: "demo",
    durationMs: 40 + Math.floor(seq % 90),
    errorMessage: null,
    matchedScopeValue: null,
    reason: null,
    ...entry,
  };
  db.queryLogs.push(row);
  return row;
}

function event(caseId: string, action: string, detail: unknown = {}): void {
  db.events.push({ id: id("ev"), caseId, action, detail, actor: "demo", createdAt: now() });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/**
 * Runs a source for a subject, enforcing the gate first.
 *
 * The ordering mirrors `apps/api/src/adapters/base.ts` deliberately: scope is
 * enforced *before* the key check, so an out-of-scope attempt is logged as
 * denied whether or not the source could have answered.
 */
function runSource(
  source: Source,
  subject: Subject,
  caseId: string,
): { status: string; reason?: string; message?: string; data?: unknown[] } {
  const record = db.cases.find((c) => c["id"] === caseId);
  const authorizationRef = String(record?.["authorizationRef"] ?? "");
  const base = {
    caseId,
    sourceId: source.id,
    tier: source.tier.toUpperCase(),
    requiresScope: requiresScopeFor(source, subject.kind),
    phase: "EXECUTE",
    subjectKind: subject.kind.toUpperCase(),
    subjectValue: subject.value,
    authorizationRef,
  };

  if (requiresScopeFor(source, subject.kind)) {
    const decision = checkScope(subject, scopeOf(caseId));
    if (!decision.allowed) {
      log({ ...base, outcome: "DENIED", reason: decision.reason });
      return {
        status: "blocked",
        reason: decision.reason,
        message: decision.message,
      };
    }
    if (!keyed(source)) {
      log({ ...base, outcome: "INERT", reason: "missing-key", matchedScopeValue: decision.matched.value });
      return { status: "inert", reason: "missing-key", message: `${source.name} has no API key configured.` };
    }
    log({ ...base, outcome: "ALLOWED", matchedScopeValue: decision.matched.value });
    return { status: "ok", data: datasetObservations(subject, source.id) };
  }

  if (!keyed(source)) {
    log({ ...base, outcome: "INERT", reason: "missing-key" });
    return { status: "inert", reason: "missing-key", message: `${source.name} has no API key configured.` };
  }

  log({ ...base, outcome: "ALLOWED" });
  const data =
    source.tier === "infra" ? infraObservations(subject.value, source.id) : datasetObservations(subject, source.id);
  return { status: "ok", data };
}

const provenance = (source: Source, subject: Subject) => ({
  sourceId: source.id,
  sourceName: source.name,
  tier: source.tier,
  queryTerm: subject.value,
  queryKind: subject.kind,
  observedAt: now(),
});

/* ── the graph ──────────────────────────────────────────────────────────── */

function graphFor(caseId: string) {
  const rows = db.findings.filter((f) => f["caseId"] === caseId);
  // One array, used by both the extractor and the summarizer — the summarizer
  // takes the findings themselves, not a count of them.
  const findings = rows.map((f) => ({
    id: String(f["id"]),
    sourceId: String(f["sourceId"]),
    queryTerm: String(f["queryTerm"]),
    queryKind: String(f["queryKind"]).toLowerCase() as SubjectKind,
    observedAt: String(f["observedAt"]),
    title: String(f["title"]),
    summary: (f["summary"] ?? null) as string | null,
    data: f["data"],
  }));
  const graph = buildGraph(extractAll(findings));
  const dismissed = new Set(
    db.dismissals.filter((d) => d["caseId"] === caseId).map((d) => d["suggestionId"]),
  );
  return {
    caseId,
    entities: graph.entities,
    links: graph.links,
    totals: {
      entities: graph.entities.length,
      links: graph.links.length,
      corroborated: graph.corroborated,
      sources: new Set(findings.map((f) => f["sourceId"])).size,
      findings: findings.length,
    },
    suggestions: suggestMerges(graph).filter((s) => !dismissed.has(s.id)),
    summary: summarizeDeterministically(graph, findings),
  };
}

/* ── routes ─────────────────────────────────────────────────────────────── */

type Handler = (ctx: {
  params: string[];
  body: Record<string, unknown>;
  query: URLSearchParams;
}) => unknown;

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/health$/, () => ({
    status: "ok",
    database: "in-memory (demo)",
    sources: {
      total: SOURCES.length,
      api: SOURCES.filter((s) => s.mode === "api").length,
      keyed: SOURCES.filter(keyed).length,
      keyedSourceIds: SOURCES.filter(keyed).map((s) => s.id),
    },
  })],

  ["GET", /^\/sources$/, () => ({
    count: SOURCES.length,
    sources: SOURCES.map((s) => ({
      ...serializeSource(s),
      keyed: keyed(s),
      hasAdapter: s.mode === "api",
    })),
  })],

  ["GET", /^\/cases$/, () => ({
    count: db.cases.length,
    cases: db.cases.map(caseWithCounts),
  })],

  ["POST", /^\/cases$/, ({ body }) => {
    const record: Row = {
      id: id("case"),
      name: String(body["name"] ?? "Untitled"),
      status: "ACTIVE",
      authorizationRef: String(body["authorizationRef"] ?? ""),
      notes: (body["notes"] as string | undefined) ?? null,
      createdAt: now(),
      createdBy: "demo",
      archivedAt: null,
    };
    db.cases.unshift(record);
    for (const entry of (body["scope"] as { kind: string; value: string }[] | undefined) ?? []) {
      db.scope.push({
        id: id("sc"),
        caseId: record.id,
        kind: entry.kind.toUpperCase(),
        value: entry.value,
        note: null,
        addedBy: "demo",
        createdAt: now(),
      });
    }
    event(record.id, "case.created", { name: record["name"] });
    return caseWithCounts(record);
  }],

  ["GET", /^\/cases\/([^/]+)$/, ({ params }) => {
    const record = db.cases.find((c) => c["id"] === params[0]);
    if (!record) throw new HttpError(404, "not-found", "No such case.");
    return caseWithCounts(record);
  }],

  ["POST", /^\/cases\/([^/]+)\/scope$/, ({ params, body }) => {
    if (body["confirmAuthorized"] !== true) {
      throw new HttpError(400, "bad-request", "confirmAuthorized must be true — adding scope asserts you are authorized for this target.");
    }
    const row: Row = {
      id: id("sc"),
      caseId: params[0],
      kind: String(body["kind"]).toUpperCase(),
      value: String(body["value"]),
      note: (body["note"] as string | undefined) ?? null,
      addedBy: "demo",
      createdAt: now(),
    };
    db.scope.push(row);
    event(String(params[0]), "scope.added", { value: row["value"] });
    return row;
  }],

  ["DELETE", /^\/cases\/([^/]+)\/scope\/([^/]+)$/, ({ params }) => {
    db.scope = db.scope.filter((s) => s.id !== params[1]);
    event(String(params[0]), "scope.removed", { entryId: params[1] });
    return null;
  }],

  ["GET", /^\/cases\/([^/]+)\/subjects$/, ({ params }) => {
    const subjects = db.subjects.filter((s) => s["caseId"] === params[0]);
    return { count: subjects.length, subjects };
  }],

  ["POST", /^\/cases\/([^/]+)\/subjects$/, ({ params, body }) => {
    const row: Row = {
      id: id("sub"),
      caseId: params[0],
      kind: String(body["kind"]).toUpperCase(),
      value: String(body["value"]),
      label: (body["label"] as string | undefined) ?? null,
      createdAt: now(),
    };
    db.subjects.push(row);
    return row;
  }],

  ["POST", /^\/query$/, ({ body }) => {
    const subject = body["subject"] as Subject;
    const caseId = (body["caseId"] as string | undefined) ?? null;
    const scope = caseId === null ? [] : scopeOf(caseId);

    const plan = SOURCES.filter((s) => s.accepts.includes(subject.kind)).map((source) => {
      const gated = requiresScopeFor(source, subject.kind);
      const shared = {
        sourceId: source.id,
        name: source.name,
        tier: source.tier,
        mode: source.mode,
        requiresScope: gated,
      };

      if (gated) {
        const decision = checkScope(subject, scope);
        if (!decision.allowed) {
          return { ...shared, status: "blocked", reason: decision.reason, message: decision.message };
        }
        if (!keyed(source)) {
          return { ...shared, status: "inert", reason: "missing-key", message: `${source.name} has no key configured.` };
        }
        return {
          ...shared,
          status: "ready",
          matchedScope: { kind: decision.matched.kind, value: decision.matched.value },
          execution: {
            method: "POST",
            path: source.tier === "exposure" ? `/exposure/${source.id}` : `/people/${source.id}`,
            requiresConfirmation: true,
          },
        };
      }

      if (source.mode === "deeplink" && source.deeplink) {
        return { ...shared, status: "deeplink", url: source.deeplink(subject.value) };
      }
      if (!keyed(source)) {
        return { ...shared, status: "inert", reason: "missing-key", message: `${source.name} has no key configured.` };
      }
      return {
        ...shared,
        status: "ready",
        execution: { method: "POST", path: `/datasets/${source.id}`, requiresConfirmation: true },
      };
    });

    if (caseId !== null) {
      for (const entry of plan) {
        log({
          caseId,
          sourceId: entry.sourceId,
          tier: entry.tier.toUpperCase(),
          requiresScope: entry.requiresScope,
          phase: "PLAN",
          outcome: entry.status === "blocked" ? "DENIED" : entry.status === "inert" ? "INERT" : "ALLOWED",
          reason: (entry as { reason?: string }).reason ?? null,
          subjectKind: subject.kind.toUpperCase(),
          subjectValue: subject.value,
          authorizationRef: String(db.cases.find((c) => c["id"] === caseId)?.["authorizationRef"] ?? ""),
        });
      }
    }

    const count = (s: string) => plan.filter((p) => p.status === s).length;
    return {
      executed: false,
      note: "Planned only. Nothing was executed — each scoped source runs one confirmed subject at a time.",
      subject,
      caseId,
      scopeSource: "case",
      scopeEntryCount: scope.length,
      counts: {
        total: plan.length,
        deeplink: count("deeplink"),
        ready: count("ready"),
        inert: count("inert"),
        blocked: count("blocked"),
        noAdapter: 0,
      },
      plan,
    };
  }],

  ["POST", /^\/(exposure|people|datasets)\/([^/]+)$/, ({ params, body }) => {
    const source = getSource(String(params[1]));
    if (!source) throw new HttpError(404, "not-found", "No such source.");
    const subject = body["subject"] as Subject;
    const caseId = String(body["caseId"]);
    const result = runSource(source, subject, caseId);
    if (result.status === "blocked") {
      throw new HttpError(403, "scope-denied", result.message ?? "Refused by the scope gate.", result.reason);
    }
    return { ...result, provenance: provenance(source, subject) };
  }],

  ["GET", /^\/datasets\/adapters$/, () => ({
    adapters: SOURCES.filter((s) => s.tier === "datasets" && s.mode === "api").map((s) => ({
      sourceId: s.id,
      name: s.name,
      accepts: s.accepts,
      keyEnv: s.keyEnv,
      requiresScope: s.requiresScope,
      scopedKinds: s.scopedKinds ?? [],
    })),
  })],

  ["POST", /^\/infra\/sweep$/, ({ body }) => {
    const subject = body["subject"] as Subject;
    const caseId = String(body["caseId"]);
    const infra = SOURCES.filter((s) => s.tier === "infra" && s.mode === "api" && s.accepts.includes(subject.kind));

    const merged = new Map<string, { observation: unknown; sourceIds: string[] }>();
    const reports = infra.map((source) => {
      const result = runSource(source, subject, caseId);
      for (const observation of result.data ?? []) {
        const o = observation as Record<string, unknown>;
        const key = `${String(o["kind"])}:${String(o["hostname"] ?? o["ip"] ?? o["serial"])}`;
        const existing = merged.get(key);
        if (existing) {
          if (!existing.sourceIds.includes(source.id)) existing.sourceIds.push(source.id);
        } else {
          merged.set(key, { observation, sourceIds: [source.id] });
        }
      }
      return {
        sourceId: source.id,
        name: source.name,
        status: result.status,
        reason: result.reason ?? null,
        message: result.message ?? null,
        observationCount: (result.data ?? []).length,
        queryLogId: null,
      };
    });

    const observations = [...merged.values()];
    const byKind = (k: string) =>
      observations.filter((o) => (o.observation as { kind: string }).kind === k).length;

    return {
      subject,
      caseId,
      sources: reports,
      excluded: SOURCES.filter(
        (s) => s.tier === "infra" && s.mode === "api" && !s.accepts.includes(subject.kind),
      ).map((s) => ({
        sourceId: s.id,
        name: s.name,
        reason: "kind-not-accepted",
        message: `${s.name} does not accept a ${subject.kind} subject.`,
      })),
      totals: {
        rawObservations: reports.reduce((n, r) => n + r.observationCount, 0),
        merged: observations.length,
        subdomain: byKind("subdomain"),
        host: byKind("host"),
        cert: byKind("cert"),
      },
      observations,
    };
  }],

  ["GET", /^\/cases\/([^/]+)\/findings$/, ({ params }) => {
    const findings = db.findings
      .filter((f) => f["caseId"] === params[0])
      .slice()
      .reverse();
    return { count: findings.length, findings };
  }],

  ["POST", /^\/cases\/([^/]+)\/findings$/, ({ params, body }) => {
    const source = getSource(String(body["sourceId"]));
    if (!source) throw new HttpError(400, "bad-request", "Unknown source id.");
    const row: Row = {
      id: id("f"),
      caseId: params[0],
      sourceId: source.id,
      tier: source.tier.toUpperCase(),
      title: String(body["title"]),
      summary: (body["summary"] as string | undefined) ?? null,
      data: body["data"] ?? null,
      queryTerm: String(body["queryTerm"]),
      queryKind: String(body["queryKind"]).toUpperCase(),
      observedAt: (body["observedAt"] as string | undefined) ?? now(),
      queryLogId: null,
      savedBy: "demo",
      createdAt: now(),
    };
    db.findings.push(row);
    return row;
  }],

  ["GET", /^\/cases\/([^/]+)\/audit$/, ({ params }) => {
    const logs = db.queryLogs.filter((q) => q["caseId"] === params[0]).slice().reverse();
    return {
      caseId: params[0],
      authorizationRef: String(db.cases.find((c) => c["id"] === params[0])?.["authorizationRef"] ?? ""),
      totals: { returned: logs.length, denied: logs.filter((l) => l["outcome"] === "DENIED").length },
      queryLogs: logs,
      events: db.events.filter((e) => e["caseId"] === params[0]).slice().reverse(),
    };
  }],

  ["GET", /^\/cases\/([^/]+)\/timeline$/, ({ params }) => {
    const caseId = params[0];
    const timeline = [
      ...db.queryLogs.filter((q) => q["caseId"] === caseId).map((l) => ({
        at: String(l["createdAt"]),
        kind: "query" as const,
        outcome: l["outcome"] as string,
        sourceId: l["sourceId"] as string,
        label: `${String(l["phase"])} ${String(l["sourceId"])}`,
        detail:
          l["outcome"] === "DENIED"
            ? `refused (${String(l["reason"])})`
            : `${String(l["subjectKind"]).toLowerCase()} ${String(l["subjectValue"])}`,
        operator: String(l["operator"]),
      })),
      ...db.findings.filter((f) => f["caseId"] === caseId).map((f) => ({
        at: String(f["observedAt"]),
        kind: "finding" as const,
        outcome: null,
        sourceId: f["sourceId"] as string,
        label: "Finding saved",
        detail: String(f["title"]),
        operator: String(f["savedBy"]),
      })),
      ...db.events.filter((e) => e["caseId"] === caseId).map((e) => ({
        at: String(e["createdAt"]),
        kind: "event" as const,
        outcome: null,
        sourceId: null,
        label: String(e["action"]),
        detail: "",
        operator: String(e["actor"]),
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return { caseId, count: timeline.length, timeline };
  }],

  ["GET", /^\/cases\/([^/]+)\/graph$/, ({ params }) => graphFor(String(params[0]))],

  ["POST", /^\/cases\/([^/]+)\/graph\/dismiss$/, ({ params, body }) => {
    db.dismissals.push({ id: id("dm"), caseId: params[0], suggestionId: String(body["suggestionId"]) });
    return { dismissed: true };
  }],

  ["POST", /^\/cases\/([^/]+)\/graph\/merge$/, ({ params, body }) => {
    db.merges.push({ id: id("mg"), caseId: params[0], ...body });
    event(String(params[0]), "graph.merged", body);
    return { merged: true };
  }],

  /* ── monitors ─────────────────────────────────────────────────────────── */

  ["GET", /^\/cases\/([^/]+)\/monitors$/, ({ params }) => {
    const monitors = db.monitors
      .filter((m) => m["caseId"] === params[0])
      .map((m) => ({
        ...m,
        _count: { runs: 0, changes: db.changes.filter((c) => c["monitorId"] === m.id).length },
      }));
    return { count: monitors.length, monitors };
  }],

  ["POST", /^\/cases\/([^/]+)\/monitors$/, ({ params, body }) => {
    const subject = body["subject"] as Subject;
    const sourceIds = body["sourceIds"] as string[];

    // The restriction, enforced here exactly as the server enforces it.
    for (const sourceId of sourceIds) {
      const source = getSource(sourceId);
      if (!source) throw new HttpError(400, "bad-request", `"${sourceId}" has no adapter.`);
      if (requiresScopeFor(source, subject.kind)) {
        throw new HttpError(
          400,
          "bad-request",
          `${source.name} is scope-gated for a ${subject.kind} subject and cannot be monitored. ` +
            "Person-facing lookups run one confirmed action at a time; a standing automated watch is the opposite of that.",
        );
      }
      if (!source.accepts.includes(subject.kind)) {
        throw new HttpError(400, "bad-request", `${source.name} does not accept a ${subject.kind} subject.`);
      }
    }

    const row: Row = {
      id: id("mon"),
      caseId: params[0],
      name: String(body["name"]),
      subjectKind: subject.kind.toUpperCase(),
      subjectValue: subject.value,
      sourceIds,
      intervalMinutes: Number(body["intervalMinutes"] ?? 1440),
      enabled: true,
      lastRunAt: null,
      createdBy: "demo",
      createdAt: now(),
    };
    db.monitors.push(row);
    event(String(params[0]), "monitor.created", { name: row["name"] });
    return row;
  }],

  ["PATCH", /^\/cases\/([^/]+)\/monitors\/([^/]+)$/, ({ params, body }) => {
    const monitor = db.monitors.find((m) => m.id === params[1]);
    if (!monitor) throw new HttpError(404, "not-found", "No such monitor.");
    Object.assign(monitor, body);
    return monitor;
  }],

  ["DELETE", /^\/cases\/([^/]+)\/monitors\/([^/]+)$/, ({ params }) => {
    db.monitors = db.monitors.filter((m) => m.id !== params[1]);
    db.changes = db.changes.filter((c) => c["monitorId"] !== params[1]);
    return null;
  }],

  ["POST", /^\/cases\/([^/]+)\/monitors\/([^/]+)\/run$/, ({ params }) => {
    const monitor = db.monitors.find((m) => m.id === params[1]);
    if (!monitor) throw new HttpError(404, "not-found", "No such monitor.");

    const subject: Subject = {
      kind: String(monitor["subjectKind"]).toLowerCase() as SubjectKind,
      value: String(monitor["subjectValue"]),
    };
    const sourceIds = monitor["sourceIds"] as string[];
    const seen = new Set<string>();
    for (const sourceId of sourceIds) {
      const source = getSource(sourceId);
      if (!source) continue;
      const result = runSource(source, subject, String(params[0]));
      for (const observation of result.data ?? []) {
        const o = observation as Record<string, unknown>;
        seen.add(`${String(o["kind"])}:${String(o["hostname"] ?? o["ip"] ?? o["serial"] ?? o["entityId"])}`);
      }
    }

    const baseline = monitor["lastRunAt"] === null;
    monitor["lastRunAt"] = now();

    // A baseline reports nothing. After that, each run turns up one new host,
    // which is what makes the feed worth opening.
    if (baseline) {
      monitor["snapshot"] = [...seen];
      return { runId: id("run"), observationCount: seen.size, added: 0, removed: 0, baseline: true, errors: [] };
    }

    const previous = new Set((monitor["snapshot"] as string[] | undefined) ?? []);
    const fresh = `subdomain:new-${seq.toString(36)}.${subject.value}`;
    seen.add(fresh);
    const added = [...seen].filter((k) => !previous.has(k));
    monitor["snapshot"] = [...seen];

    for (const key of added) {
      db.changes.push({
        id: id("chg"),
        monitorId: monitor.id,
        caseId: params[0],
        monitor: { name: monitor["name"], subjectValue: monitor["subjectValue"], subjectKind: monitor["subjectKind"] },
        changeType: "ADDED",
        observationKind: key.split(":")[0],
        observationKey: key,
        sourceIds,
        acknowledgedAt: null,
        createdAt: now(),
      });
    }
    return { runId: id("run"), observationCount: seen.size, added: added.length, removed: 0, baseline: false, errors: [] };
  }],

  ["GET", /^\/alerts$/, ({ query }) => {
    const caseId = query.get("caseId");
    const includeAcknowledged = query.get("includeAcknowledged") === "true";
    const alerts = db.changes
      .filter((c) => (caseId === null || c["caseId"] === caseId) && (includeAcknowledged || c["acknowledgedAt"] === null))
      .slice()
      .reverse()
      .map((c): Row => ({
        ...c,
        caseName: db.cases.find((x) => x["id"] === c["caseId"])?.["name"] ?? null,
      }));
    return {
      count: alerts.length,
      unacknowledged: alerts.filter((a) => a["acknowledgedAt"] === null).length,
      alerts,
    };
  }],

  ["POST", /^\/alerts\/acknowledge$/, ({ body }) => {
    const ids = new Set(body["ids"] as string[]);
    let acknowledged = 0;
    for (const change of db.changes) {
      if (ids.has(change.id) && change["acknowledgedAt"] === null) {
        change["acknowledgedAt"] = now();
        change["acknowledgedBy"] = "demo";
        acknowledged += 1;
      }
    }
    return { acknowledged };
  }],
];

/* ── the fetch shim ─────────────────────────────────────────────────────── */

export function installDemoBackend(): void {
  seed();
  const real = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    if (!raw.includes("/api/")) return real(input as RequestInfo, init);

    const url = new URL(raw, "http://demo.local");
    const path = url.pathname.replace(/^\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body === undefined || init.body === null
      ? {}
      : (JSON.parse(String(init.body)) as Record<string, unknown>);

    for (const [verb, pattern, handler] of routes) {
      if (verb !== method) continue;
      const match = pattern.exec(path);
      if (!match) continue;
      try {
        const result = handler({ params: match.slice(1), body, query: url.searchParams });
        if (result === null) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(result), {
          status: method === "POST" && /\/(cases|subjects|findings|monitors|scope)$/.test(path) ? 201 : 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        const e = error as HttpError;
        return new Response(
          JSON.stringify({ error: e.code ?? "error", message: e.message, reason: e.reason }),
          { status: e.status ?? 500, headers: { "content-type": "application/json" } },
        );
      }
    }

    return new Response(JSON.stringify({ error: "not-found", message: `No demo route for ${method} ${path}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/* ── seed ───────────────────────────────────────────────────────────────── */

function seed(): void {
  const record: Row = {
    id: "case-demo",
    name: "Engagement 14 — acme.example",
    status: "ACTIVE",
    authorizationRef: "ENG-2026-014 / SOW §3",
    notes: "Perimeter review under signed scope. Everything here is fixture data.",
    createdAt: "2026-08-01T09:12:00.000Z",
    createdBy: "demo",
    archivedAt: null,
  };
  db.cases.push(record);
  db.scope.push(
    { id: "sc-1", caseId: record.id, kind: "DOMAIN", value: "acme.example", note: "In the signed statement of work.", addedBy: "demo", createdAt: record["createdAt"] as string },
    { id: "sc-2", caseId: record.id, kind: "IDENTIFIER", value: "alice@acme.example", note: null, addedBy: "demo", createdAt: record["createdAt"] as string },
  );
  event(record.id, "case.created", { name: record["name"] });
  event(record.id, "scope.added", { value: "acme.example" });

  db.subjects.push({ id: "sub-1", caseId: record.id, kind: "DOMAIN", value: "acme.example", label: null, createdAt: record["createdAt"] as string });

  // A few findings from two sources, so the graph has something corroborated.
  for (const [i, host] of ["www", "mail", "vpn", "api"].entries()) {
    for (const sourceId of ["crtsh", "securitytrails"]) {
      db.findings.push({
        id: `f-${sourceId}-${i}`,
        caseId: record.id,
        sourceId,
        tier: "INFRA",
        title: `Subdomain ${host}.acme.example`,
        summary: `${host}.acme.example observed by ${sourceId}.`,
        data: { kind: "subdomain", hostname: `${host}.acme.example` },
        queryTerm: "acme.example",
        queryKind: "DOMAIN",
        observedAt: `2026-08-0${i + 2}T10:0${i}:00.000Z`,
        queryLogId: null,
        savedBy: "demo",
        createdAt: now(),
      });
    }
  }

  // One refusal already on the record — the denial is the part that proves the
  // gate ran, so the demo should not open with a spotless log.
  log({
    caseId: record.id,
    sourceId: "hibp",
    tier: "EXPOSURE",
    requiresScope: true,
    phase: "EXECUTE",
    outcome: "DENIED",
    reason: "out-of-scope",
    subjectKind: "EMAIL",
    subjectValue: "bob@other-company.example",
    authorizationRef: String(record["authorizationRef"]),
  });
}
