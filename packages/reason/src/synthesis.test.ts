import { describe, expect, it } from "vitest";

import type { Execution, StepResult } from "./executor.js";
import type { ModelClient } from "./model.js";
import { validatePlan } from "./plan.js";
import { claimsFromResults, enforceCitations, synthesizeByRules, synthesizeWithModel } from "./synthesis.js";

const nodes = [{ id: "e1", kind: "PERSON", label: "ingrid eriksen", status: "RESOLVED" }, { id: "e2", kind: "PERSON", label: "olu eriksen", status: "RESOLVED" }];
const neighbors: StepResult = {
  id: "s2", op: "neighbors-of", nodes, events: [], coverage: [],
  edges: [{ id: "x1", fromEntityId: "e1", toEntityId: "e2", relation: "ASSOCIATED_WITH", validFrom: new Date("2026-06-25T00:00:00Z"), validUntil: null, confidenceBp: 5500, basis: "shared:ADDRESS", evidenceObservationIds: ["obs_a", "obs_b"] }],
};
const sources: StepResult = { id: "s3", op: "sources-consulted", nodes: [], edges: [], events: [], coverage: [{ sourceId: "synth-records", observations: 3, lastObservedAt: null }, { sourceId: "sec-edgar", observations: 0, lastObservedAt: null }] };
const plan = validatePlan({ steps: [{ id: "s1", op: "find-entity", text: "ingrid eriksen" }, { id: "s2", op: "neighbors-of", entity: { ref: "s1" } }, { id: "s3", op: "sources-consulted" }] });
const execution: Execution = { cost: 4, results: [{ id: "s1", op: "find-entity", lookedFor: "ingrid eriksen", nodes: [nodes[0] as (typeof nodes)[0]], edges: [], events: [], coverage: [] }, neighbors, sources], evidence: new Set(["obs_a", "obs_b"]) };

describe("claimsFromResults + enforceCitations", () => {
  it("writes one cited claim per link and names silent sources", () => {
    const claims = claimsFromResults(execution.results);
    expect(claims[0]).toMatchObject({ text: "ingrid eriksen is linked to olu eriksen (associated with, 5 500 bp, shared address) since 2026-06-25.", observationIds: ["obs_a", "obs_b"], basis: "observations" });
    expect(claims[1]).toMatchObject({ basis: "collection-log", sourceIds: ["synth-records", "sec-edgar"] });
    expect(claims[1]?.text).toContain("sec-edgar returned nothing");
  });

  it("drops citations the graph never produced, and claims left with none", () => {
    const kept = enforceCitations(
      [
        { text: "real", observationIds: ["obs_a", "obs_zzz"], basis: "observations" },
        { text: "invented", observationIds: ["obs_zzz"], basis: "observations" },
        { text: "uncited", observationIds: [], basis: "observations" },
      ],
      execution.evidence,
    );
    expect(kept).toEqual([{ text: "real", observationIds: ["obs_a"], basis: "observations" }]);
  });
});

describe("synthesizeByRules", () => {
  it("answers with citations", () => {
    const answer = synthesizeByRules(plan, execution, "AUTH-1");
    expect(answer.status).toBe("answered");
    expect(answer.citations).toEqual(["obs_a", "obs_b"]);
    expect(answer.claims).toHaveLength(2);
  });

  it("returns insufficient evidence, not prose, when nothing can be cited", () => {
    const empty: Execution = { cost: 2, results: [{ id: "s1", op: "find-entity", lookedFor: "ingrid eriksen", nodes, edges: [], events: [], coverage: [] }, { ...neighbors, edges: [] }], evidence: new Set() };
    const answer = synthesizeByRules(validatePlan({ steps: [{ id: "s1", op: "find-entity", text: "ingrid eriksen" }, { id: "s2", op: "neighbors-of", entity: { ref: "s1" } }] }), empty, "AUTH-1");
    expect(answer.status).toBe("insufficient-evidence");
    expect(answer.claims).toEqual([]);
    expect(answer.text).toContain('"ingrid eriksen"');
    expect(answer.text).toContain("#AUTH-1");
  });
});

describe("synthesizeWithModel", () => {
  const say = (text: string): ModelClient => ({ provider: "fake", complete: async () => ({ text, model: "m", provider: "fake" }) });

  it("keeps the model's claims only where they cite real evidence", async () => {
    const answer = await synthesizeWithModel(plan, execution, "AUTH-1", say('{"claims":[{"text":"Ingrid and Olu Eriksen share an address.","observationIds":["obs_a"]},{"text":"Ingrid owns a yacht.","observationIds":["obs_made_up"]}]}'));
    expect(answer.status).toBe("answered");
    expect(answer.synthesizedBy).toBe("model");
    expect(answer.claims.map((c) => c.text)).toEqual(["Ingrid and Olu Eriksen share an address.", expect.stringContaining("sources were consulted")]);
    expect(answer.citations).toEqual(["obs_a"]);
  });

  it("falls back to the rules when the model cites nothing real or does not answer", async () => {
    const invented = await synthesizeWithModel(plan, execution, "AUTH-1", say('{"claims":[{"text":"Ingrid owns a yacht.","observationIds":["obs_made_up"]}]}'));
    // Only the collection-log claim survives the model's reply, so the answer is that alone.
    expect(invented.claims.every((c) => c.basis === "collection-log")).toBe(true);
    const down: ModelClient = { provider: "fake", complete: async () => { throw new Error("down"); } };
    const fallback = await synthesizeWithModel(plan, execution, "AUTH-1", down);
    expect(fallback.synthesizedBy).toBe("rules");
    expect(fallback.citations).toEqual(["obs_a", "obs_b"]);
  });
});
