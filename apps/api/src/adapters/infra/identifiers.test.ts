import { describe, expect, it } from "vitest";

import { describePhone, describePlate, describeVessel } from "./identifiers.js";

/** Narrows to the one observation kind these adapters emit. */
function registrar(observations: ReturnType<typeof describeVessel>): string | null {
  const first = observations[0];
  if (first === undefined || first.kind !== "registration") return null;
  return first.registrar;
}

describe("describeVessel", () => {
  it("accepts an IMO number whose check digit is valid", () => {
    expect(registrar(describeVessel("IMO9074729"))).toContain("check digit valid");
  });

  it("says nothing about an IMO number that fails its check digit", () => {
    expect(describeVessel("IMO9074728")).toEqual([]);
  });

  it("names the flag state from the MMSI's MID", () => {
    expect(registrar(describeVessel("366999712"))).toContain("United States");
    expect(registrar(describeVessel("232123456"))).toContain("United Kingdom");
  });

  it("reports the MID rather than guessing when it is not in the table", () => {
    const line = registrar(describeVessel("299123456"));
    expect(line).toContain("299");
    expect(line).toContain("not in table");
  });

  it("returns nothing for a number that is neither", () => {
    expect(describeVessel("12345")).toEqual([]);
  });
});

describe("describePhone", () => {
  it("names the country from the dialling code", () => {
    expect(registrar(describePhone("+442079460958"))).toContain("United Kingdom");
    expect(registrar(describePhone("+15550109999"))).toContain("United States");
  });

  it("prefers the longest matching prefix", () => {
    // 972 is Israel and must win over a bare 9-something match.
    expect(registrar(describePhone("+972501234567"))).toContain("Israel");
  });

  it("says so rather than guessing when the code is unrecognised", () => {
    expect(registrar(describePhone("+9991234567"))).toContain("not recognised");
  });

  it("ignores anything too short to be a number", () => {
    expect(describePhone("12345")).toEqual([]);
  });
});

describe("describePlate", () => {
  it("states that there is no lawful free source rather than returning empty", () => {
    const line = registrar(describePlate("7ABC123"));
    expect(line).toContain("No public registry");
    expect(line).toContain("DPPA");
  });

  it("marks the result so a reader cannot mistake it for 'no record found'", () => {
    const first = describePlate("7ABC123")[0];
    if (first === undefined || first.kind !== "registration") throw new Error("expected one");
    expect(first.statuses).toContain("no-public-source");
  });

  it("returns nothing for an empty plate", () => {
    expect(describePlate("   ")).toEqual([]);
  });
});
