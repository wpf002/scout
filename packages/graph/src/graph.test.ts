import { describe, expect, it } from "vitest";
import { extractAll, extractFromFinding } from "./extract.js";
import { applyMerges, buildGraph, suggestMerges } from "./resolve.js";
import {
  assertNoInventedProvenance,
  summarizeCase,
  summarizeDeterministically,
} from "./summary.js";
import type { CaseSummary, FindingInput } from "./types.js";

const finding = (
  id: string,
  sourceId: string,
  data: unknown,
  overrides: Partial<FindingInput> = {},
): FindingInput => ({
  id,
  sourceId,
  queryTerm: "example.com",
  queryKind: "domain",
  observedAt: "2026-01-01T00:00:00.000Z",
  title: id,
  data,
  ...overrides,
});

describe("extraction carries provenance on everything", () => {
  it("emits no entity without a finding and a source", () => {
    const result = extractFromFinding(
      finding("f1", "crtsh", { kind: "subdomain", hostname: "www.example.com" }),
    );
    for (const mention of result.mentions) {
      expect(mention.findingId).toBe("f1");
      expect(mention.sourceId).toBe("crtsh");
    }
    for (const link of result.links) {
      expect(link.findingId).toBe("f1");
      expect(link.sourceId).toBe("crtsh");
    }
  });

  it("treats the query subject as an entity, which is what ties sources together", () => {
    const result = extractFromFinding(
      finding("f1", "shodan", { kind: "host", ip: "203.0.113.10", hostnames: [] }),
    );
    const values = result.mentions.map((m) => m.entity.value);
    expect(values).toContain("example.com");
  });

  it("links a host to every hostname that resolves to it", () => {
    const result = extractFromFinding(
      finding("f1", "shodan", {
        kind: "host",
        ip: "203.0.113.10",
        hostnames: ["www.example.com", "mail.example.com"],
      }),
    );
    const resolves = result.links.filter((l) => l.relation === "resolves-to");
    expect(resolves).toHaveLength(2);
    expect(resolves.every((l) => l.to.value === "203.0.113.10")).toBe(true);
  });

  it("keeps a wildcard on the certificate rather than making it a host", () => {
    const result = extractFromFinding(
      finding("f1", "crtsh", {
        kind: "cert",
        serial: "04a1",
        commonName: "example.com",
        names: ["example.com", "*.example.com"],
      }),
    );
    // A wildcard is not a host you can resolve.
    expect(result.mentions.some((m) => m.entity.value.startsWith("*"))).toBe(
      false,
    );
  });

  it("links a credential record to its breach without carrying the credential", () => {
    const result = extractFromFinding(
      finding("f1", "dehashed", {
        kind: "credential-record",
        databaseName: "ExampleBreach",
        email: "bob@example.com",
        username: "bob",
        password: "hunter2",
        hasPassword: true,
      }),
    );
    const exposed = result.links.filter((l) => l.relation === "exposed-in");
    expect(exposed).toHaveLength(2);
    // The graph records that an exposure exists, never the secret itself.
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("ignores a payload it does not recognize rather than guessing", () => {
    const result = extractFromFinding(
      finding("f1", "mystery", { kind: "something-new", value: "x" }),
    );
    // Only the query subject, nothing invented from the unknown shape.
    expect(result.mentions).toHaveLength(1);
  });

  it("survives a missing or malformed payload", () => {
    expect(() => extractFromFinding(finding("f1", "x", null))).not.toThrow();
    expect(() => extractFromFinding(finding("f1", "x", "not an object"))).not.toThrow();
    expect(() => extractFromFinding(finding("f1", "x", { kind: "host" }))).not.toThrow();
  });
});

describe("resolution merges on exact identity only", () => {
  const findings = [
    finding("f1", "crtsh", { kind: "subdomain", hostname: "WWW.Example.com" }),
    finding("f2", "securitytrails", {
      kind: "subdomain",
      hostname: "www.example.com",
    }),
    finding("f3", "shodan", {
      kind: "host",
      ip: "203.0.113.10",
      hostnames: ["www.example.com"],
    }),
  ];

  const graph = buildGraph(extractAll(findings));

  it("folds the same host from three sources into one entity", () => {
    const www = graph.entities.find((e) => e.value === "www.example.com");
    expect(www).toBeDefined();
    expect(www?.sourceIds.sort()).toEqual([
      "crtsh",
      "securitytrails",
      "shodan",
    ]);
  });

  it("counts corroboration — the number the exit gate cares about", () => {
    expect(graph.corroborated).toBeGreaterThan(0);
  });

  it("keeps every finding that evidences an entity", () => {
    const www = graph.entities.find((e) => e.value === "www.example.com");
    expect(www?.findingIds.sort()).toEqual(["f1", "f2", "f3"]);
  });

  it("never creates an edge to an entity that has no mention", () => {
    for (const link of graph.links) {
      expect(graph.entities.some((e) => e.key === link.from)).toBe(true);
      expect(graph.entities.some((e) => e.key === link.to)).toBe(true);
    }
  });

  it("does not merge different entities that merely look similar", () => {
    const similar = buildGraph(
      extractAll([
        finding("f1", "a", { kind: "subdomain", hostname: "www.example.com" }),
        finding("f2", "b", { kind: "subdomain", hostname: "www.example.co" }),
      ]),
    );
    const hosts = similar.entities.filter((e) => e.kind === "domain");
    expect(hosts.length).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic across runs", () => {
    const again = buildGraph(extractAll(findings));
    expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
  });
});

describe("near matches are suggested, never merged", () => {
  const graph = buildGraph(
    extractAll([
      finding("f1", "opensanctions", {
        kind: "sanction-match",
        caption: "Acme Ltd.",
        schema: "Company",
      }, { queryKind: "company", queryTerm: "Acme" }),
      finding("f2", "opencorporates", {
        kind: "sanction-match",
        caption: "ACME LIMITED",
        schema: "Company",
      }, { queryKind: "company", queryTerm: "Acme" }),
      finding("f3", "opensanctions", {
        kind: "sanction-match",
        caption: "Jane Designated",
        schema: "Person",
      }, { queryKind: "person", queryTerm: "Jane" }),
      finding("f4", "intelligence-x", {
        kind: "sanction-match",
        caption: "Jane Designated Jr",
        schema: "Person",
      }, { queryKind: "person", queryTerm: "Jane" }),
    ]),
  );

  it("leaves near matches unmerged in the graph", () => {
    // Both spellings survive as separate entities until someone decides.
    const companies = graph.entities.filter((e) => e.kind === "company");
    expect(companies.length).toBeGreaterThanOrEqual(2);
  });

  const suggestions = suggestMerges(graph);

  it("suggests the company pair once suffixes and case are ignored", () => {
    const match = suggestions.find((s) => s.kind === "company");
    expect(match).toBeDefined();
    expect(match?.confidence).toBeGreaterThan(0.8);
  });

  it("suggests the person pair at lower confidence, with a reason", () => {
    const match = suggestions.find((s) => s.kind === "person");
    expect(match).toBeDefined();
    expect(match?.confidence).toBeLessThan(0.8);
    expect(match?.reason.length).toBeGreaterThan(0);
  });

  it("suggests nothing for unrelated names", () => {
    const unrelated = buildGraph(
      extractAll([
        finding("f1", "a", { kind: "sanction-match", caption: "Jane Designated", schema: "Person" }, { queryKind: "person" }),
        finding("f2", "b", { kind: "sanction-match", caption: "Robert Unrelated", schema: "Person" }, { queryKind: "person" }),
      ]),
    );
    expect(suggestMerges(unrelated)).toEqual([]);
  });

  it("does not suggest on a single shared first name", () => {
    // One token in common is not evidence, and this is exactly the heuristic
    // that would need real data to calibrate.
    const weak = buildGraph(
      extractAll([
        finding("f1", "a", { kind: "sanction-match", caption: "Jane Smith", schema: "Person" }, { queryKind: "person" }),
        finding("f2", "b", { kind: "sanction-match", caption: "Jane", schema: "Person" }, { queryKind: "person" }),
      ]),
    );
    expect(suggestMerges(weak)).toEqual([]);
  });

  it("gives stable suggestion ids, so a dismissal can stick", () => {
    expect(suggestMerges(graph).map((s) => s.id)).toEqual(
      suggestions.map((s) => s.id),
    );
  });
});

describe("applying a confirmed merge", () => {
  const graph = buildGraph(
    extractAll([
      finding("f1", "a", { kind: "sanction-match", caption: "Acme Ltd.", schema: "Company" }, { queryKind: "company" }),
      finding("f2", "b", { kind: "sanction-match", caption: "ACME LIMITED", schema: "Company" }, { queryKind: "company" }),
    ]),
  );

  it("unions evidence rather than discarding half of it", () => {
    const [suggestion] = suggestMerges(graph);
    if (suggestion === undefined) throw new Error("expected a suggestion");

    const merged = applyMerges(
      graph,
      new Map([[suggestion.right, suggestion.left]]),
    );
    const survivor = merged.entities.find((e) => e.key === suggestion.left);
    expect(survivor?.sourceIds.sort()).toEqual(["a", "b"]);
    expect(survivor?.findingIds.sort()).toEqual(["f1", "f2"]);
    expect(merged.entities.some((e) => e.key === suggestion.right)).toBe(false);
  });

  it("drops self-loops a merge creates", () => {
    const merged = applyMerges(
      graph,
      new Map(graph.entities.slice(1).map((e) => [e.key, graph.entities[0]!.key])),
    );
    expect(merged.links.every((l) => l.from !== l.to)).toBe(true);
  });

  it("follows merge chains without looping forever", () => {
    const merged = applyMerges(
      graph,
      new Map([
        ["company:a", "company:b"],
        ["company:b", "company:a"],
      ]),
    );
    expect(merged.entities.length).toBeGreaterThan(0);
  });

  it("is a no-op with no merges", () => {
    expect(applyMerges(graph, new Map())).toBe(graph);
  });
});

describe("summaries are drafts that cannot invent provenance", () => {
  const findings = [
    finding("f1", "crtsh", { kind: "subdomain", hostname: "www.example.com" }),
    finding("f2", "shodan", {
      kind: "host",
      ip: "203.0.113.10",
      hostnames: ["www.example.com"],
    }),
  ];
  const graph = buildGraph(extractAll(findings));

  it("counts rather than composes, so nothing is invented", () => {
    const summary = summarizeDeterministically(graph, findings);
    expect(summary.draft).toBe(true);
    expect(summary.producedBy).toBe("deterministic");
    expect(summary.paragraphs.join(" ")).toContain("crtsh");
  });

  it("says plainly when nothing is corroborated", () => {
    const single = [finding("f1", "crtsh", { kind: "subdomain", hostname: "a.example.com" })];
    const summary = summarizeDeterministically(
      buildGraph(extractAll(single)),
      single,
    );
    expect(summary.paragraphs.join(" ")).toMatch(/not corroborated|single-source/i);
  });

  it("rejects a summary citing a finding that does not exist", () => {
    const forged: CaseSummary = {
      draft: true,
      producedBy: "some-model",
      generatedAt: "2026-01-01T00:00:00.000Z",
      headline: "x",
      paragraphs: [],
      citedFindingIds: ["f1", "does-not-exist"],
    };
    expect(() => assertNoInventedProvenance(forged, findings)).toThrow(
      /do not exist/i,
    );
  });

  it("rejects a summary not marked as a draft", () => {
    const promoted = {
      ...summarizeDeterministically(graph, findings),
      draft: false,
    } as unknown as CaseSummary;
    expect(() => assertNoInventedProvenance(promoted, findings)).toThrow(
      /draft/i,
    );
  });

  it("falls back to the counted summary when no summarizer is configured", async () => {
    const summary = await summarizeCase(graph, findings, null);
    expect(summary.producedBy).toBe("deterministic");
  });

  it("validates a configured summarizer's output", async () => {
    await expect(
      summarizeCase(graph, findings, {
        name: "liar",
        summarize: async () => ({
          draft: true as const,
          producedBy: "liar",
          generatedAt: "2026-01-01T00:00:00.000Z",
          headline: "invented",
          paragraphs: [],
          citedFindingIds: ["fabricated"],
        }),
      }),
    ).rejects.toThrow(/do not exist/i);
  });
});
