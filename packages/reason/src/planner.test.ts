import { describe, expect, it } from "vitest";

import type { ModelClient } from "./model.js";
import { planByRules, planQuestion } from "./planner.js";
import { ReasonRefusal } from "./refusal.js";

const ctx = { now: new Date("2026-09-13T12:00:00Z"), authorizationReference: "AUTH-1" };

describe("planByRules", () => {
  it("maps the question shapes to plans without a model", () => {
    const who = planByRules("Who is connected to Ingrid Eriksen?", ctx);
    expect(who?.shape).toBe("neighbors-of");
    expect(who?.plan.steps.map((s) => s.op)).toEqual(["find-entity", "neighbors-of"]);
    expect(who?.plan.steps[0]).toMatchObject({ text: "Ingrid Eriksen" });

    const hops = planByRules("connections of MV Summit Dawn within 2 hops", ctx);
    expect(hops?.plan.steps[1]).toMatchObject({ op: "neighbors-of", hops: 2 });

    const path = planByRules("How is Amara Okafor connected to Anvil Logistics?", ctx);
    expect(path?.plan.steps.map((s) => s.op)).toEqual(["find-entity", "find-entity", "path-between"]);
    expect(path?.plan.steps[1]).toMatchObject({ text: "Anvil Logistics" });

    const near = planByRules("Who was near FV Maple Star on 2026-08-16?", ctx);
    expect(near?.plan.steps[1]).toMatchObject({ op: "co-location-window", from: new Date("2026-08-16T00:00:00Z"), to: new Date("2026-08-16T23:59:59.999Z") });

    const between = planByRules("where was FV Maple Star between 2026-08-01 and 2026-08-20", ctx);
    expect(between?.plan.steps[1]).toMatchObject({ op: "co-location-window", from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-20T23:59:59.999Z") });

    expect(planByRules("timeline of Olu Eriksen", ctx)?.plan.steps[1]).toMatchObject({ op: "timeline-for-entity" });
    expect(planByRules("Which sources were consulted?", ctx)?.plan.steps[0]).toMatchObject({ op: "sources-consulted" });
    expect(planByRules("What do we know about Zara Eriksen?", ctx)?.plan.steps.map((s) => s.op)).toEqual(["find-entity", "neighbors-of", "timeline-for-entity"]);
  });

  it("returns null for a shape it does not know", () => {
    expect(planByRules("Is the weather nice in Valparaíso?", ctx)).toBeNull();
  });
});

describe("planQuestion", () => {
  it("refuses an unknown shape with the shapes it does know when there is no model", async () => {
    await expect(planQuestion("Is the weather nice in Valparaíso?", ctx, null)).rejects.toMatchObject({
      refusal: { reason: "cannot-plan", authorizationReference: "AUTH-1" },
    });
  });

  it("accepts a model's plan only when it validates", async () => {
    const say = (text: string): ModelClient => ({ provider: "fake", complete: async () => ({ text, model: "m", provider: "fake" }) });
    const ok = await planQuestion("anything unusual", ctx, say('```json\n{"steps":[{"id":"s1","op":"sources-consulted"}]}\n```'));
    expect(ok.plannedBy).toBe("model");
    expect(ok.plan.steps[0]?.op).toBe("sources-consulted");

    await expect(planQuestion("anything unusual", ctx, say('{"steps":[{"id":"s1","op":"raw-sql","sql":"DROP TABLE x"}]}'))).rejects.toMatchObject({ refusal: { reason: "invalid-plan" } });
    await expect(planQuestion("anything unusual", ctx, say('{"steps":[]}'))).rejects.toMatchObject({ refusal: { reason: "cannot-plan" } });
    await expect(planQuestion("anything unusual", ctx, say("I cannot help with that"))).rejects.toMatchObject({ refusal: { reason: "invalid-plan" } });
    const down: ModelClient = { provider: "fake", complete: async () => { throw new Error("connection refused"); } };
    await expect(planQuestion("anything unusual", ctx, down)).rejects.toBeInstanceOf(ReasonRefusal);
  });
});
