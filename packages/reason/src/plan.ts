import { z } from "zod";

/**
 * A query plan is a typed object: a short list of pre-authorized graph
 * operations with parameters. It is the only thing a planner (rule-based or
 * a model) is allowed to produce. There is no operation that takes query
 * text, so nothing a model emits can reach the database as SQL; it selects
 * and parameterises, the executor runs.
 *
 * A step can name an entity two ways: by id, or by reference to a match an
 * earlier `find-entity` step produced. The reference is how a plan built
 * from a question that says "Ingrid Eriksen" gets to an entity id without
 * the planner ever seeing the graph.
 */

export const MAX_STEPS = 6;
export const MAX_NEIGHBOR_HOPS = 3;
export const MAX_PATH_HOPS = 6;
/** The whole plan's cost, in the units `stepCost` assigns. */
export const MAX_COST = 12;

export const entityRefSchema = z.union([
  z.object({ entityId: z.string().min(1) }),
  z.object({ ref: z.string().min(1), index: z.number().int().min(0).default(0) }),
]);
export type EntityRef = z.infer<typeof entityRefSchema>;

const stepId = z.string().regex(/^s\d+$/, "step ids are s1, s2, …");

export const stepSchema = z.discriminatedUnion("op", [
  z.object({
    id: stepId,
    op: z.literal("find-entity"),
    text: z.string().trim().min(1).max(200),
    kind: z.string().optional(),
    limit: z.number().int().min(1).max(10).default(3),
  }),
  z.object({
    id: stepId,
    op: z.literal("neighbors-of"),
    entity: entityRefSchema,
    hops: z.number().int().min(1).max(MAX_NEIGHBOR_HOPS).default(1),
    asOf: z.coerce.date().optional(),
  }),
  z.object({
    id: stepId,
    op: z.literal("path-between"),
    from: entityRefSchema,
    to: entityRefSchema,
    maxHops: z.number().int().min(1).max(MAX_PATH_HOPS).default(4),
    asOf: z.coerce.date().optional(),
  }),
  z.object({
    id: stepId,
    op: z.literal("co-location-window"),
    entity: entityRefSchema,
    from: z.coerce.date(),
    to: z.coerce.date(),
  }),
  z.object({
    id: stepId,
    op: z.literal("timeline-for-entity"),
    entity: entityRefSchema,
    asOf: z.coerce.date().optional(),
  }),
  z.object({
    id: stepId,
    op: z.literal("sources-consulted"),
  }),
]);
export type Step = z.infer<typeof stepSchema>;
export type Operation = Step["op"];
export const OPERATIONS: readonly Operation[] = ["find-entity", "neighbors-of", "path-between", "co-location-window", "timeline-for-entity", "sources-consulted"];

export const planSchema = z.object({
  steps: z.array(stepSchema).min(1).max(MAX_STEPS),
});
export type QueryPlan = z.infer<typeof planSchema>;

/** What a step costs against the budget: hops are the expensive thing. */
export function stepCost(step: Step): number {
  switch (step.op) {
    case "find-entity":
      return 1;
    case "neighbors-of":
      return 1 + step.hops;
    case "path-between":
      return step.maxHops;
    case "co-location-window":
      return 2;
    case "timeline-for-entity":
      return 1;
    case "sources-consulted":
      return 1;
  }
}

export function planCost(plan: QueryPlan): number {
  return plan.steps.reduce((sum, step) => sum + stepCost(step), 0);
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * Parse and check a plan: the schema, unique step ids, every reference
 * pointing at an earlier `find-entity` step, the cost budget, and a window
 * that runs forwards. Throws PlanError with the exact problem; a planner's
 * output that fails here is refused, not repaired.
 */
export function validatePlan(input: unknown): QueryPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) {
    throw new PlanError(`Not a valid plan: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const plan = parsed.data;
  const finds = new Set<string>();
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) throw new PlanError(`Step id ${step.id} is used twice.`);
    ids.add(step.id);
    for (const ref of refsOf(step)) {
      if ("ref" in ref && !finds.has(ref.ref)) {
        throw new PlanError(`Step ${step.id} refers to ${ref.ref}, which is not an earlier find-entity step.`);
      }
    }
    if (step.op === "co-location-window" && step.to <= step.from) {
      throw new PlanError(`Step ${step.id}: the window ends before it starts.`);
    }
    if (step.op === "find-entity") finds.add(step.id);
  }
  const cost = planCost(plan);
  if (cost > MAX_COST) throw new PlanError(`The plan costs ${cost}; the budget is ${MAX_COST}. Fewer hops, or fewer steps.`);
  return plan;
}

export function refsOf(step: Step): EntityRef[] {
  switch (step.op) {
    case "neighbors-of":
    case "co-location-window":
    case "timeline-for-entity":
      return [step.entity];
    case "path-between":
      return [step.from, step.to];
    default:
      return [];
  }
}
