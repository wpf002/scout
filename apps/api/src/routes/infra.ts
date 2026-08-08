import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { InfraObservation, SourceResult } from "@scout/sources";
import { mergeObservations, subjectSchema } from "@scout/sources";
import { jsonSafe } from "@scout/db";
import {
  getInfraAdapter,
  infraAdaptersFor,
  INFRA_ADAPTERS,
} from "../adapters/infra/index.js";
import { executeUnscopedSource } from "../adapters/base.js";
import { badRequest, notFound } from "../errors.js";
import { config } from "../config.js";

const singleSchema = z.object({
  caseId: z.string().min(1),
  subject: subjectSchema,
});

const sweepSchema = z.object({
  caseId: z.string().min(1),
  subject: subjectSchema,
  /** Optional narrowing. Omitted means every infra source for this kind. */
  sourceIds: z.array(z.string().min(1)).nonempty().optional(),
  /**
   * Batch execution of non-scoped sources is permitted, but only as an
   * explicit action (locked invariant 2). There is no sweep for scoped
   * sources and there must never be one.
   */
  confirm: z.literal(true, {
    errorMap: () => ({
      message: "confirm must be true — a sweep issues several outbound calls.",
    }),
  }),
});

export async function registerInfraRoutes(
  app: FastifyInstance,
): Promise<void> {
  /** POST /infra/:sourceId — run one infrastructure source. */
  app.post<{ Params: { sourceId: string } }>(
    "/infra/:sourceId",
    async (request) => {
      const body = singleSchema.parse(request.body);
      const adapter = getInfraAdapter(request.params.sourceId);
      if (adapter === undefined) {
        throw notFound(
          `No infrastructure adapter for "${request.params.sourceId}".`,
        );
      }

      if (!adapter.source.accepts.includes(body.subject.kind)) {
        throw badRequest(
          `${adapter.source.name} accepts ${adapter.source.accepts.join(" or ")} subjects, not ${body.subject.kind}.`,
        );
      }

      const result = await executeUnscopedSource(
        adapter.source,
        {
          caseId: body.caseId,
          subject: body.subject,
          operator: config.SCOUT_OPERATOR,
        },
        adapter.run,
      );

      return jsonSafe({
        ...result,
        observations: result.status === "ok" ? result.data : [],
      });
    },
  );

  /**
   * POST /infra/sweep — run several infrastructure sources at once and merge
   * their output.
   *
   * This is the batch path invariant 2 explicitly permits for non-scoped
   * sources. It draws only from INFRA_ADAPTERS, every member of which is
   * non-scoped, and it re-checks that before running anything: a sweep must
   * never become a way to fan a subject out across person-facing sources.
   */
  app.post("/infra/sweep", async (request) => {
    const body = sweepSchema.parse(request.body);

    let adapters = infraAdaptersFor(body.subject);
    if (body.sourceIds !== undefined) {
      const wanted = new Set(body.sourceIds);
      const unknown = body.sourceIds.filter(
        (id) => getInfraAdapter(id) === undefined,
      );
      if (unknown.length > 0) {
        throw badRequest(
          `No infrastructure adapter for: ${unknown.join(", ")}.`,
        );
      }
      adapters = adapters.filter((a) => wanted.has(a.source.id));
    }

    // Belt and braces. INFRA_ADAPTERS is asserted non-scoped by its own test;
    // this makes a regression fail the request rather than leak a lookup.
    const scoped = adapters.filter((a) => a.source.requiresScope);
    if (scoped.length > 0) {
      throw badRequest(
        `Refusing to sweep scoped sources: ${scoped.map((a) => a.source.id).join(", ")}. ` +
          "Person-facing sources run one confirmed subject at a time.",
      );
    }

    if (adapters.length === 0) {
      throw badRequest(
        `No infrastructure source accepts a ${body.subject.kind} subject.`,
      );
    }

    const settled = await Promise.all(
      adapters.map(async (adapter) => {
        const result = await executeUnscopedSource(
          adapter.source,
          {
            caseId: body.caseId,
            subject: body.subject,
            operator: config.SCOUT_OPERATOR,
          },
          adapter.run,
        );
        return { adapter, result: result as SourceResult<InfraObservation[]> };
      }),
    );

    // One board, not four source-shaped silos. Attribution is a union, so a
    // hostname seen by both crt.sh and SecurityTrails names both.
    const merged = mergeObservations(
      settled.flatMap(({ adapter, result }) =>
        (result.status === "ok" ? (result.data ?? []) : []).map(
          (observation) => ({ sourceId: adapter.source.id, observation }),
        ),
      ),
    );

    const counts = {
      subdomain: merged.filter((m) => m.observation.kind === "subdomain").length,
      host: merged.filter((m) => m.observation.kind === "host").length,
      cert: merged.filter((m) => m.observation.kind === "cert").length,
    };

    return jsonSafe({
      subject: body.subject,
      caseId: body.caseId,
      sources: settled.map(({ adapter, result }) => ({
        sourceId: adapter.source.id,
        name: adapter.source.name,
        status: result.status,
        reason: result.reason ?? null,
        message: result.message ?? null,
        observationCount:
          result.status === "ok" ? (result.data ?? []).length : 0,
        queryLogId: result.provenance.queryLogId ?? null,
      })),
      totals: {
        rawObservations: settled.reduce(
          (sum, { result }) =>
            sum + (result.status === "ok" ? (result.data ?? []).length : 0),
          0,
        ),
        merged: merged.length,
        ...counts,
      },
      observations: merged,
    });
  });

  /** GET /infra/adapters — what the infra tier can actually run. */
  app.get("/infra/adapters", async () => ({
    count: INFRA_ADAPTERS.length,
    adapters: INFRA_ADAPTERS.map((adapter) => ({
      sourceId: adapter.source.id,
      name: adapter.source.name,
      accepts: adapter.source.accepts,
      keyEnv: adapter.source.keyEnv,
      requiresScope: adapter.source.requiresScope,
    })),
  }));
}
