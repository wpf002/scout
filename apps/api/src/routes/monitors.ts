import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema } from "@scout/sources";
import { jsonSafe, prisma, recordAuditEvent, toPrismaSubjectKind } from "@scout/db";
import { assertMonitorable, runDueMonitors, runMonitor } from "../monitor/run.js";
import { assertArea, assertWatchableLayers } from "../monitor/geo.js";
import { operatorOf } from "../auth.js";
import { logEvent } from "../observability.js";
import { badRequest, notFound } from "../errors.js";

/**
 * A monitor watches one of two things, never both.
 *
 * An indicator monitor asks "has anything changed about this domain". A
 * geofence asks "has anything entered this box". They share every piece of
 * machinery below and differ only in where their observations come from, so
 * one schema covers both — with exactly one of `subject` and `area` required.
 */
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    subject: subjectSchema.optional(),
    sourceIds: z.array(z.string().min(1)).default([]),
    /** A geofence: the box to watch, and the live layers to watch inside it. */
    area: z
      .object({
        south: z.number(),
        west: z.number(),
        north: z.number(),
        east: z.number(),
      })
      .optional(),
    layerIds: z.array(z.string().min(1)).default([]),
    /**
     * Hourly at the fastest for an indicator, because each run is an upstream
     * call. A geofence reads layers the map has already cached, so it may run
     * every five minutes without costing anyone anything.
     */
    intervalMinutes: z.number().int().min(5).max(43_200).default(1440),
  })
  .refine(
    (value) => (value.subject === undefined) !== (value.area === undefined),
    "Give either a subject or an area, not both and not neither.",
  );

export async function registerMonitorRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /cases/:id/monitors — put a subject under a standing watch.
   *
   * The source list is validated against the effective per-subject-kind gate,
   * so a monitor that would recurringly re-run a person-facing lookup cannot
   * be created. That is the line this feature does not cross: watching a
   * domain's infrastructure is ordinary recon; watching a person on a timer is
   * standing surveillance, and the whole point of the confirmation step is
   * that nobody does that by accident.
   */
  app.post<{ Params: { id: string } }>(
    "/cases/:id/monitors",
    async (request, reply) => {
      const body = createSchema.parse(request.body);
      const record = await prisma.case.findUnique({
        where: { id: request.params.id },
      });
      if (record === null) throw notFound(`Case ${request.params.id} does not exist.`);

      const geofence = body.area !== undefined;

      if (geofence) {
        // Throws if the box is malformed or a layer has no fixed position.
        assertArea(body.area);
        assertWatchableLayers(body.layerIds);
      } else if (body.subject !== undefined) {
        // Throws with a specific reason if any source is gated for this kind.
        assertMonitorable(body.sourceIds, body.subject);
      }

      /*
       * A geofence still needs a subject kind and value in the row, because
       * the column is not nullable and every other part of the system reads
       * it. It gets the box as its value and `keyword` as its kind — the
       * least privileged kind there is, and the honest description of what a
       * bounding box is. Nothing dispatches on it for a geofence; `area`
       * being set is what decides the run path.
       */
      const monitor = await prisma.monitor.create({
        data: {
          caseId: record.id,
          name: body.name,
          subjectKind: geofence
            ? toPrismaSubjectKind("keyword")
            : toPrismaSubjectKind(body.subject!.kind),
          subjectValue: geofence
            ? `${body.area!.south},${body.area!.west},${body.area!.north},${body.area!.east}`
            : body.subject!.value,
          sourceIds: geofence ? [] : body.sourceIds,
          area: geofence ? body.area! : undefined,
          layerIds: geofence ? body.layerIds : [],
          intervalMinutes: body.intervalMinutes,
          createdBy: operatorOf(request),
        },
      });

      await recordAuditEvent({
        caseId: record.id,
        action: "monitor.created",
        actor: operatorOf(request),
        detail: {
          monitorId: monitor.id,
          kind: geofence ? "geofence" : "indicator",
          subjectKind: body.subject?.kind ?? null,
          sourceIds: body.sourceIds,
          area: body.area ?? null,
          layerIds: body.layerIds,
          intervalMinutes: body.intervalMinutes,
        },
      });

      return reply.status(201).send(monitor);
    },
  );

  app.get<{ Params: { id: string } }>("/cases/:id/monitors", async (request) => {
    const monitors = await prisma.monitor.findMany({
      where: { caseId: request.params.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { runs: true, changes: true } },
      },
    });
    return { count: monitors.length, monitors };
  });

  app.patch<{ Params: { id: string; monitorId: string } }>(
    "/cases/:id/monitors/:monitorId",
    async (request) => {
      const body = z
        .object({
          enabled: z.boolean().optional(),
          intervalMinutes: z.number().int().min(60).max(43_200).optional(),
          name: z.string().trim().min(1).max(200).optional(),
        })
        .parse(request.body);

      const existing = await prisma.monitor.findFirst({
        where: { id: request.params.monitorId, caseId: request.params.id },
      });
      if (existing === null) throw notFound("No such monitor on this case.");

      return prisma.monitor.update({
        where: { id: existing.id },
        data: body,
      });
    },
  );

  app.delete<{ Params: { id: string; monitorId: string } }>(
    "/cases/:id/monitors/:monitorId",
    async (request, reply) => {
      const existing = await prisma.monitor.findFirst({
        where: { id: request.params.monitorId, caseId: request.params.id },
      });
      if (existing === null) throw notFound("No such monitor on this case.");

      await prisma.monitor.delete({ where: { id: existing.id } });
      await recordAuditEvent({
        caseId: request.params.id,
        action: "monitor.deleted",
        actor: operatorOf(request),
        detail: { monitorId: existing.id, name: existing.name },
      });
      return reply.status(204).send();
    },
  );

  /** POST /cases/:id/monitors/:monitorId/run — run it now. */
  app.post<{ Params: { id: string; monitorId: string } }>(
    "/cases/:id/monitors/:monitorId/run",
    async (request) => {
      const existing = await prisma.monitor.findFirst({
        where: { id: request.params.monitorId, caseId: request.params.id },
      });
      if (existing === null) throw notFound("No such monitor on this case.");

      const result = await runMonitor(existing.id, operatorOf(request));
      if (result.added > 0 || result.removed > 0) {
        logEvent(request.log, "monitor.changed", {
          monitorId: existing.id,
          added: result.added,
          removed: result.removed,
        });
      }
      return jsonSafe(result);
    },
  );

  /**
   * POST /monitors/run-due — run every monitor whose interval has elapsed.
   *
   * The external seam. Point cron, a platform scheduled job, or an external
   * orchestrator at it; calling it more often than the intervals is harmless,
   * because nothing that is not due will run. The same sweep is also available
   * in-process — see `monitor/scheduler.ts` — and both call `runDueMonitors`,
   * so there is one definition of "due".
   */
  app.post("/monitors/run-due", async (request) =>
    jsonSafe(await runDueMonitors(operatorOf(request), Date.now())),
  );

  /**
   * GET /alerts — the feed.
   *
   * Unacknowledged changes across every case, newest first. This is the
   * surface an analyst opens in the morning, which is why it lives at the root
   * rather than under a case.
   */
  app.get<{ Querystring: { caseId?: string; includeAcknowledged?: string } }>(
    "/alerts",
    async (request) => {
      const includeAcknowledged =
        request.query.includeAcknowledged === "true";

      const changes = await prisma.monitorChange.findMany({
        where: {
          ...(request.query.caseId === undefined
            ? {}
            : { caseId: request.query.caseId }),
          ...(includeAcknowledged ? {} : { acknowledgedAt: null }),
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: {
          monitor: { select: { name: true, subjectValue: true, subjectKind: true } },
        },
      });

      const cases = await prisma.case.findMany({
        where: { id: { in: [...new Set(changes.map((c) => c.caseId))] } },
        select: { id: true, name: true },
      });
      const caseNames = new Map(cases.map((c) => [c.id, c.name]));

      return jsonSafe({
        count: changes.length,
        unacknowledged: changes.filter((c) => c.acknowledgedAt === null).length,
        alerts: changes.map((change) => ({
          ...change,
          caseName: caseNames.get(change.caseId) ?? null,
        })),
      });
    },
  );

  /** POST /alerts/acknowledge — how an alert stops being noise. */
  app.post("/alerts/acknowledge", async (request) => {
    const body = z
      .object({ ids: z.array(z.string().min(1)).nonempty().max(500) })
      .parse(request.body);

    const updated = await prisma.monitorChange.updateMany({
      where: { id: { in: body.ids }, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), acknowledgedBy: operatorOf(request) },
    });
    if (updated.count === 0) throw badRequest("No unacknowledged alerts matched.");
    return { acknowledged: updated.count };
  });
}
