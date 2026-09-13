import { z } from "zod";

/**
 * The v2 domain vocabulary.
 *
 * Named to sit beside v1 without colliding with it. `@scout/graph` already
 * exports `EntityKind` and `RELATIONS` for the case graph, which is recomputed
 * from findings on every read and stays that way. These are the kinds and
 * relations of the persisted v2 entity store, and the names say so.
 */

export const IDENTIFIER_KINDS = [
  "EMAIL",
  "PHONE",
  "HANDLE",
  "DEVICE_ID",
  "PLATE",
  "TAIL_NUMBER",
  "ICAO_HEX",
  "MMSI",
  "IMO",
  "HASH",
  "DOCUMENT_NO",
  "NAME",
  "ADDRESS",
  "DOMAIN",
  "IP",
  "URL",
] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];
export const identifierKindSchema = z.enum(IDENTIFIER_KINDS);

export const FUSION_ENTITY_KINDS = [
  "PERSON",
  "ORG",
  "VESSEL",
  "AIRCRAFT",
  "VEHICLE",
  "ACCOUNT",
  "LOCATION",
  "DEVICE",
  "INFRASTRUCTURE",
] as const;
export type FusionEntityKind = (typeof FUSION_ENTITY_KINDS)[number];
export const fusionEntityKindSchema = z.enum(FUSION_ENTITY_KINDS);

export const EDGE_RELATIONS = [
  "CO_LOCATED",
  "COMMUNICATED_WITH",
  "OWNS",
  "OPERATES",
  "MEMBER_OF",
  "TRANSACTED_WITH",
  "SAME_DEVICE",
  "ASSOCIATED_WITH",
] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];
export const edgeRelationSchema = z.enum(EDGE_RELATIONS);

/**
 * Confidence and scores are integer basis points on a 0–10000 scale. Not a
 * float: two floats that print the same can compare unequal, and a threshold
 * comparison is exactly where that goes wrong.
 */
export const basisPointsSchema = z.number().int().min(0).max(10_000);

export const positionSchema = z.object({
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type Position = z.infer<typeof positionSchema>;

/**
 * What a collector hands to the store. The four provenance fields are
 * required by the schema and by the database; `assertProvenance` names the
 * missing ones instead of letting Prisma report a null constraint.
 */
export const observationInputSchema = z
  .object({
    sourceId: z.string().min(1),
    authorizationId: z.string().min(1),
    /** When Scout received it. */
    collectedAt: z.coerce.date(),
    /** When it happened, as the source states it. */
    observedAt: z.coerce.date(),
    rawPayload: z.unknown(),
    normalizedPayload: z.record(z.string(), z.unknown()),
    position: positionSchema.nullable().default(null),
    confidenceBp: basisPointsSchema.nullable().default(null),
    indeterminate: z.boolean().default(false),
    /** Optional link to a v1 case, for the bridge. */
    caseId: z.string().min(1).optional(),
    /** What the observation is about. Resolution runs per kind. */
    entityKind: fusionEntityKindSchema.optional(),
    identifiers: z
      .array(
        z.object({
          kind: identifierKindSchema,
          value: z.string().min(1),
        }),
      )
      .default([]),
  })
  .strict();

export type ObservationInput = z.infer<typeof observationInputSchema>;
