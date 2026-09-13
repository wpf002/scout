import type { ScopeContext, SourceClass } from "@scout/scope";
import { sourceClassSchema } from "@scout/scope";
import { z } from "zod";
import type { ObservationInput } from "./types.js";

/**
 * A v2 collector.
 *
 * Scout already has two connector systems and both stay as they are: the
 * case-tier `Source` registry in @scout/sources, and the live-map `LayerDef`
 * list in apps/api/src/live. Neither writes provenanced observations. A
 * collector is the wrapper that does: it declares what the spec requires of a
 * connector (source class, licensing terms, rate limit, the scope it needs)
 * and turns a payload from either existing system into `ObservationInput`s.
 *
 * A collector that cannot state its licensing terms does not register.
 */

export const collectorDefinitionSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, "lowercase slug"),
  name: z.string().min(1),
  sourceClass: sourceClassSchema,
  /** Required, non-empty. "unknown" is not terms. */
  licensingTerms: z.string().trim().min(8),
  tosUrl: z.string().url().optional(),
  refreshCadenceSeconds: z.number().int().positive(),
  rateLimit: z.object({ perMinute: z.number().int().positive() }),
  spatialResolutionMeters: z.number().int().positive().optional(),
  temporalLagSeconds: z.number().int().nonnegative().optional(),
  /** Env var naming the credential. Never the credential. */
  credentialsRef: z.string().optional(),
});

export type CollectorDefinition = z.infer<typeof collectorDefinitionSchema>;

export interface CollectMeta {
  collectedAt: Date;
  authorizationId: string;
  caseId?: string;
}

export interface Collector extends CollectorDefinition {
  /** Pure. Turns one upstream payload into zero or more observations. */
  normalize(raw: unknown, meta: CollectMeta): ObservationInput[];
}

export class CollectorError extends Error {
  readonly statusCode = 500;
  constructor(message: string) {
    super(message);
    this.name = "CollectorError";
  }
}

/** Validates the declaration. The one place "no licence, no load" is enforced. */
export function defineCollector(
  definition: CollectorDefinition,
  normalize: Collector["normalize"],
): Collector {
  const parsed = collectorDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    const terms = parsed.error.issues.find((i) => i.path[0] === "licensingTerms");
    if (terms !== undefined) {
      throw new CollectorError(
        `Collector "${String(definition.id)}" does not state its licensing terms and will not load.`,
      );
    }
    throw new CollectorError(
      `Collector "${String(definition.id)}" is misdeclared: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    );
  }
  return { ...parsed.data, normalize };
}

export class CollectorRegistry {
  private readonly byId = new Map<string, Collector>();

  register(collector: Collector): void {
    if (this.byId.has(collector.id)) {
      throw new CollectorError(`Collector "${collector.id}" is already registered.`);
    }
    this.byId.set(collector.id, collector);
  }

  get(id: string): Collector | undefined {
    return this.byId.get(id);
  }

  list(): readonly Collector[] {
    return [...this.byId.values()];
  }
}

/**
 * Every collection run starts here. The context must permit COLLECT and must
 * permit this collector's source class. Both refusals name what is missing.
 */
export function assertMayCollect(ctx: ScopeContext, collector: Collector): void {
  ctx.assertLive();
  ctx.assertAction("COLLECT");
  ctx.assertSourceClass(collector.sourceClass as SourceClass);
}
