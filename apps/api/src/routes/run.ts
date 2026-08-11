import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SOURCES,
  detectSubjectKind,
  subjectKindSchema,
  type Detection,
  type Source,
  type Subject,
  type SubjectKind,
} from "@scout/sources";
import { ScopeError } from "@scout/scope";
import { executeSource } from "../adapters/base.js";
import { INFRA_ADAPTERS } from "../adapters/infra/index.js";
import { DATASET_ADAPTERS } from "../adapters/datasets/index.js";
import { SCOPED_ADAPTERS } from "../adapters/scoped/index.js";
import { operatorOf } from "../auth.js";
import { badRequest } from "../errors.js";
import { persistRun } from "./history.js";
import { jsonSafe } from "@scout/db";

/**
 * One indicator in, every applicable source run, one result set out.
 *
 * This is the endpoint behind the single box. It differs from `/query`, which
 * plans and never executes, in that it actually runs things — but it is not a
 * blind fan-out either. It runs only sources that accept this subject kind,
 * and every source that did not run comes back as a row saying why.
 *
 * That last part is the whole design. A source omitted from the results is
 * indistinguishable from a source that found nothing, and an investigator who
 * cannot tell those apart will read an absence as a finding. So nothing is
 * ever dropped: no key, not installed, out of scope, wrong subject kind — each
 * is a visible row with a reason.
 */

const runRequestSchema = z.object({
  indicator: z.string().trim().min(1).max(512),
  caseId: z.string().min(1),
  /** Overrides detection when the investigator corrects the guess. */
  kind: subjectKindSchema.optional(),
  /** Restricts the run to named sources. Absent means everything applicable. */
  sourceIds: z.array(z.string().min(1)).nonempty().optional(),
});

export type RunStatus =
  | "ok"
  | "empty"
  | "inert"
  | "blocked"
  | "error"
  | "deeplink"
  | "no-adapter";

export interface RunResultRow {
  sourceId: string;
  name: string;
  tier: string;
  mode: string;
  requiresScope: boolean;
  status: RunStatus;
  /** Why it did not produce results. Null when it did. */
  reason: string | null;
  message: string | null;
  /** Normalized observations. Empty for anything that did not run. */
  data: unknown[];
  count: number;
  /** Present for deeplink sources: the URL for the investigator to open. */
  url: string | null;
  durationMs: number;
}

export interface RunResponse {
  subject: Subject;
  detection: Detection;
  caseId: string;
  startedAt: string;
  finishedAt: string;
  results: RunResultRow[];
  summary: {
    sourcesConsidered: number;
    ran: number;
    withResults: number;
    observations: number;
    inert: number;
    blocked: number;
    errored: number;
  };
}

/**
 * How many sources run at once.
 *
 * Bounded because an unbounded run against every source is a burst of outbound
 * traffic that upstream rate limiters read as abuse — and because the CLI
 * sources are subprocesses, where unbounded means one process per source at
 * once. Six keeps a full run quick without either problem.
 */
const CONCURRENCY = 6;

interface Runnable {
  source: Source;
  run: (subject: Subject) => Promise<unknown[]>;
}

/**
 * Every source that has an execution adapter, from the three registries.
 *
 * Derived rather than listed so a new adapter is reachable here the moment it
 * is registered — a source that runs everywhere except the main run surface is
 * the kind of gap nobody notices until an investigation misses something.
 */
function runnableAdapters(): Map<string, Runnable> {
  const entries: Runnable[] = [
    ...INFRA_ADAPTERS.map((a) => ({
      source: a.source,
      run: a.run as (s: Subject) => Promise<unknown[]>,
    })),
    ...DATASET_ADAPTERS.map((a) => ({
      source: a.source,
      run: a.run as (s: Subject) => Promise<unknown[]>,
    })),
    ...SCOPED_ADAPTERS.map((a) => ({
      source: a.source,
      run: a.run as (s: Subject) => Promise<unknown[]>,
    })),
  ];
  return new Map(entries.map((entry) => [entry.source.id, entry]));
}

/** Runs tasks with a bounded number in flight, preserving input order. */
async function pooled<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
  onSettled?: (value: T, index: number) => void,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    async () => {
      for (;;) {
        const index = next++;
        const task = tasks[index];
        if (task === undefined) return;
        const value = await task();
        results[index] = value;
        // Fires as each source lands, which is what lets the streaming route
        // report progress instead of going quiet for the whole run.
        onSettled?.(value, index);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/**
 * Mailbox providers whose domain says nothing about the person.
 *
 * An email implies a domain, and for a corporate address that domain is the
 * most productive thing to search — it reaches nineteen sources where the
 * address alone reaches four. For a free provider it reaches nineteen sources
 * about Google, which is noise wearing the costume of a finding.
 */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "hushmail.com",
  "qq.com",
  "163.com",
  "126.com",
]);

/**
 * A second subject worth running alongside the one that was asked for.
 *
 * Only the email-to-domain case exists today. It is not a guess about the
 * person — the results are about the organisation's infrastructure — so the
 * rows carry the derived subject and the surface says which is which.
 */
export function derivedSubject(subject: Subject): Subject | null {
  if (subject.kind !== "email") return null;

  const domain = subject.value.split("@")[1]?.trim().toLowerCase();
  if (domain === undefined || domain.length === 0) return null;
  if (FREE_MAIL.has(domain)) return null;

  return { kind: "domain", value: domain };
}

interface RunPlan {
  subject: Subject;
  detection: Detection;
  caseId: string;
  considered: Source[];
  tasks: (() => Promise<RunResultRow>)[];
}

/**
 * Works out what to run, without running it.
 *
 * Shared by `/run` and `/run/stream` so the two cannot drift — a source that
 * appeared in one and not the other would be an investigation silently missing
 * a result depending on which endpoint the page happened to call.
 */
function planRun(body: unknown, operator: string): RunPlan {
  const parsed = runRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? "Invalid run request.");
    }
    const { indicator, caseId, kind, sourceIds } = parsed.data;

    const detection = detectSubjectKind(indicator);
    // An explicit kind overrides detection but keeps the normalized value —
    // correcting the guess should not also undo the refanging.
    const subjectKind: SubjectKind = kind ?? detection.kind;
    const subject: Subject = {
      kind: subjectKind,
      value: detection.normalized,
    };

    const adapters = runnableAdapters();

    const considered = SOURCES.filter((source) => {
      if (sourceIds !== undefined && !sourceIds.includes(source.id)) {
        return false;
      }
      return source.accepts.includes(subjectKind);
    });

    // An email also gets its domain searched, where the domain is worth
    // searching. Person-facing sources are excluded from the derived run: the
    // operator asked about one address, and a domain is not permission to
    // enumerate everyone at it.
    const derived = derivedSubject(subject);
    const derivedSources =
      derived === null
        ? []
        : SOURCES.filter(
            (source) =>
              source.accepts.includes("domain") &&
              !source.requiresScope &&
              !considered.some((c) => c.id === source.id),
          );

    const plannedFor = new Map<string, Subject>();
    for (const source of considered) plannedFor.set(source.id, subject);
    for (const source of derivedSources) {
      plannedFor.set(source.id, derived as Subject);
    }

    const all = [...considered, ...derivedSources];

    const tasks = all.map((source) => async (): Promise<RunResultRow> => {
      const subject = plannedFor.get(source.id) as Subject;
      const base = {
        sourceId: source.id,
        name: source.name,
        tier: source.tier,
        mode: source.mode,
        requiresScope: source.requiresScope,
        data: [] as unknown[],
        count: 0,
        url: null as string | null,
        durationMs: 0,
      };

      // A deeplink is never fetched. Scout formats a URL and the investigator's
      // own browser opens it — the subject never reaches a Scout-owned request
      // for these sources, which is the point of the mode.
      if (source.mode === "deeplink") {
        return {
          ...base,
          status: "deeplink",
          reason: null,
          message: null,
          url: source.deeplink?.(subject.value) ?? null,
        };
      }

      const adapter = adapters.get(source.id);
      if (adapter === undefined) {
        return {
          ...base,
          status: "no-adapter",
          reason: "no-adapter",
          message: `${source.name} has no execution adapter yet.`,
          url: source.deeplink?.(subject.value) ?? null,
        };
      }

      const began = Date.now();
      try {
        const result = await executeSource(source, {
          subject,
          caseId,
          operator,
        }, adapter.run);
        const durationMs = Date.now() - began;

        if (result.status === "ok") {
          const data = Array.isArray(result.data) ? result.data : [];
          return {
            ...base,
            status: data.length === 0 ? "empty" : "ok",
            reason: null,
            message: null,
            data,
            count: data.length,
            durationMs,
          };
        }

        return {
          ...base,
          status: result.status,
          reason: result.reason ?? null,
          message: result.message ?? null,
          durationMs,
        };
      } catch (error) {
        const durationMs = Date.now() - began;

        // A scope denial is a refusal, not a failure. `executeScopedSource`
        // throws it — correctly, since a 403 is the right answer to a direct
        // request — but here it is one row among many, and the run continues.
        // Reporting it as an error would bury the one message the investigator
        // needs ("this subject is not in the case scope") under a generic
        // failure, and would make a refusal look like a broken tool.
        if (error instanceof ScopeError) {
          return {
            ...base,
            status: "blocked",
            reason: error.reason,
            message: error.message,
            durationMs,
          };
        }

        // Anything else: one source failing must never sink the run. The
        // investigator gets every other result plus an honest row for this one.
        const message = error instanceof Error ? error.message : String(error);
        return {
          ...base,
          status: "error",
          reason: "adapter-threw",
          message,
          durationMs,
        };
      }
    });

  return { subject, detection, caseId, considered: all, tasks };
}

/** Rolls per-source rows up into the summary both endpoints return. */
function summarize(results: RunResultRow[], considered: number) {
  return {
    sourcesConsidered: considered,
    ran: results.filter((r) => r.status === "ok" || r.status === "empty").length,
    withResults: results.filter((r) => r.status === "ok").length,
    observations: results.reduce((total, r) => total + r.count, 0),
    inert: results.filter((r) => r.status === "inert").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    errored: results.filter((r) => r.status === "error").length,
  };
}

export async function registerRunRoutes(app: FastifyInstance): Promise<void> {
  app.post("/run", async (request) => {
    const plan = planRun(request.body, operatorOf(request));
    const startedAt = new Date();
    const results = await pooled(plan.tasks, CONCURRENCY);
    const finishedAt = new Date();

    // Kept so the next run can be compared against this one. A failure to
    // persist must not lose the results the operator is waiting for.
    await persistRun(
      plan.caseId,
      plan.subject,
      results,
      operatorOf(request),
    ).catch(() => 0);

    const response: RunResponse = {
      subject: plan.subject,
      detection: plan.detection,
      caseId: plan.caseId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      results,
      summary: summarize(results, plan.considered.length),
    };

    // BigInt everywhere it counts something — HIBP's breach counts are the
    // worked example — and JSON has no integer wide enough. Without this the
    // whole response dies serializing, so a source that succeeded reads on the
    // page as "Unavailable".
    return jsonSafe(response);
  });

  /**
   * The same run, reported as it happens.
   *
   * A full run takes the better part of a minute — theHarvester alone queries
   * several backends — and the page spent all of it blank. Newline-delimited
   * JSON rather than a single response means the surface can name every source
   * up front, fill a real progress bar as each one lands, and show findings
   * while the slow sources are still working.
   *
   * NDJSON rather than server-sent events: this is one response read once, not
   * a subscription, and SSE would add reconnect semantics that would silently
   * re-run an investigation.
   */
  app.post("/run/stream", async (request, reply) => {
    const plan = planRun(request.body, operatorOf(request));
    const startedAt = new Date();

    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Without this a proxy may hold the whole body, which would defeat the
      // entire point of streaming it.
      "x-accel-buffering": "no",
    });

    const send = (event: unknown): void => {
      reply.raw.write(`${JSON.stringify(jsonSafe(event))}\n`);
    };

    send({
      type: "start",
      subject: plan.subject,
      detection: plan.detection,
      caseId: plan.caseId,
      startedAt: startedAt.toISOString(),
      sources: plan.considered.map((source) => ({
        sourceId: source.id,
        name: source.name,
        tier: source.tier,
        requiresScope: source.requiresScope,
      })),
    });

    const results = await pooled(plan.tasks, CONCURRENCY, (row) => {
      send({ type: "result", row });
    });

    await persistRun(
      plan.caseId,
      plan.subject,
      results,
      operatorOf(request),
    ).catch(() => 0);

    send({
      type: "done",
      finishedAt: new Date().toISOString(),
      summary: summarize(results, plan.considered.length),
    });

    reply.raw.end();
    return reply;
  });

  /** Detection on its own, so the surface can show the guess before running. */
  app.get("/run/detect", async (request) => {
    const query = z
      .object({ indicator: z.string().trim().min(1).max(512) })
      .safeParse(request.query);
    if (!query.success) {
      throw badRequest("An indicator is required.");
    }

    const detection = detectSubjectKind(query.data.indicator);
    const applicable = SOURCES.filter((s) =>
      s.accepts.includes(detection.kind),
    );

    return {
      detection,
      applicableSources: applicable.length,
      sourceIds: applicable.map((s) => s.id),
    };
  });
}
