import { describe, expect, it } from "vitest";

import { styleIdsFor, toRemove } from "./teardown";

describe("toRemove", () => {
  it("removes a layer that was switched off", () => {
    expect(toRemove(["flights", "fires"], ["fires"])).toEqual(["flights"]);
  });

  it("leaves layers that are still on", () => {
    expect(toRemove(["flights", "fires"], ["flights", "fires"])).toEqual([]);
  });

  it("never touches a layer that was never drawn", () => {
    // The whole point of the change. The old sweep walked the catalogue, so
    // turning *anything* on called removeSource on all thirty of the layers
    // that were already off — synchronous teardown, on the paint path of a
    // click. Nothing drawn means nothing to remove.
    expect(toRemove([], ["flights"])).toEqual([]);
    expect(toRemove(["fires"], ["fires", "flights", "satellites"])).toEqual([]);
  });

  it("does not remove the same layer twice", () => {
    const drawn = new Set(["satellites"]);
    const first = toRemove(drawn, []);
    for (const id of first) drawn.delete(id);

    expect(first).toEqual(["satellites"]);
    expect(toRemove(drawn, [])).toEqual([]);
  });

  it("removes several at once, in the order they were drawn", () => {
    expect(toRemove(["a", "b", "c", "d"], ["b"])).toEqual(["a", "c", "d"]);
  });

  it("treats a re-enabled layer as still drawn", () => {
    // Off then on again inside one render pass: the layer is in `active`, so
    // it must survive rather than be torn down and rebuilt.
    expect(toRemove(new Set(["maritime"]), ["maritime"])).toEqual([]);
  });
});

describe("styleIdsFor", () => {
  it("names every style layer a feed can occupy", () => {
    // A source cannot be removed while any layer still references it, so
    // missing one of these leaves the source stuck on the map forever.
    expect(styleIdsFor("fires")).toEqual([
      "fires",
      "fires-endpoints",
      "fires-cluster",
      "fires-count",
    ]);
  });

  it("keeps the ids of two layers disjoint", () => {
    const a = new Set(styleIdsFor("sat"));
    const overlap = styleIdsFor("sat_comms").filter((id) => a.has(id));
    expect(overlap).toEqual([]);
  });
});
