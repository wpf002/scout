import { describe, expect, it } from "vitest";

import { MAX_COST, PlanError, planCost, validatePlan } from "./plan.js";

describe("validatePlan", () => {
  it("accepts a chained plan and prices it", () => {
    const plan = validatePlan({
      steps: [
        { id: "s1", op: "find-entity", text: "Ingrid Eriksen" },
        { id: "s2", op: "neighbors-of", entity: { ref: "s1", index: 0 }, hops: 2 },
        { id: "s3", op: "timeline-for-entity", entity: { ref: "s1" } },
      ],
    });
    expect(plan.steps).toHaveLength(3);
    expect(planCost(plan)).toBe(1 + 3 + 1);
  });

  it("refuses a step that is not one of the permitted operations", () => {
    expect(() => validatePlan({ steps: [{ id: "s1", op: "run-sql", text: "SELECT 1" }] })).toThrow(PlanError);
  });

  it("refuses a reference to a step that is not an earlier find", () => {
    expect(() => validatePlan({ steps: [{ id: "s1", op: "neighbors-of", entity: { ref: "s9" } }] })).toThrow(/s9/);
    expect(() => validatePlan({ steps: [{ id: "s1", op: "neighbors-of", entity: { ref: "s2" } }, { id: "s2", op: "find-entity", text: "x" }] })).toThrow(/not an earlier/);
  });

  it("refuses a plan over budget, and hops over the cap", () => {
    expect(() => validatePlan({ steps: [{ id: "s1", op: "path-between", from: { entityId: "a" }, to: { entityId: "b" }, maxHops: 6 }, { id: "s2", op: "path-between", from: { entityId: "a" }, to: { entityId: "c" }, maxHops: 6 }, { id: "s3", op: "sources-consulted" }] })).toThrow(new RegExp(`budget is ${MAX_COST}`));
    expect(() => validatePlan({ steps: [{ id: "s1", op: "neighbors-of", entity: { entityId: "a" }, hops: 9 }] })).toThrow(PlanError);
  });

  it("refuses a window that runs backwards and a duplicated step id", () => {
    expect(() => validatePlan({ steps: [{ id: "s1", op: "co-location-window", entity: { entityId: "a" }, from: "2026-06-02", to: "2026-06-01" }] })).toThrow(/ends before/);
    expect(() => validatePlan({ steps: [{ id: "s1", op: "sources-consulted" }, { id: "s1", op: "sources-consulted" }] })).toThrow(/twice/);
  });
});
