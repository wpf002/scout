import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema } from "@scout/sources";
import { jsonSafe } from "@scout/db";
import {
  SCOPED_ADAPTERS,
  getScopedAdapter,
} from "../adapters/scoped/index.js";
import { executeScopedSource } from "../adapters/base.js";
import { credentialMaterialAllowed } from "../adapters/scoped/dehashed.js";
import { badRequest, notFound } from "../errors.js";
import { config } from "../config.js";

const executeSchema = z.object({
  /** Required. A scoped source has no meaning outside a case. */
  caseId: z.string().min(1),
  subject: subjectSchema,
  /**
   * One confirmed action at a time. There is no array here and no batch
   * variant for this tier, and there must never be one (locked invariant 2).
   */
  confirm: z.literal(true, {
    errorMap: () => ({
      message:
        "confirm must be true — running a scoped source is an explicit, per-subject action.",
    }),
  }),
});

export async function registerScopedRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * One handler for every person-facing source, registered per tier so the
   * URL says what kind of lookup it is: `/exposure/hibp`, `/people/hunter-io`.
   *
   * A single handler means a single place the gate is applied. Four bespoke
   * routes would have been four chances to apply it slightly differently, and
   * the one that drifts is the one that leaks.
   */
  for (const tier of ["exposure", "people"] as const) {
    app.post<{ Params: { sourceId: string } }>(
      `/${tier}/:sourceId`,
      async (request) => {
        const body = executeSchema.parse(request.body);
        const adapter = getScopedAdapter(request.params.sourceId);

        if (adapter === undefined || adapter.source.tier !== tier) {
          throw notFound(
            `No ${tier} adapter for "${request.params.sourceId}".`,
          );
        }

        if (!adapter.source.accepts.includes(body.subject.kind)) {
          throw badRequest(
            `${adapter.source.name} accepts ${adapter.source.accepts.join(" or ")} subjects, not ${body.subject.kind}.`,
          );
        }

        // executeScopedSource enforces the gate and writes the audit row
        // before adapter.run becomes reachable.
        const result = await executeScopedSource(
          adapter.source,
          {
            caseId: body.caseId,
            subject: body.subject,
            operator: config.SCOUT_OPERATOR,
          },
          adapter.run,
        );

        const observations = result.status === "ok" ? (result.data ?? []) : [];

        return jsonSafe({
          ...result,
          observations,
          totals: { observations: observations.length },
          // Surfaced so an investigator can tell a redacted result from an
          // empty one, rather than assuming no credential material existed.
          ...(adapter.source.id === "dehashed"
            ? { credentialMaterialIncluded: credentialMaterialAllowed() }
            : {}),
        });
      },
    );
  }

  /** GET /scoped/adapters — the person-facing sources that are built. */
  app.get("/scoped/adapters", async () => ({
    count: SCOPED_ADAPTERS.length,
    adapters: SCOPED_ADAPTERS.map((adapter) => ({
      sourceId: adapter.source.id,
      name: adapter.source.name,
      tier: adapter.source.tier,
      accepts: adapter.source.accepts,
      keyEnv: adapter.source.keyEnv,
      requiresScope: adapter.source.requiresScope,
    })),
  }));
}
