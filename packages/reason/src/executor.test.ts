import { describe, expect, it } from "vitest";
import { ScopeContext } from "@scout/scope";

import { executePlan, type Edge, type Node, type Operations } from "./executor.js";
import { validatePlan } from "./plan.js";

const now = new Date("2026-09-13T12:00:00Z");
const build = (overrides: Partial<{ actionClasses: string[]; entityKinds: string[] }> = {}) =>
  ScopeContext.build({
    operator: "tester",
    now,
    authorization: {
      id: "auth_1",
      reference: "AUTH-1",
      issuedBy: "Court",
      boundary: { scope: [{ kind: "domain", value: "example.net" }], entityKinds: overrides.entityKinds ?? ["PERSON", "ORG"] },
      sourceClasses: ["PUBLIC_RECORD"],
      actionClasses: overrides.actionClasses ?? ["READ_GRAPH"],
      validFrom: new Date("2026-01-01T00:00:00Z"),
      validUntil: new Date("2027-01-01T00:00:00Z"),
      revokedAt: null,
    },
  });

const P1: Node = { id: "e1", kind: "PERSON", label: "ingrid eriksen", status: "RESOLVED" };
const P2: Node = { id: "e2", kind: "PERSON", label: "olu eriksen", status: "RESOLVED" };
const V1: Node = { id: "e3", kind: "VESSEL", label: "mv summit dawn", status: "RESOLVED" };
const edge: Edge = { id: "x1", fromEntityId: "e1", toEntityId: "e2", relation: "ASSOCIATED_WITH", validFrom: new Date("2026-06-25T00:00:00Z"), validUntil: null, confidenceBp: 5500, basis: "shared:ADDRESS", evidenceObservationIds: ["obs_a", "obs_b"] };

const ops = (calls: string[]): Operations => ({
  findEntities: async ({ text }) => { calls.push(`find:${text}`); return text.includes("ingrid") ? [P1] : text.includes("summit") ? [V1] : []; },
  neighbors: async ({ entityId, hops }) => { calls.push(`neighbors:${entityId}:${hops}`); return { root: P1, nodes: [P1, P2], edges: [edge], truncated: false }; },
  pathBetween: async () => ({ found: false, hops: null, nodes: [], edges: [] }),
  coLocation: async () => ({ entity: P1, edges: [], others: [] }),
  timeline: async ({ entityId }) => { calls.push(`timeline:${entityId}`); return { entity: P1, events: [{ at: new Date("2026-08-01T00:00:00Z"), kind: "observation", detail: "observed by synth-records", observationId: "obs_c", sourceId: "synth-records" }] }; },
  sourcesConsulted: async () => [{ sourceId: "synth-records", observations: 3, lastObservedAt: now }, { sourceId: "sec-edgar", observations: 0, lastObservedAt: null }],
});

describe("executePlan", () => {
  it("chains a find into later steps and collects every observation id as evidence", async () => {
    const calls: string[] = [];
    const plan = validatePlan({ steps: [{ id: "s1", op: "find-entity", text: "ingrid eriksen" }, { id: "s2", op: "neighbors-of", entity: { ref: "s1" } }, { id: "s3", op: "timeline-for-entity", entity: { ref: "s1" } }] });
    const run = await executePlan(plan, ops(calls), build(), now);
    expect(calls).toEqual(["find:ingrid eriksen", "neighbors:e1:1", "timeline:e1"]);
    expect([...run.evidence].sort()).toEqual(["obs_a", "obs_b", "obs_c"]);
    expect(run.cost).toBe(1 + 2 + 1);
  });

  it("refuses when a find step matched nothing, naming what would be needed", async () => {
    const plan = validatePlan({ steps: [{ id: "s1", op: "find-entity", text: "nobody here" }, { id: "s2", op: "neighbors-of", entity: { ref: "s1" } }] });
    await expect(executePlan(plan, ops([]), build(), now)).rejects.toMatchObject({
      refusal: { reason: "unknown-entity", requires: expect.stringContaining('Collection on "nobody here"'), authorizationReference: "AUTH-1" },
    });
  });

  it("refuses without READ_GRAPH before running anything", async () => {
    const calls: string[] = [];
    const plan = validatePlan({ steps: [{ id: "s1", op: "sources-consulted" }] });
    await expect(executePlan(plan, ops(calls), build({ actionClasses: ["COLLECT"] }), now)).rejects.toMatchObject({ refusal: { reason: "action-not-permitted", requires: expect.stringContaining("READ_GRAPH") } });
    expect(calls).toEqual([]);
  });

  it("refuses a subject whose kind the authorization does not cover, with the kind named", async () => {
    const plan = validatePlan({ steps: [{ id: "s1", op: "find-entity", text: "mv summit dawn", kind: "VESSEL" }, { id: "s2", op: "neighbors-of", entity: { ref: "s1" } }] });
    await expect(executePlan(plan, ops([]), build(), now)).rejects.toMatchObject({ refusal: { reason: "out-of-scope-subject", requires: expect.stringContaining("VESSEL") } });
    // Even without the kind hint, an entity of an uncovered kind that a host returns is not admitted.
    const bare = validatePlan({ steps: [{ id: "s1", op: "find-entity", text: "mv summit dawn" }, { id: "s2", op: "neighbors-of", entity: { ref: "s1" } }] });
    await expect(executePlan(bare, ops([]), build(), now)).rejects.toMatchObject({ refusal: { reason: "out-of-scope-subject" } });
  });
});
