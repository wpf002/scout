import { describe, expect, it } from "vitest";
import { buildGraph } from "./graph";
import type { ResultRow } from "./flatten";

const row = (over: Partial<ResultRow>): ResultRow => ({
  type: "Subdomains",
  value: "a.example.com",
  detail: "",
  sources: ["crt.sh"],
  occurrences: 1,
  url: null,
  evidence: [],
  ...over,
});

describe("building the graph", () => {
  it("puts the subject at the centre", () => {
    const graph = buildGraph([row({})], "example.com");
    const subject = graph.nodes.find((n) => n.id === "subject");

    expect(subject?.label).toBe("example.com");
    expect(subject?.x).toBe(graph.width / 2);
    expect(subject?.y).toBe(graph.height / 2);
  });

  it("connects every entity to the subject", () => {
    const graph = buildGraph(
      [row({ value: "a.example.com" }), row({ value: "b.example.com" })],
      "example.com",
    );
    const spokes = graph.edges.filter((e) => e.from === "subject");
    expect(spokes).toHaveLength(2);
    // The edge says who reported it, not just that it exists.
    expect(spokes[0]?.reason).toContain("crt.sh");
  });

  it("joins a host to the names that resolve to it", () => {
    // The relationship the table cannot express, and the reason for the graph.
    const graph = buildGraph(
      [
        row({
          type: "Hosts",
          value: "1.2.3.4",
          evidence: [
            {
              source: "Shodan",
              observation: { kind: "host", hostnames: ["a.example.com"] },
            },
          ],
        }),
        row({ value: "a.example.com" }),
      ],
      "example.com",
    );

    const link = graph.edges.find(
      (e) => e.from === "Hosts:1.2.3.4" && e.to === "Subdomains:a.example.com",
    );
    expect(link).toBeDefined();
    expect(link?.reason).toContain("resolves to");
  });

  it("sizes a node by how many sources corroborate it", () => {
    const graph = buildGraph(
      [
        row({ value: "one.example.com", sources: ["a"] }),
        row({ value: "many.example.com", sources: ["a", "b", "c"] }),
      ],
      "example.com",
    );

    const one = graph.nodes.find((n) => n.label === "one.example.com");
    const many = graph.nodes.find((n) => n.label === "many.example.com");
    expect(many!.radius).toBeGreaterThan(one!.radius);
  });

  it("caps a cluster and reports what it dropped", () => {
    // 400 subdomains drawn at once is a black disc, not a graph. What is not
    // drawn has to be stated — a silently truncated picture reads as complete.
    const many = Array.from({ length: 40 }, (_, i) =>
      row({ value: `host${i}.example.com` }),
    );
    const graph = buildGraph(many, "example.com");

    expect(graph.nodes.filter((n) => n.type === "Subdomains")).toHaveLength(14);
    expect(graph.omitted).toEqual([{ type: "Subdomains", count: 26 }]);
  });

  it("leaves room for other types when one is huge", () => {
    // The failure mode this guards: 400 subdomains eating the whole budget so
    // the two emails and one threat pulse — the findings that matter most —
    // never get drawn at all.
    const rows = [
      ...Array.from({ length: 200 }, (_, i) =>
        row({ value: `host${i}.example.com` }),
      ),
      row({ type: "Emails", value: "a@example.com" }),
      row({ type: "Threat Intel", value: "Some Pulse" }),
    ];
    const graph = buildGraph(rows, "example.com");

    expect(graph.nodes.some((n) => n.type === "Emails")).toBe(true);
    expect(graph.nodes.some((n) => n.type === "Threat Intel")).toBe(true);
  });

  it("fits the frame to where the nodes actually landed", () => {
    // A fixed viewBox clipped every outer label, because a label is drawn
    // beyond its node and nothing accounted for its width.
    const graph = buildGraph(
      [row({ value: "a.example.com" }), row({ value: "b.example.com" })],
      "example.com",
    );
    const [x, y, w, h] = graph.viewBox.split(" ").map(Number);

    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThan(x!);
      expect(node.x).toBeLessThan(x! + w!);
      expect(node.y).toBeGreaterThan(y!);
      expect(node.y).toBeLessThan(y! + h!);
    }
  });

  it("keeps the best-corroborated when it caps", () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) =>
        row({ value: `weak${i}.example.com`, sources: ["a"] }),
      ),
      row({ value: "strong.example.com", sources: ["a", "b", "c"] }),
    ];
    const graph = buildGraph(rows, "example.com");

    expect(graph.nodes.some((n) => n.label === "strong.example.com")).toBe(true);
  });

  it("draws the same picture for the same data", () => {
    // Deterministic on purpose: a force layout settles somewhere different
    // every run, so an investigator cannot return to a graph they were reading.
    const rows = [row({ value: "a.example.com" }), row({ value: "b.example.com" })];
    const first = buildGraph(rows, "example.com");
    const second = buildGraph(rows, "example.com");

    expect(first.nodes.map((n) => [n.id, n.x, n.y])).toEqual(
      second.nodes.map((n) => [n.id, n.x, n.y]),
    );
  });
});
