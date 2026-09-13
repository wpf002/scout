import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { asOfSql } from "@scout/fusion";
import { prisma } from "./client.js";

/**
 * v2 write and read helpers that the Prisma client cannot express.
 *
 * `Observation.geom` is a PostGIS geography, which Prisma declares
 * `Unsupported` and leaves out of the client. Observations are also immutable
 * (an UPDATE trigger rejects changes), so the position cannot be set after an
 * insert. Every observation write therefore goes through raw SQL here, in one
 * place, with the position bound at insert time.
 */

export interface ObservationRow {
  id?: string;
  sourceId: string;
  authorizationId: string;
  caseId?: string | null;
  collectedAt: Date;
  observedAt: Date;
  rawPayload: unknown;
  normalizedPayload: Record<string, unknown>;
  contentHash: string;
  position: { lon: number; lat: number } | null;
  confidenceBp: number | null;
  indeterminate: boolean;
  entityKind?: string | null;
}

/** Postgres allows 65535 bound parameters per statement; 14 per row. */
const CHUNK = 500;

/**
 * Inserts observations, skipping any whose (source, authorization,
 * contentHash) already exists. Returns the ids actually written, in input order for those written.
 *
 * NOT NULL on the four provenance columns is the last line of defence; the
 * caller is expected to have run `assertProvenance()` first, which names the
 * missing field instead of surfacing a constraint name.
 */
export async function insertObservations(
  rows: readonly ObservationRow[],
): Promise<string[]> {
  const written: string[] = [];
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values = chunk.map((r) => {
      const id = r.id ?? randomUUID();
      const geom =
        r.position === null
          ? Prisma.sql`NULL`
          : Prisma.sql`ST_SetSRID(ST_MakePoint(${r.position.lon}, ${r.position.lat}), 4326)::geography`;
      const kind = r.entityKind === undefined || r.entityKind === null ? Prisma.sql`NULL` : Prisma.sql`${r.entityKind}::"FusionEntityKind"`;
      return Prisma.sql`(${id}, ${r.sourceId}, ${r.authorizationId}, ${r.caseId ?? null}, ${r.collectedAt}, ${r.observedAt}, ${JSON.stringify(r.rawPayload ?? null)}::jsonb, ${JSON.stringify(r.normalizedPayload)}::jsonb, ${r.contentHash}, ${geom}, ${r.confidenceBp}, ${r.indeterminate}, ${kind})`;
    });

    const inserted = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "Observation"
        ("id", "sourceId", "authorizationId", "caseId", "collectedAt", "observedAt",
         "rawPayload", "normalizedPayload", "contentHash", "geom", "confidenceBp", "indeterminate", "entityKind")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("sourceId", "authorizationId", "contentHash") DO NOTHING
      RETURNING "id"`;
    written.push(...inserted.map((r) => r.id));
  }
  return written;
}

/** The position of one observation, read back out of the geography column. */
export async function positionOf(
  observationId: string,
): Promise<{ lon: number; lat: number } | null> {
  const rows = await prisma.$queryRaw<{ lon: number | null; lat: number | null }[]>`
    SELECT ST_X("geom"::geometry) AS lon, ST_Y("geom"::geometry) AS lat
    FROM "Observation" WHERE "id" = ${observationId}`;
  const row = rows[0];
  if (row === undefined || row.lon === null || row.lat === null) return null;
  return { lon: row.lon, lat: row.lat };
}

/** Positions for many observations in one query. Rows without one are absent. */
export async function positionsOf(
  ids: readonly string[],
): Promise<Map<string, { lon: number; lat: number }>> {
  const out = new Map<string, { lon: number; lat: number }>();
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRaw<{ id: string; lon: number; lat: number }[]>`
    SELECT "id", ST_X("geom"::geometry) AS lon, ST_Y("geom"::geometry) AS lat
    FROM "Observation" WHERE "id" = ANY(${[...ids]}::text[]) AND "geom" IS NOT NULL`;
  for (const row of rows) out.set(row.id, { lon: row.lon, lat: row.lat });
  return out;
}

export interface DensityCell {
  lon: number;
  lat: number;
  count: number;
  sources: string[];
  kinds: string[];
  latestObservedAt: Date;
}

/**
 * Observations binned onto a square grid of `cellDegrees`, for a map that
 * cannot draw a million points and should not pretend to. Each cell says
 * how many, from which sources, of which kinds, and how recent; the cell's
 * centre is the coordinate. Ordered densest first, capped.
 */
export async function observationDensity(input: {
  authorizationId: string;
  caseId?: string | null;
  asOf?: Date | null;
  bbox?: readonly [number, number, number, number] | null;
  cellDegrees: number;
  limit?: number;
}): Promise<DensityCell[]> {
  const cell = Math.max(0.001, Math.min(10, input.cellDegrees));
  const caseClause = input.caseId === undefined || input.caseId === null ? Prisma.empty : Prisma.sql`AND "caseId" = ${input.caseId}`;
  const asOfClause = input.asOf === undefined || input.asOf === null ? Prisma.empty : Prisma.sql`AND "observedAt" <= ${input.asOf}`;
  const boxClause =
    input.bbox === undefined || input.bbox === null
      ? Prisma.empty
      : Prisma.sql`AND ST_Intersects("geom", ST_MakeEnvelope(${input.bbox[0]}, ${input.bbox[1]}, ${input.bbox[2]}, ${input.bbox[3]}, 4326)::geography)`;
  return prisma.$queryRaw<DensityCell[]>`
    SELECT (floor(ST_X("geom"::geometry) / ${cell}::float8) * ${cell}::float8 + ${cell}::float8 / 2) AS lon,
           (floor(ST_Y("geom"::geometry) / ${cell}::float8) * ${cell}::float8 + ${cell}::float8 / 2) AS lat,
           count(*)::int AS count,
           array_agg(DISTINCT "sourceId") AS sources,
           coalesce(array_agg(DISTINCT "entityKind"::text) FILTER (WHERE "entityKind" IS NOT NULL), ARRAY[]::text[]) AS kinds,
           max("observedAt") AS "latestObservedAt"
    FROM "Observation"
    WHERE "authorizationId" = ${input.authorizationId} AND "geom" IS NOT NULL ${caseClause} ${asOfClause} ${boxClause}
    GROUP BY 1, 2
    ORDER BY count DESC, lon, lat
    LIMIT ${Math.max(1, Math.min(20_000, input.limit ?? 5_000))}`;
}

/** Ids of the positioned observations inside a box, newest first, so a viewport can be read as a window. */
export async function observationIdsInBox(input: {
  authorizationId: string;
  caseId?: string | null;
  asOf?: Date | null;
  bbox: readonly [number, number, number, number];
  limit: number;
}): Promise<string[]> {
  const caseClause = input.caseId === undefined || input.caseId === null ? Prisma.empty : Prisma.sql`AND "caseId" = ${input.caseId}`;
  const asOfClause = input.asOf === undefined || input.asOf === null ? Prisma.empty : Prisma.sql`AND "observedAt" <= ${input.asOf}`;
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Observation"
    WHERE "authorizationId" = ${input.authorizationId} AND "geom" IS NOT NULL ${caseClause} ${asOfClause}
      AND ST_Intersects("geom", ST_MakeEnvelope(${input.bbox[0]}, ${input.bbox[1]}, ${input.bbox[2]}, ${input.bbox[3]}, 4326)::geography)
    ORDER BY "observedAt" DESC, "id"
    LIMIT ${Math.max(1, Math.min(5_000, input.limit))}`;
  return rows.map((r) => r.id);
}

export interface CoLocatedPair {
  leftObservationId: string;
  rightObservationId: string;
  meters: number;
  leftObservedAt: Date;
  rightObservedAt: Date;
}

/**
 * Pairs of positioned observations under one authorization that were within
 * `radiusM` of each other and within `windowSeconds` in time. PostGIS does
 * the distance on the geography type, so metres are metres everywhere on the
 * globe. The caller maps observations to entities and skips pairs inside one.
 */
export async function coLocatedObservations(
  authorizationId: string,
  radiusM: number,
  windowSeconds: number,
  limit = 20_000,
): Promise<CoLocatedPair[]> {
  return prisma.$queryRaw<CoLocatedPair[]>`
    SELECT a."id" AS "leftObservationId", b."id" AS "rightObservationId",
           ST_Distance(a."geom", b."geom") AS "meters",
           a."observedAt" AS "leftObservedAt", b."observedAt" AS "rightObservedAt"
    FROM "Observation" a
    JOIN "Observation" b ON a."id" < b."id"
    WHERE a."authorizationId" = ${authorizationId} AND b."authorizationId" = ${authorizationId}
      AND a."geom" IS NOT NULL AND b."geom" IS NOT NULL
      AND ST_DWithin(a."geom", b."geom", ${radiusM})
      AND abs(extract(epoch FROM (a."observedAt" - b."observedAt"))) <= ${windowSeconds}
    ORDER BY a."id", b."id"
    LIMIT ${limit}`;
}

export interface EdgeAsOf {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  validFrom: Date;
  validUntil: Date | null;
  confidenceBp: number;
  /** The rule that produced the confidence: "shared:PHONE", "co-location:2000m/30min", "asserted". */
  basis: string | null;
  evidenceObservationIds: string[];
}

/**
 * The edges that held at `asOf` and were known by `knownAs`, optionally
 * limited to edges touching the given entities. `knownAs` defaults to `asOf`
 * (the strict reading); `asOf: null` applies the knowledge clock only. See
 * packages/fusion/src/temporal.ts for why there are two.
 */
export async function edgesAsOf(
  asOf: Date | null,
  filter: { entityIds?: readonly string[]; authorizationId?: string; knownAs?: Date } = {},
): Promise<EdgeAsOf[]> {
  const knownAs = filter.knownAs ?? asOf ?? new Date();
  const held = asOf ?? knownAs;
  const predicate = Prisma.raw(asOfSql("e", asOf === null ? null : "$1", "$2"));
  const entityClause =
    filter.entityIds !== undefined && filter.entityIds.length > 0
      ? Prisma.sql`AND (e."fromEntityId" = ANY(${filter.entityIds}::text[]) OR e."toEntityId" = ANY(${filter.entityIds}::text[]))`
      : Prisma.empty;
  const authClause =
    filter.authorizationId !== undefined
      ? Prisma.sql`AND e."authorizationId" = ${filter.authorizationId}`
      : Prisma.empty;

  // $1 is asOf and $2 is knownAs: bound first, in that order, so the raw
  // predicate's placeholders line up with Prisma's numbering.
  return prisma.$queryRaw<EdgeAsOf[]>`
    SELECT e."id", e."fromEntityId", e."toEntityId", e."relation"::text AS "relation",
           e."validFrom", e."validUntil", e."confidenceBp", e."basis", e."evidenceObservationIds"
    FROM "EntityEdge" e
    WHERE ${held}::timestamptz IS NOT NULL AND ${knownAs}::timestamptz IS NOT NULL AND ${predicate}
      ${entityClause} ${authClause}
    ORDER BY e."validFrom", e."id"`;
}

export interface ConsistencyReport {
  checkedAt: Date;
  /** Edges citing an observation id that does not exist. No FK covers arrays. */
  danglingEvidence: string[];
  /** RESOLVED entities with no active membership. */
  resolvedWithoutMembers: string[];
  /** Edges from an entity to itself. */
  selfEdges: string[];
  /** Rows superseded before they were created. */
  supersededBeforeCreated: string[];
  clean: boolean;
}

/**
 * The consistency check. The spec wanted one because a graph projection can
 * drift from its source tables. There is no projection here, but the
 * relational tables can still disagree with themselves in ways no constraint
 * catches, and this names each way.
 */
export async function checkGraphConsistency(
  limit = 200,
  authorizationId?: string,
): Promise<ConsistencyReport> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  // Scoped to one authorization when asked (the route), global when not (the
  // job). The same four questions either way.
  const edgeScope =
    authorizationId === undefined ? Prisma.empty : Prisma.sql`AND e."authorizationId" = ${authorizationId}`;
  const entityScope =
    authorizationId === undefined
      ? Prisma.empty
      : Prisma.sql`AND EXISTS (SELECT 1 FROM "ResolutionRun" r WHERE r."id" = en."resolutionRunId" AND r."authorizationId" = ${authorizationId})`;

  const danglingEvidence = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "EntityEdge" e
      WHERE EXISTS (
        SELECT 1 FROM unnest(e."evidenceObservationIds") AS x(obs)
        WHERE NOT EXISTS (SELECT 1 FROM "Observation" o WHERE o."id" = x.obs)
      ) ${edgeScope} LIMIT ${limit}`,
  );

  const resolvedWithoutMembers = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT en."id" FROM "Entity" en
      WHERE en."status" = 'RESOLVED'
        AND NOT EXISTS (
          SELECT 1 FROM "EntityMember" m WHERE m."entityId" = en."id" AND m."supersededAt" IS NULL
        ) ${entityScope} LIMIT ${limit}`,
  );

  const selfEdges = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "EntityEdge" e WHERE e."fromEntityId" = e."toEntityId" ${edgeScope} LIMIT ${limit}`,
  );

  const supersededBeforeCreated = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "EntityEdge" e WHERE e."supersededAt" IS NOT NULL AND e."supersededAt" < e."createdAt" ${edgeScope}
      UNION ALL
      SELECT m."id" FROM "EntityMember" m WHERE m."supersededAt" IS NOT NULL AND m."supersededAt" < m."addedAt"
      LIMIT ${limit}`,
  );

  return {
    checkedAt: new Date(),
    danglingEvidence,
    resolvedWithoutMembers,
    selfEdges,
    supersededBeforeCreated,
    clean:
      danglingEvidence.length +
        resolvedWithoutMembers.length +
        selfEdges.length +
        supersededBeforeCreated.length ===
      0,
  };
}
