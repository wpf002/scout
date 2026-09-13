import { describe, expect, it } from "vitest";

import { compareFields, describeScore, explainFeatures, handleOf } from "./review";
import type { ReviewObservation } from "./v2";

const left: ReviewObservation = {
  id: "L", sourceId: "synth-broker", observedAt: "2026-06-04T11:52:15Z",
  identifiers: [{ kind: "NAME", value: "Amara Okaor" }, { kind: "PHONE", value: "+1 (415) 555-5189" }],
  payload: { name: "Amara Okaor", phone: "+1 (415) 555-5189", handle: "@amaraokafor" },
};
const right: ReviewObservation = {
  id: "R", sourceId: "synth-records", observedAt: "2026-06-28T14:34:40Z",
  identifiers: [{ kind: "NAME", value: "Amara Okafor" }, { kind: "PHONE", value: "14155555189" }],
  payload: { name: "Amara Okafor", phone: "14155555189", address: "817 Granite St", city: "Valparaíso" },
};

describe("compareFields", () => {
  it("lines up identifiers first, then payload, and says which side is missing", () => {
    const rows = compareFields(left, right);
    expect(rows.map((r) => r.field)).toEqual(["name", "phone", "handle", "address", "city"]);
    expect(rows.find((r) => r.field === "name")?.agreement).toBe("differs");
    expect(rows.find((r) => r.field === "phone")?.agreement).toBe("same");
    expect(rows.find((r) => r.field === "handle")).toMatchObject({ left: "@amaraokafor", right: null, agreement: "one-sided" });
    expect(rows.find((r) => r.field === "city")).toMatchObject({ left: null, right: "Valparaíso", agreement: "one-sided" });
  });

  it("copes with a side that could not be loaded", () => {
    expect(compareFields(left, null).every((r) => r.agreement === "one-sided")).toBe(true);
  });
});

describe("explainFeatures", () => {
  it("orders columns by how much they moved the score and words each one", () => {
    const rows = explainFeatures({
      levels: { first_last: 4, email: -1, phone: 0, city: 1 },
      bayes_factors: { first_last: 811.59, email: 1, phone: 0.04, city: 2.5 },
    });
    expect(rows.map((r) => r.column)).toEqual(["first last", "phone", "city", "email"]);
    expect(rows[0]).toMatchObject({ finding: "match level 4", weight: "×812 for", direction: "for" });
    expect(rows[1]).toMatchObject({ finding: "no match", weight: "÷25.0 against", direction: "against" });
    expect(rows[3]).toMatchObject({ finding: "not comparable: missing on one side", weight: "no evidence", direction: "none" });
  });

  it("describes the score with its basis points and weight", () => {
    expect(describeScore(8833, { match_weight: 2.9203 })).toBe("88% (8 833 bp) · weight 2.92");
    expect(describeScore(null, {})).toBe("");
  });
});

describe("handleOf", () => {
  it("prefers a name, then the first identifier, then the source", () => {
    expect(handleOf(left)).toBe("Amara Okaor");
    expect(handleOf({ ...left, identifiers: [{ kind: "MMSI", value: "316071400" }], payload: {} })).toBe("mmsi 316071400");
    expect(handleOf({ ...left, identifiers: [], payload: {} })).toBe("synth-broker");
    expect(handleOf(null)).toBe("unknown");
  });
});
