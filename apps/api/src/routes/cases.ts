import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSource, subjectKindSchema } from "@scout/sources";
import { scopeKindSchema } from "@scout/scope";
import {
  jsonSafe,
  prisma,
  recordAuditEvent,
  toPrismaScopeKind,
  toPrismaSubjectKind,
  toPrismaTier,
} from "@scout/db";
import type { Prisma } from "@scout/db";
import { badRequest, notFound } from "../errors.js";
import { operatorOf } from "../auth.js";

const scopeEntryInput = z.object({
  kind: scopeKindSchema,
  value: z.string().trim().min(1).max(253),
  note: z.string().trim().max(500).optional(),
});

const createCaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * Non-negotiable at creation. A case with no authorization reference can
   * never run a scoped source, so there is no reason to allow one to exist.
   */
  authorizationRef: z.string().trim().min(1).max(500),
  notes: z.string().trim().max(5000).optional(),
  scope: z.array(scopeEntryInput).max(200).optional(),
});

const addScopeSchema = scopeEntryInput.extend({
  /**
   * Widening scope is an authorization decision, not a settings tweak. The
   * caller has to say so explicitly, and the claim is written to the audit log.
   */
  confirmAuthorized: z.literal(true, {
    errorMap: () => ({
      message:
        "confirmAuthorized must be true — adding scope asserts you are authorized for this target.",
    }),
  }),
});

const createSubjectSchema = z.object({
  kind: subjectKindSchema,
  value: z.string().trim().min(1).max(512),
  label: z.string().trim().max(200).optional(),
});

const createFindingSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(5000).optional(),
  data: z.unknown().optional(),
  subjectId: z.string().min(1).optional(),
  // ── provenance, all required ──
  queryTerm: z.string().trim().min(1).max(512),
  queryKind: subjectKindSchema,
  observedAt: z.coerce.date().optional(),
  queryLogId: z.string().min(1).optional(),
});

async function requireCase(caseId: string) {
  const record = await prisma.case.findUnique({
    where: { id: caseId },
    include: { scopeEntries: { orderBy: { createdAt: "asc" } } },
  });
  if (record === null) throw notFound(`Case ${caseId} does not exist.`);
  return record;
}

export async function registerCaseRoutes(app: FastifyInstance): Promise<void> {
  app.post("/cases", async (request, reply) => {
    const body = createCaseSchema.parse(request.body);

    const created = await prisma.case.create({
      data: {
        name: body.name,
        authorizationRef: body.authorizationRef,
        notes: body.notes ?? null,
        createdBy: operatorOf(request),
        scopeEntries: {
          create: (body.scope ?? []).map((entry) => ({
            kind: toPrismaScopeKind(entry.kind),
            value: entry.value,
            note: entry.note ?? null,
            addedBy: operatorOf(request),
          })),
        },
      },
      include: { scopeEntries: true },
    });

    await recordAuditEvent({
      caseId: created.id,
      action: "case.created",
      actor: operatorOf(request),
      detail: {
        name: created.name,
        authorizationRef: created.authorizationRef,
        scopeEntryCount: created.scopeEntries.length,
      },
    });

    return reply.status(201).send(created);
  });

  app.get<{ Querystring: { includeArchived?: string } }>(
    "/cases",
    async (request) => {
    const includeArchived = request.query.includeArchived === "true";
    const cases = await prisma.case.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { createdAt: "desc" },
      include: {
        scopeEntries: true,
        _count: { select: { subjects: true, findings: true, queryLogs: true } },
      },
    });
    return { count: cases.length, cases };
  },
  );

  app.get<{ Params: { id: string } }>("/cases/:id", async (request) => {
    return requireCase(request.params.id);
  });

  app.patch<{ Params: { id: string } }>("/cases/:id", async (request) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        notes: z.string().trim().max(5000).optional(),
        status: z.enum(["ACTIVE", "CLOSED"]).optional(),
      })
      .parse(request.body);

    await requireCase(request.params.id);

    const updated = await prisma.case.update({
      where: { id: request.params.id },
      data: body,
      include: { scopeEntries: true },
    });

    if (body.status !== undefined) {
      await recordAuditEvent({
        caseId: updated.id,
        action: `case.${body.status.toLowerCase()}`,
        actor: operatorOf(request),
        detail: { status: body.status },
      });
    }

    return updated;
  });

  // ── scope ──────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/cases/:id/scope",
    async (request, reply) => {
      const body = addScopeSchema.parse(request.body);
      const record = await requireCase(request.params.id);

      const existing = await prisma.scopeEntry.findUnique({
        where: {
          caseId_kind_value: {
            caseId: record.id,
            kind: toPrismaScopeKind(body.kind),
            value: body.value,
          },
        },
      });
      if (existing !== null) {
        throw badRequest(
          `${body.kind} "${body.value}" is already in scope for this case.`,
        );
      }

      const entry = await prisma.scopeEntry.create({
        data: {
          caseId: record.id,
          kind: toPrismaScopeKind(body.kind),
          value: body.value,
          note: body.note ?? null,
          addedBy: operatorOf(request),
        },
      });

      await recordAuditEvent({
        caseId: record.id,
        action: "scope.added",
        actor: operatorOf(request),
        detail: {
          scopeEntryId: entry.id,
          kind: body.kind,
          value: body.value,
          authorizationRef: record.authorizationRef,
          confirmedAuthorized: true,
        },
      });

      return reply.status(201).send(entry);
    },
  );

  app.delete<{ Params: { id: string; entryId: string } }>(
    "/cases/:id/scope/:entryId",
    async (request, reply) => {
      const record = await requireCase(request.params.id);
      const entry = await prisma.scopeEntry.findFirst({
        where: { id: request.params.entryId, caseId: record.id },
      });
      if (entry === null) throw notFound("Scope entry does not exist.");

      await prisma.scopeEntry.delete({ where: { id: entry.id } });
      await recordAuditEvent({
        caseId: record.id,
        action: "scope.removed",
        actor: operatorOf(request),
        detail: { scopeEntryId: entry.id, kind: entry.kind, value: entry.value },
      });

      return reply.status(204).send();
    },
  );

  // ── subjects ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/cases/:id/subjects",
    async (request, reply) => {
      const body = createSubjectSchema.parse(request.body);
      const record = await requireCase(request.params.id);

      const subject = await prisma.subject.upsert({
        where: {
          caseId_kind_value: {
            caseId: record.id,
            kind: toPrismaSubjectKind(body.kind),
            value: body.value,
          },
        },
        create: {
          caseId: record.id,
          kind: toPrismaSubjectKind(body.kind),
          value: body.value,
          label: body.label ?? null,
        },
        update: { label: body.label ?? null },
      });

      return reply.status(201).send(subject);
    },
  );

  app.get<{ Params: { id: string } }>("/cases/:id/subjects", async (request) => {
    const record = await requireCase(request.params.id);
    const subjects = await prisma.subject.findMany({
      where: { caseId: record.id },
      orderBy: { createdAt: "asc" },
    });
    return { count: subjects.length, subjects };
  });

  // ── findings ───────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/cases/:id/findings",
    async (request, reply) => {
      const body = createFindingSchema.parse(request.body);
      const record = await requireCase(request.params.id);

      // The tier comes from the registry, not the request. A finding cannot
      // claim a source that does not exist, and cannot misfile its own tier.
      const source = getSource(body.sourceId);
      if (source === undefined) {
        throw badRequest(`Unknown source "${body.sourceId}".`);
      }

      if (body.subjectId !== undefined) {
        const subject = await prisma.subject.findFirst({
          where: { id: body.subjectId, caseId: record.id },
        });
        if (subject === null) {
          throw badRequest("subjectId does not belong to this case.");
        }
      }

      if (body.queryLogId !== undefined) {
        const log = await prisma.queryLog.findFirst({
          where: { id: body.queryLogId, caseId: record.id },
        });
        if (log === null) {
          throw badRequest("queryLogId does not belong to this case.");
        }
      }

      const finding = await prisma.finding.create({
        data: {
          caseId: record.id,
          subjectId: body.subjectId ?? null,
          sourceId: source.id,
          tier: toPrismaTier(source.tier),
          title: body.title,
          summary: body.summary ?? null,
          data: (jsonSafe(body.data ?? {}) ?? {}) as Prisma.InputJsonValue,
          queryTerm: body.queryTerm,
          queryKind: toPrismaSubjectKind(body.queryKind),
          observedAt: body.observedAt ?? new Date(),
          queryLogId: body.queryLogId ?? null,
          savedBy: operatorOf(request),
        },
      });

      return reply.status(201).send(finding);
    },
  );

  app.get<{ Params: { id: string } }>("/cases/:id/findings", async (request) => {
    const record = await requireCase(request.params.id);
    const findings = await prisma.finding.findMany({
      where: { caseId: record.id },
      orderBy: { createdAt: "desc" },
      include: { subject: true },
    });
    return { count: findings.length, findings };
  });

  /**
   * GET /cases/:id/timeline — the case as a sequence of events.
   *
   * Separate from the report on purpose. The report's timeline arrives via an
   * export, and an export is an audited act; looking at your own case's
   * chronology is not, and should not have to masquerade as one.
   */
  app.get<{ Params: { id: string } }>("/cases/:id/timeline", async (request) => {
    const record = await requireCase(request.params.id);
    const [queryLogs, findings, events] = await Promise.all([
      prisma.queryLog.findMany({
        where: { caseId: record.id },
        orderBy: { createdAt: "asc" },
        take: 1000,
      }),
      prisma.finding.findMany({
        where: { caseId: record.id },
        orderBy: { observedAt: "asc" },
      }),
      prisma.auditEvent.findMany({
        where: { caseId: record.id },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const timeline = [
      ...queryLogs.map((log) => ({
        at: log.createdAt.toISOString(),
        kind: "query" as const,
        outcome: log.outcome as string | null,
        sourceId: log.sourceId as string | null,
        label: `${log.phase} ${log.sourceId}`,
        detail:
          log.outcome === "DENIED"
            ? `refused (${log.reason})`
            : `${log.subjectKind.toLowerCase()} ${log.subjectValue}`,
        operator: log.operator,
      })),
      ...findings.map((finding) => ({
        at: finding.observedAt.toISOString(),
        kind: "finding" as const,
        outcome: null,
        sourceId: finding.sourceId as string | null,
        label: "Finding saved",
        detail: finding.title,
        operator: finding.savedBy,
      })),
      ...events.map((event) => ({
        at: event.createdAt.toISOString(),
        kind: "event" as const,
        outcome: null,
        sourceId: null,
        label: event.action,
        detail: "",
        operator: event.actor,
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    return { caseId: record.id, count: timeline.length, timeline };
  });

  // ── audit ──────────────────────────────────────────────────────────────
  /**
   * The accountability view: every scoped query attempt under this case, plus
   * the scope changes that authorized them. Read-only by construction — there
   * is no route that edits a QueryLog, and the database rejects it too.
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/cases/:id/audit",
    async (request) => {
      const record = await requireCase(request.params.id);
      const limit = Math.min(
        Number.parseInt(request.query.limit ?? "200", 10) || 200,
        1000,
      );

      const [queryLogs, events, denialCount] = await Promise.all([
        prisma.queryLog.findMany({
          where: { caseId: record.id },
          orderBy: { createdAt: "desc" },
          take: limit,
        }),
        prisma.auditEvent.findMany({
          where: { caseId: record.id },
          orderBy: { createdAt: "desc" },
          take: limit,
        }),
        prisma.queryLog.count({
          where: { caseId: record.id, outcome: "DENIED" },
        }),
      ]);

      return {
        caseId: record.id,
        authorizationRef: record.authorizationRef,
        totals: { returned: queryLogs.length, denied: denialCount },
        queryLogs,
        events,
      };
    },
  );
}
