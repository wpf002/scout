import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, recordAuditEvent } from "@scout/db";
import { operatorOf } from "../auth.js";
import { logEvent } from "../observability.js";
import { notFound } from "../errors.js";

const purgeSchema = z.object({
  /**
   * Purging destroys investigative content. It is not undoable, so it is not
   * something a mis-click should do.
   */
  confirm: z.literal(true, {
    errorMap: () => ({
      message:
        "confirm must be true — purging permanently deletes this case's findings and subjects.",
    }),
  }),
  reason: z.string().trim().min(1).max(500),
});

async function requireCase(caseId: string) {
  const record = await prisma.case.findUnique({ where: { id: caseId } });
  if (record === null) throw notFound(`Case ${caseId} does not exist.`);
  return record;
}

/**
 * Retention: the Phase 1 defer, now built.
 *
 * The shape is forced by a decision made in Phase 1 — audit rows are immutable
 * at the database level, so a case cannot be deleted. That looked like a
 * limitation; it is actually the right retention model. Data minimization
 * should remove what was *collected about people*, not the record of what was
 * *done to them*. So:
 *
 *   archive — hide a finished case from the working list. Reversible.
 *   purge   — delete the findings and subjects. Irreversible, and the case
 *             shell plus its full audit trail survive.
 *
 * A tool that could erase its own audit trail on request would not be worth
 * the accountability claims made elsewhere in this codebase.
 */
export async function registerRetentionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post<{ Params: { id: string } }>(
    "/cases/:id/archive",
    async (request) => {
      const record = await requireCase(request.params.id);
      if (record.archivedAt !== null) return record;

      const updated = await prisma.case.update({
        where: { id: record.id },
        data: { archivedAt: new Date(), status: "CLOSED" },
      });
      await recordAuditEvent({
        caseId: record.id,
        action: "case.archived",
        actor: operatorOf(request),
        detail: { archivedAt: updated.archivedAt },
      });
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/cases/:id/restore",
    async (request) => {
      const record = await requireCase(request.params.id);
      const updated = await prisma.case.update({
        where: { id: record.id },
        data: { archivedAt: null, status: "ACTIVE" },
      });
      await recordAuditEvent({
        caseId: record.id,
        action: "case.restored",
        actor: operatorOf(request),
        detail: {},
      });
      return updated;
    },
  );

  /**
   * POST /cases/:id/purge — delete the investigative content, keep the record.
   *
   * Findings and subjects go. The case, its scope entries and every audit row
   * stay. `reason` is required and recorded: a purge is a decision someone
   * made, and a year later the only way to know why is if they wrote it down.
   */
  app.post<{ Params: { id: string } }>("/cases/:id/purge", async (request) => {
    const body = purgeSchema.parse(request.body);
    const record = await requireCase(request.params.id);

    const [findings, subjects] = await Promise.all([
      prisma.finding.count({ where: { caseId: record.id } }),
      prisma.subject.count({ where: { caseId: record.id } }),
    ]);

    await prisma.$transaction([
      prisma.finding.deleteMany({ where: { caseId: record.id } }),
      prisma.subject.deleteMany({ where: { caseId: record.id } }),
      prisma.case.update({
        where: { id: record.id },
        data: { purgedAt: new Date(), notes: null },
      }),
    ]);

    await recordAuditEvent({
      caseId: record.id,
      action: "case.purged",
      actor: operatorOf(request),
      detail: { findings, subjects, reason: body.reason },
    });
    logEvent(request.log, "case.purged", {
      caseId: record.id,
      findings,
      subjects,
    });

    const auditRows = await prisma.queryLog.count({
      where: { caseId: record.id },
    });

    return {
      caseId: record.id,
      purged: { findings, subjects },
      // Stated back explicitly so nobody assumes a purge erased the trail.
      retained: {
        auditRows,
        note: "The audit trail and scope entries are retained. They are immutable by design.",
      },
    };
  });
}
