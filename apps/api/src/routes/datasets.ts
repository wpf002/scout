import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DatasetObservation, ExtractedEntity } from "@scout/sources";
import {
  dedupeEntities,
  requiresScopeFor,
  subjectSchema,
} from "@scout/sources";
import { jsonSafe } from "@scout/db";
import type { DatasetAdapter } from "../adapters/datasets/index.js";
import {
  DATASET_ADAPTERS,
  getDatasetAdapter,
} from "../adapters/datasets/index.js";
import { executeSource } from "../adapters/base.js";
import { runSweep, sweepSourceReport } from "./sweep.js";
import { badRequest, notFound } from "../errors.js";
import { operatorOf } from "../auth.js";

const runSchema = z.object({
  caseId: z.string().min(1),
  subject: subjectSchema,
  /**
   * Required when the effective gate applies. Kept optional in the schema so
   * the handler can give a specific error naming why confirmation is needed,
   * rather than a generic validation failure.
   */
  confirm: z.literal(true).optional(),
});

const sweepSchema = z.object({
  caseId: z.string().min(1),
  subject: subjectSchema,
  sourceIds: z.array(z.string().min(1)).nonempty().optional(),
  /** A sweep issues several outbound calls, so it is an explicit action. */
  confirm: z.literal(true, {
    errorMap: () => ({
      message: "confirm must be true — a sweep issues several outbound calls.",
    }),
  }),
});

export async function registerDatasetRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /datasets/:sourceId — run one dataset source.
   *
   * There is deliberately no sweep here. Dataset sources are not uniformly
   * non-scoped — Intelligence X is gated for email selectors — so batching
   * them would mean reasoning about per-subject-kind gating inside a fan-out.
   * One at a time, dispatched by `executeSource`.
   */
  app.post<{ Params: { sourceId: string } }>(
    "/datasets/:sourceId",
    async (request) => {
      const body = runSchema.parse(request.body);
      const adapter = getDatasetAdapter(request.params.sourceId);
      if (adapter === undefined) {
        throw notFound(`No dataset adapter for "${request.params.sourceId}".`);
      }

      if (!adapter.source.accepts.includes(body.subject.kind)) {
        throw badRequest(
          `${adapter.source.name} accepts ${adapter.source.accepts.join(" or ")} subjects, not ${body.subject.kind}.`,
        );
      }

      const gated = requiresScopeFor(adapter.source, body.subject.kind);

      // A gated query is a person-facing action and takes the same explicit
      // confirmation as the exposure tier — one confirmed subject at a time.
      if (gated && body.confirm !== true) {
        throw badRequest(
          `${adapter.source.name} is scope-gated for a ${body.subject.kind} subject. ` +
            "Set confirm: true to run it for this one subject.",
        );
      }

      const result = await executeSource(
        adapter.source,
        {
          caseId: body.caseId,
          subject: body.subject,
          operator: operatorOf(request),
        },
        adapter.run,
      );

      const observations: DatasetObservation[] =
        result.status === "ok" ? ((result.data ?? []) as DatasetObservation[]) : [];

      // Candidate entities for the investigator to accept as subjects.
      // Suggestions only — nothing is linked into the case automatically.
      const suggestedSubjects: ExtractedEntity[] = dedupeEntities(
        observations.flatMap((observation) => observation.entities),
      );

      const sanctioned = observations.filter(
        (o) => o.kind === "sanction-match" && o.sanctioned,
      ).length;

      return jsonSafe({
        ...result,
        scopeGated: gated,
        observations,
        totals: {
          observations: observations.length,
          sanctioned,
          suggestedSubjects: suggestedSubjects.length,
        },
        suggestedSubjects,
      });
    },
  );

  /**
   * POST /datasets/sweep — batch the dataset sources that are ungated for
   * this subject kind.
   *
   * Invariant 2 permits batching non-scoped dataset sources on an explicit
   * action, and this is that. The safety comes from `runSweep`, which filters
   * on the effective per-subject-kind gate: a `person` sweep runs
   * OpenSanctions and excludes nothing; an `email` sweep excludes Intelligence
   * X, because for that input it is a person-facing lookup.
   *
   * Exclusions are reported, never silently dropped. A sweep that quietly
   * omitted a gated source would read as "covered everything" — and an
   * investigator would take the absence of a hit as evidence, when it was
   * really a refusal.
   */
  app.post("/datasets/sweep", async (request) => {
    const body = sweepSchema.parse(request.body);

    let adapters: readonly DatasetAdapter[] = DATASET_ADAPTERS;
    if (body.sourceIds !== undefined) {
      const unknown = body.sourceIds.filter(
        (id) => getDatasetAdapter(id) === undefined,
      );
      if (unknown.length > 0) {
        throw badRequest(`No dataset adapter for: ${unknown.join(", ")}.`);
      }
      const wanted = new Set(body.sourceIds);
      adapters = adapters.filter((a) => wanted.has(a.source.id));
    }

    const outcome = await runSweep(adapters, body.subject, body.caseId, operatorOf(request));

    const observations = outcome.ran.flatMap(({ adapter, result }) =>
      (result.status === "ok" ? (result.data ?? []) : []).map(
        (observation) => ({ sourceId: adapter.source.id, observation }),
      ),
    );

    const suggestedSubjects = dedupeEntities(
      observations.flatMap(({ observation }) => observation.entities),
    );

    const sanctioned = observations.filter(
      ({ observation }) =>
        observation.kind === "sanction-match" && observation.sanctioned,
    ).length;

    return jsonSafe({
      subject: body.subject,
      caseId: body.caseId,
      sources: sweepSourceReport(outcome),
      excluded: outcome.excluded,
      totals: {
        observations: observations.length,
        sanctioned,
        suggestedSubjects: suggestedSubjects.length,
      },
      observations,
      suggestedSubjects,
    });
  });

  /** GET /datasets/adapters — which dataset adapters are built. */
  app.get("/datasets/adapters", async () => ({
    count: DATASET_ADAPTERS.length,
    adapters: DATASET_ADAPTERS.map((adapter) => ({
      sourceId: adapter.source.id,
      name: adapter.source.name,
      accepts: adapter.source.accepts,
      keyEnv: adapter.source.keyEnv,
      requiresScope: adapter.source.requiresScope,
      /** Kinds that trigger the gate even though the source is not scoped. */
      scopedKinds: adapter.source.scopedKinds ?? [],
    })),
  }));
}
