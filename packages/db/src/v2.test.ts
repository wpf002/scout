import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "./client.js";
import {
  checkGraphConsistency,
  edgesAsOf,
  insertObservations,
  positionOf,
} from "./fusion.js";

/**
 * v2 database guarantees, against a live Postgres with PostGIS.
 *
 * These prove what the migration claims: provenance is NOT NULL, audit and
 * decision tables reject mutation, memberships and edges cannot be deleted,
 * the check constraints hold, and a query at `asOf` returns exactly the graph
 * known at that instant. Skipped without DATABASE_URL, like audit.test.ts.
 */
const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

const suffix = randomUUID().slice(0, 8);
const AUTH = `auth_v2test_${suffix}`;
const SRC = `v2test-source-${suffix}`;

async function seedObservation(hash = randomUUID()): Promise<string> {
  const [id] = await insertObservations([
    {
      sourceId: SRC,
      authorizationId: AUTH,
      collectedAt: new Date("2026-09-13T12:00:00Z"),
      observedAt: new Date("2026-09-13T11:59:00Z"),
      rawPayload: { hash },
      normalizedPayload: { hash },
      contentHash: hash,
      position: { lon: -122.676, lat: 45.523 },
      confidenceBp: 9000,
      indeterminate: false,
    },
  ]);
  return id as string;
}

run("v2 schema guarantees", () => {
  beforeAll(async () => {
    await prisma.authorization.create({
      data: {
        id: AUTH,
        reference: `V2TEST-${suffix}`,
        issuedBy: "vitest",
        boundary: { scope: [], entityKinds: [] },
        sourceClasses: ["SENSOR"],
        actionClasses: ["COLLECT", "READ_GRAPH"],
        validFrom: new Date("2026-01-01T00:00:00Z"),
        validUntil: new Date("2027-01-01T00:00:00Z"),
      },
    });
    await prisma.collectionSource.create({
      data: { id: SRC, name: "v2 test source", class: "SENSOR", licensingTerms: "Test fixture; no licence.", refreshCadenceSeconds: 60 },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("provenance", () => {
    it("writes an observation with a position and reads it back", async () => {
      const id = await seedObservation();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const pos = await positionOf(id);
      expect(pos?.lon).toBeCloseTo(-122.676, 3);
      expect(pos?.lat).toBeCloseTo(45.523, 3);
    });

    it("refuses an observation with no authorization at the database", async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "Observation" ("id","sourceId","authorizationId","collectedAt","observedAt","rawPayload","normalizedPayload","contentHash")
          VALUES (${randomUUID()}, ${SRC}, NULL, now(), now(), '{}'::jsonb, '{}'::jsonb, ${randomUUID()})`,
      ).rejects.toThrow(/23502|not-null|null value/);
    });

    it("refuses an observation with no observedAt", async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "Observation" ("id","sourceId","authorizationId","collectedAt","observedAt","rawPayload","normalizedPayload","contentHash")
          VALUES (${randomUUID()}, ${SRC}, ${AUTH}, now(), NULL, '{}'::jsonb, '{}'::jsonb, ${randomUUID()})`,
      ).rejects.toThrow(/23502|not-null|null value/);
    });

    it("dedupes on (source, contentHash)", async () => {
      const hash = randomUUID();
      const first = await seedObservation(hash);
      const again = await insertObservations([
        {
          sourceId: SRC, authorizationId: AUTH, collectedAt: new Date(), observedAt: new Date(),
          rawPayload: {}, normalizedPayload: { hash }, contentHash: hash, position: null, confidenceBp: null, indeterminate: false,
        },
      ]);
      expect(first).toBeTruthy();
      expect(again).toEqual([]);
    });

    it("refuses a confidence outside basis points", async () => {
      await expect(
        insertObservations([
          {
            sourceId: SRC, authorizationId: AUTH, collectedAt: new Date(), observedAt: new Date(),
            rawPayload: {}, normalizedPayload: { x: randomUUID() }, contentHash: randomUUID(), position: null, confidenceBp: 10_001, indeterminate: false,
          },
        ]),
      ).rejects.toThrow(/Observation_confidence_bp/);
    });

    it("is immutable once written", async () => {
      const id = await seedObservation();
      await expect(
        prisma.$executeRaw`UPDATE "Observation" SET "indeterminate" = true WHERE "id" = ${id}`,
      ).rejects.toThrow(/immutable/);
    });
  });

  describe("append-only tables", () => {
    it("AccessLog rejects update and delete", async () => {
      const row = await prisma.accessLog.create({
        data: { actor: "vitest", authorizationId: AUTH, action: "read", targetType: "Entity", targetIds: [], resultCount: 0 },
      });
      await expect(prisma.accessLog.update({ where: { id: row.id }, data: { resultCount: 1 } })).rejects.toThrow(/immutable/);
      await expect(prisma.accessLog.delete({ where: { id: row.id } })).rejects.toThrow(/immutable/);
    });

    it("MatchDecision and Adjudication reject update and delete", async () => {
      const runRow = await prisma.resolutionRun.create({
        data: { authorizationId: AUTH, modelVersion: "t", normalizationVersion: "t", matchThresholdBp: 9500, reviewThresholdBp: 7000 },
      });
      const a = await seedObservation();
      const b = await seedObservation();
      const decision = await prisma.matchDecision.create({
        data: { runId: runRow.id, leftObservationId: a, rightObservationId: b, scoreBp: 8000, decision: "REVIEW", featureVector: {}, modelVersion: "t", blockingKey: "exact:hash" },
      });
      await expect(prisma.matchDecision.update({ where: { id: decision.id }, data: { decision: "MATCH" } })).rejects.toThrow(/immutable/);
      await expect(prisma.matchDecision.delete({ where: { id: decision.id } })).rejects.toThrow(/immutable/);

      const adj = await prisma.adjudication.create({
        data: { pairKey: [a, b].sort().join("|"), leftObservationId: a, rightObservationId: b, decision: "NON_MATCH", adjudicatedBy: "vitest", note: "different people" },
      });
      await expect(prisma.adjudication.delete({ where: { id: adj.id } })).rejects.toThrow(/immutable/);
    });

    it("refuses a resolution run whose review band is collapsed", async () => {
      await expect(
        prisma.resolutionRun.create({
          data: { authorizationId: AUTH, modelVersion: "t", normalizationVersion: "t", matchThresholdBp: 7000, reviewThresholdBp: 7000 },
        }),
      ).rejects.toThrow(/ResolutionRun_band_open/);
    });
  });

  describe("memberships and edges", () => {
    it("supersedes a membership but never deletes it", async () => {
      const entity = await prisma.entity.create({ data: { kind: "PERSON", canonicalLabel: "t" } });
      const obs = await seedObservation();
      const m = await prisma.entityMember.create({
        data: { entityId: entity.id, observationId: obs, scoreBp: 9800, method: "exact", addedBy: "SYSTEM" },
      });
      await expect(prisma.entityMember.delete({ where: { id: m.id } })).rejects.toThrow(/immutable/);
      const superseded = await prisma.entityMember.update({ where: { id: m.id }, data: { supersededAt: new Date(), supersededBy: "vitest" } });
      expect(superseded.supersededAt).not.toBeNull();
    });

    it("refuses an edge with no evidence, an inverted window, and deletion", async () => {
      const a = await prisma.entity.create({ data: { kind: "PERSON", canonicalLabel: "a" } });
      const b = await prisma.entity.create({ data: { kind: "PERSON", canonicalLabel: "b" } });
      const obs = await seedObservation();

      await expect(
        prisma.entityEdge.create({
          data: { fromEntityId: a.id, toEntityId: b.id, relation: "ASSOCIATED_WITH", validFrom: new Date(), confidenceBp: 5000, evidenceObservationIds: [], authorizationId: AUTH },
        }),
      ).rejects.toThrow(/EntityEdge_evidence_nonempty/);

      await expect(
        prisma.entityEdge.create({
          data: { fromEntityId: a.id, toEntityId: b.id, relation: "ASSOCIATED_WITH", validFrom: new Date("2026-06-01T00:00:00Z"), validUntil: new Date("2026-05-01T00:00:00Z"), confidenceBp: 5000, evidenceObservationIds: [obs], authorizationId: AUTH },
        }),
      ).rejects.toThrow(/EntityEdge_valid_window/);

      const edge = await prisma.entityEdge.create({
        data: { fromEntityId: a.id, toEntityId: b.id, relation: "ASSOCIATED_WITH", validFrom: new Date("2026-06-01T00:00:00Z"), confidenceBp: 5000, evidenceObservationIds: [obs], authorizationId: AUTH },
      });
      await expect(prisma.entityEdge.delete({ where: { id: edge.id } })).rejects.toThrow(/immutable/);
    });
  });

  describe("the graph as of a moment", () => {
    it("returns exactly the edges that held and were known at asOf", async () => {
      const a = await prisma.entity.create({ data: { kind: "VESSEL", canonicalLabel: "a" } });
      const b = await prisma.entity.create({ data: { kind: "VESSEL", canonicalLabel: "b" } });
      const c = await prisma.entity.create({ data: { kind: "VESSEL", canonicalLabel: "c" } });
      const obs = await seedObservation();
      const at = (s: string) => new Date(s);

      // Known since March; held March–June.
      const early = await prisma.entityEdge.create({
        data: { fromEntityId: a.id, toEntityId: b.id, relation: "CO_LOCATED", validFrom: at("2026-03-01T00:00:00Z"), validUntil: at("2026-06-01T00:00:00Z"), confidenceBp: 8000, evidenceObservationIds: [obs], authorizationId: AUTH, createdAt: at("2026-03-01T00:00:00Z") },
      });
      // Held from March, but Scout only learned it in May.
      const learnedLate = await prisma.entityEdge.create({
        data: { fromEntityId: a.id, toEntityId: c.id, relation: "OPERATES", validFrom: at("2026-03-01T00:00:00Z"), confidenceBp: 9000, evidenceObservationIds: [obs], authorizationId: AUTH, createdAt: at("2026-05-15T00:00:00Z") },
      });
      // Known since March, superseded in July.
      const retracted = await prisma.entityEdge.create({
        data: { fromEntityId: b.id, toEntityId: c.id, relation: "SAME_DEVICE", validFrom: at("2026-03-01T00:00:00Z"), confidenceBp: 7000, evidenceObservationIds: [obs], authorizationId: AUTH, createdAt: at("2026-03-01T00:00:00Z"), supersededAt: at("2026-07-01T00:00:00Z") },
      });

      const idsAt = async (s: string) =>
        (await edgesAsOf(at(s), { entityIds: [a.id, b.id, c.id] })).map((e) => e.id).sort();

      expect(await idsAt("2026-02-01T00:00:00Z")).toEqual([]);
      expect(await idsAt("2026-04-01T00:00:00Z")).toEqual([early.id, retracted.id].sort());
      expect(await idsAt("2026-05-20T00:00:00Z")).toEqual([early.id, learnedLate.id, retracted.id].sort());
      expect(await idsAt("2026-06-15T00:00:00Z")).toEqual([learnedLate.id, retracted.id].sort());
      expect(await idsAt("2026-08-01T00:00:00Z")).toEqual([learnedLate.id]);
    });
  });

  describe("consistency check", () => {
    it("reports dangling evidence and resolved entities with no members", async () => {
      const a = await prisma.entity.create({ data: { kind: "ORG", canonicalLabel: "a", status: "RESOLVED" } });
      const b = await prisma.entity.create({ data: { kind: "ORG", canonicalLabel: "b" } });
      const bad = await prisma.entityEdge.create({
        data: { fromEntityId: a.id, toEntityId: b.id, relation: "MEMBER_OF", validFrom: new Date(), confidenceBp: 5000, evidenceObservationIds: ["obs_does_not_exist"], authorizationId: AUTH },
      });
      const report = await checkGraphConsistency();
      expect(report.clean).toBe(false);
      expect(report.danglingEvidence).toContain(bad.id);
      expect(report.resolvedWithoutMembers).toContain(a.id);
    });
  });
});
