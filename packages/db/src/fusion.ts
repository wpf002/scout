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
}

/** Postgres allows 65535 bound parameters per statement; 13 per row. */
const CHUNK = 500;

/**
 * Inserts observations, skipping any whose (source, contentHash) already
 * exists. Returns the ids actually written, in input order for those written.
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
      return Prisma.sql`(${id}, ${r.sourceId}, ${r.authorizationId}, ${r.caseId ?? null}, ${r.collectedAt}, ${r.observedAt}, ${JSON.stringify(r.rawPayload ?? null)}::jsonb, ${JSON.stringify(r.normalizedPayload)}::jsonb, ${r.contentHash}, ${geom}, ${r.confidenceBp}, ${r.indeterminate})`;
    });

    const inserted = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "Observation"
        ("id", "sourceId", "authorizationId", "caseId", "collectedAt", "observedAt",
         "rawPayload", "normalizedPayload", "contentHash", "geom", "confidenceBp", "indeterminate")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("sourceId", "contentHash") DO NOTHING
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

export interface EdgeAsOf {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  validFrom: Date;
  validUntil: Date | null;
  confidenceBp: number;
  evidenceObservationIds: string[];
}

/**
 * The edges of the graph as it was known at `asOf`, optionally limited to
 * edges touching the given entities. Both clocks apply; see
 * packages/fusion/src/temporal.ts for why.
 */
export async function edgesAsOf(
  asOf: Date,
  filter: { entityIds?: readonly string[]; authorizationId?: string } = {},
): Promise<EdgeAsOf[]> {
  const predicate = Prisma.raw(asOfSql("e", "$1"));
  const entityClause =
    filter.entityIds !== undefined && filter.entityIds.length > 0
      ? Prisma.sql`AND (e."fromEntityId" = ANY(${filter.entityIds}::text[]) OR e."toEntityId" = ANY(${filter.entityIds}::text[]))`
      : Prisma.empty;
  const authClause =
    filter.authorizationId !== undefined
      ? Prisma.sql`AND e."authorizationId" = ${filter.authorizationId}`
      : Prisma.empty;

  // $1 is asOf. Prisma numbers parameters in order of appearance, so asOf is
  // bound first and the raw predicate refers to it as $1.
  return prisma.$queryRaw<EdgeAsOf[]>`
    SELECT e."id", e."fromEntityId", e."toEntityId", e."relation"::text AS "relation",
           e."validFrom", e."validUntil", e."confidenceBp", e."evidenceObservationIds"
    FROM "EntityEdge" e
    WHERE ${asOf}::timestamptz IS NOT NULL AND ${predicate}
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
export async function checkGraphConsistency(limit = 200): Promise<ConsistencyReport> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  const danglingEvidence = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT e."id" FROM "EntityEdge" e
      WHERE EXISTS (
        SELECT 1 FROM unnest(e."evidenceObservationIds") AS x(obs)
        WHERE NOT EXISTS (SELECT 1 FROM "Observation" o WHERE o."id" = x.obs)
      ) LIMIT ${limit}`,
  );

  const resolvedWithoutMembers = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT en."id" FROM "Entity" en
      WHERE en."status" = 'RESOLVED'
        AND NOT EXISTS (
          SELECT 1 FROM "EntityMember" m WHERE m."entityId" = en."id" AND m."supersededAt" IS NULL
        ) LIMIT ${limit}`,
  );

  const selfEdges = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "EntityEdge" WHERE "fromEntityId" = "toEntityId" LIMIT ${limit}`,
  );

  const supersededBeforeCreated = ids(
    await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "EntityEdge" WHERE "supersededAt" IS NOT NULL AND "supersededAt" < "createdAt"
      UNION ALL
      SELECT "id" FROM "EntityMember" WHERE "supersededAt" IS NOT NULL AND "supersededAt" < "addedAt"
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
