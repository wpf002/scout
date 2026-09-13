import { describe, expect, it } from "vitest";

import { qualify } from "./alerts";

describe("qualify", () => {
  it("drops a category the label already leads with", () => {
    // The bug as reported: "Earthquake Earthquake — Indonesia" in the ticker.
    expect(qualify("Earthquake", "Earthquake — Indonesia")).toBe(
      "Earthquake — Indonesia",
    );
    expect(qualify("Flood", "Flood — Nepal")).toBe("Flood — Nepal");
  });

  it("keeps a category the label does not repeat", () => {
    // EONET names some events by type and some by their own name, and the
    // second form needs the category or the row says nothing.
    expect(qualify("Drought", "Madagascar-2026")).toBe("Drought  Madagascar-2026");
    expect(qualify("Tropical Cyclone", "SAUDEL-26")).toBe(
      "Tropical Cyclone  SAUDEL-26",
    );
    expect(qualify("M5.2", "35 km SE of Sarangani")).toBe(
      "M5.2  35 km SE of Sarangani",
    );
  });

  it("matches on a word boundary, not a prefix", () => {
    // "Flood" must not be swallowed by a label about a floodplain.
    expect(qualify("Flood", "Floodplain survey")).toBe("Flood  Floodplain survey");
    expect(qualify("Ice", "Iceland-2026")).toBe("Ice  Iceland-2026");
  });

  it("ignores case when deciding it repeats", () => {
    expect(qualify("Wildfire", "WILDFIRE — Australia")).toBe("WILDFIRE — Australia");
  });

  it("treats the label alone as a repeat", () => {
    expect(qualify("Drought", "Drought")).toBe("Drought");
  });

  it("keeps the label alone when there is no category", () => {
    // Not "  Something happened" — a missing category must not leave the
    // indent it would have occupied.
    expect(qualify("", "Something happened")).toBe("Something happened");
  });
});
