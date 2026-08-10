import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, jsonSafe, toPrismaTier, toPrismaSubjectKind } from "@scout/db";
import type { Subject } from "@scout/sources";
import { badRequest } from "../errors.js";
import type { RunResultRow } from "./run.js";

/**
 * Runs, kept.
 *
 * Until now every search was thrown away on reload. That made Scout a search
 * box rather than an investigation tool: you could see what is true now, and
 * never that a host appeared last week, or that a subdomain the target used to
 * have is gone. Change over time is most of what infrastructure monitoring is
 * actually for, and none of it was reachable.
 *
 * Findings are written to the case, so they inherit the provenance the schema
 * already requires — source, query term, query kind, observed-at — and land in
 * the same table the report builder reads.
 */

/**
 * One row per observation would be hundreds of thousands of rows for a busy
 * domain, and nothing reads them individually. One row per source per run
 * keeps the payload intact while staying countable.
 */
export async function persistRun(
  caseId: string,
  subject: Subject,
  results: RunResultRow[],
  operator: string,
): Promise<number> {
  const observedAt = new Date();

  const rows = results
    .filter((result) => result.status === "ok" && result.data.length > 0)
    .map((result) => ({
      caseId,
      sourceId: result.sourceId,
      tier: toPrismaTier(result.tier as never),
      title: `${result.name}: ${result.count} observation${result.count === 1 ? "" : "s"}`,
      summary: result.message,
      data: jsonSafe({ observations: result.data }) as object,
      queryTerm: subject.value,
      queryKind: toPrismaSubjectKind(subject.kind),
      observedAt,
      savedBy: operator,
    }));

  if (rows.length === 0) return 0;

  await prisma.finding.createMany({ data: rows });
  return rows.length;
}

/** Every value a stored run reported, flattened for comparison. */
function valuesOf(data: unknown): Set<string> {
  const values = new Set<string>();
  const payload = data as { observations?: unknown };
  const observations = Array.isArray(payload?.observations)
    ? payload.observations
    : [];

  for (const raw of observations) {
    if (typeof raw !== "object" || raw === null) continue;
    const observation = raw as Record<string, unknown>;

    // The identifying field differs per kind, which is why this reads several
    // rather than assuming one shape.
    const value =
      observation["hostname"] ??
      observation["ip"] ??
      observation["commonName"] ??
      observation["url"] ??
      observation["name"] ??
      observation["value"] ??
      observation["title"];

    if (typeof value === "string" && value.trim().length > 0) {
      values.add(value.trim().toLowerCase());
    }
  }

  return values;
}

export async function registerHistoryRoutes(
  app: FastifyInstance,
): Promise<void> {
  /** Previous runs for a subject, newest first. */
  app.get("/history", async (request) => {
    const query = z
      .object({
        caseId: z.string().min(1),
        term: z.string().trim().min(1).optional(),
        limit: z.coerce.number().int().positive().max(100).default(25),
      })
      .safeParse(request.query);

    if (!query.success) throw badRequest("caseId is required.");
    const { caseId, term, limit } = query.data;

    const findings = await prisma.finding.findMany({
      where: {
        caseId,
        ...(term === undefined ? {} : { queryTerm: term.toLowerCase() }),
      },
      orderBy: { observedAt: "desc" },
      take: limit * 20,
      select: {
        sourceId: true,
        queryTerm: true,
        queryKind: true,
        observedAt: true,
        title: true,
      },
    });

    // Group into runs. Everything written by one search shares an observedAt,
    // which is what makes a run identifiable without another table.
    const runs = new Map<
      string,
      { observedAt: Date; term: string; kind: string; sources: string[] }
    >();

    for (const finding of findings) {
      const key = `${finding.queryTerm}|${finding.observedAt.toISOString()}`;
      const existing = runs.get(key);
      if (existing === undefined) {
        runs.set(key, {
          observedAt: finding.observedAt,
          term: finding.queryTerm,
          kind: finding.queryKind,
          sources: [finding.sourceId],
        });
      } else {
        existing.sources.push(finding.sourceId);
      }
    }

    return {
      count: runs.size,
      runs: [...runs.values()]
        .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
        .slice(0, limit)
        .map((run) => ({
          observedAt: run.observedAt.toISOString(),
          term: run.term,
          kind: run.kind,
          sources: run.sources.length,
        })),
    };
  });

  /**
   * What changed between the two most recent runs of a term.
   *
   * The question a standing investigation actually asks. A list of everything
   * found is the same list every week; what is new, and what has disappeared,
   * is the finding.
   */
  app.get("/history/diff", async (request) => {
    const query = z
      .object({ caseId: z.string().min(1), term: z.string().trim().min(1) })
      .safeParse(request.query);

    if (!query.success) throw badRequest("caseId and term are required.");
    const { caseId, term } = query.data;

    const findings = await prisma.finding.findMany({
      where: { caseId, queryTerm: term.toLowerCase() },
      orderBy: { observedAt: "desc" },
      select: { observedAt: true, data: true },
    });

    const stamps = [
      ...new Set(findings.map((f) => f.observedAt.toISOString())),
    ].sort((a, b) => b.localeCompare(a));

    if (stamps.length < 2) {
      return {
        comparable: false,
        runs: stamps.length,
        message:
          stamps.length === 0
            ? "This term has not been searched in this investigation yet."
            : "Only one run so far. Search again to see what changed.",
      };
    }

    const [latest, previous] = stamps;

    const collect = (stamp: string): Set<string> => {
      const values = new Set<string>();
      for (const finding of findings) {
        if (finding.observedAt.toISOString() !== stamp) continue;
        for (const value of valuesOf(finding.data)) values.add(value);
      }
      return values;
    };

    const now = collect(latest as string);
    const before = collect(previous as string);

    const added = [...now].filter((value) => !before.has(value)).sort();
    const removed = [...before].filter((value) => !now.has(value)).sort();

    return {
      comparable: true,
      latest,
      previous,
      // Counts alongside the lists, because "42 new" is the headline and the
      // list is what you read next.
      added: { count: added.length, values: added.slice(0, 200) },
      removed: { count: removed.length, values: removed.slice(0, 200) },
      unchanged: now.size - added.length,
    };
  });
}
