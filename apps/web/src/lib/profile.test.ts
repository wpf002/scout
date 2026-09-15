import { describe, expect, it } from "vitest";

import { buildProfile } from "./profile";
import type { ResultRow } from "./flatten";

const row = (over: Partial<ResultRow> & Pick<ResultRow, "type" | "value">): ResultRow => ({
  detail: "",
  sources: ["one"],
  occurrences: 1,
  url: null,
  evidence: [],
  ...over,
});

describe("buildProfile", () => {
  it("ranks a value by how many independent sources reported it", () => {
    const profile = buildProfile([
      row({ type: "Hosts", value: "a.example", sources: ["crt.sh"] }),
      row({ type: "Hosts", value: "b.example", sources: ["crt.sh", "certspotter", "shodan"] }),
      row({ type: "Hosts", value: "c.example", sources: ["crt.sh", "shodan"] }),
    ]);

    expect(profile.corroborated.map((c) => c.value)).toEqual(["b.example", "c.example"]);
    expect(profile.reach.corroborated).toBe(2);
  });

  it("leaves a single-source value out of the corroborated list", () => {
    const profile = buildProfile([row({ type: "Hosts", value: "only.example" })]);
    expect(profile.corroborated).toEqual([]);
    expect(profile.reach.values).toBe(1);
  });

  it("counts distinct sources across every row, not per row", () => {
    const profile = buildProfile([
      row({ type: "Hosts", value: "a", sources: ["crt.sh", "shodan"] }),
      row({ type: "Emails", value: "b", sources: ["shodan", "hunter"] }),
    ]);
    expect(profile.reach.sourcesAnswering).toBe(3);
  });

  it("flags two sources disagreeing on one single-valued field", () => {
    const profile = buildProfile([
      row({ type: "Registration", value: "Tucows", detail: "Registrar: Tucows", sources: ["whois"] }),
      row({ type: "Registration", value: "GoDaddy", detail: "Registrar: GoDaddy", sources: ["rdap"] }),
    ]);

    expect(profile.conflicts).toHaveLength(1);
    expect(profile.conflicts[0]?.field).toBe("Registrar");
    expect(profile.conflicts[0]?.claims.map((c) => c.value).sort()).toEqual(["GoDaddy", "Tucows"]);
  });

  it("does not call two subdomains a conflict", () => {
    const profile = buildProfile([
      row({ type: "Subdomains", value: "a.example", detail: "Host: a.example" }),
      row({ type: "Subdomains", value: "b.example", detail: "Host: b.example" }),
    ]);
    expect(profile.conflicts).toEqual([]);
  });

  it("offers pivots without repeating a value that differs only in case", () => {
    const profile = buildProfile([
      row({ type: "Emails", value: "J@acme.example" }),
      row({ type: "Emails", value: "j@acme.example" }),
      row({ type: "Registration", value: "not-pivotable" }),
    ]);

    expect(profile.pivots).toHaveLength(1);
    expect(profile.pivots[0]?.value).toBe("J@acme.example");
  });

  it("returns empty structures for no rows rather than throwing", () => {
    const profile = buildProfile([]);
    expect(profile.reach).toEqual({ sourcesAnswering: 0, values: 0, corroborated: 0 });
    expect(profile.pivots).toEqual([]);
  });
});
