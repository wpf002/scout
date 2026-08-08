/**
 * Phase 6 exit-gate tests.
 *
 * The gate: a case with hits from 3+ sources renders a deduped entity graph
 * with traceable edges. "Traceable" is the load-bearing word, so it is
 * asserted directly — every edge must name findings that exist on the case.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
let caseId: string;
const findingIds: string[] = [];

async function saveFinding(
  sourceId: string,
  title: string,
  data: unknown,
  queryKind = "domain",
  queryTerm = "example.com",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/cases/${caseId}/findings`,
    payload: { sourceId, title, queryTerm, queryKind, data },
  });
  const id = response.json().id;
  findingIds.push(id);
  return id;
}

run("Scout entity graph — Phase 6", () => {
  beforeAll(async () => {
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Graph",
        authorizationRef: `GRAPH-${Date.now()}`,
        scope: [{ kind: "domain", value: "example.com" }],
      },
    });
    caseId = created.json().id;

    // The same host, reported by three different sources — the overlap the
    // whole phase exists to surface.
    await saveFinding("crtsh", "www in CT logs", {
      kind: "subdomain",
      hostname: "WWW.Example.com",
    });
    await saveFinding("securitytrails", "www in DNS history", {
      kind: "subdomain",
      hostname: "www.example.com",
    });
    await saveFinding("shodan", "host 203.0.113.10", {
      kind: "host",
      ip: "203.0.113.10",
      hostnames: ["www.example.com"],
    });
    await saveFinding("crtsh", "cert for example.com", {
      kind: "cert",
      serial: "04a1",
      commonName: "example.com",
      names: ["example.com", "www.example.com", "*.example.com"],
    });
    await saveFinding(
      "opensanctions",
      "Acme Ltd designated",
      { kind: "sanction-match", caption: "Acme Ltd.", schema: "Company" },
      "company",
      "Acme",
    );
    await saveFinding(
      "intelligence-x",
      "ACME LIMITED in leak",
      { kind: "sanction-match", caption: "ACME LIMITED", schema: "Company" },
      "company",
      "Acme",
    );
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  describe("the exit gate", () => {
    it("renders a deduped graph from 3+ sources", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/graph`,
      });
      expect(response.statusCode).toBe(200);

      const graph = response.json();
      expect(graph.totals.sources).toBeGreaterThanOrEqual(3);
      expect(graph.totals.corroborated).toBeGreaterThan(0);

      const www = graph.entities.find(
        (e: { value: string }) => e.value === "www.example.com",
      );
      // Reported by three sources under two spellings; one entity.
      expect(www.sourceIds.sort()).toEqual([
        "crtsh",
        "securitytrails",
        "shodan",
      ]);
    });

    it("makes every edge traceable to findings on this case", async () => {
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();

      expect(graph.links.length).toBeGreaterThan(0);
      const known = new Set(findingIds);
      for (const link of graph.links) {
        expect(link.findingIds.length).toBeGreaterThan(0);
        for (const id of link.findingIds) {
          // An edge citing a finding that does not exist would be a claim
          // with no evidence behind it.
          expect(known.has(id), `${link.relation} cites unknown ${id}`).toBe(
            true,
          );
        }
        expect(link.sourceIds.length).toBeGreaterThan(0);
      }
    });

    it("makes every entity traceable too", async () => {
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const known = new Set(findingIds);
      for (const entity of graph.entities) {
        expect(entity.findingIds.length).toBeGreaterThan(0);
        for (const id of entity.findingIds) expect(known.has(id)).toBe(true);
      }
    });

    it("relates a hostname to the address it resolves to", async () => {
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const resolves = graph.links.find(
        (l: { relation: string }) => l.relation === "resolves-to",
      );
      expect(resolves.from).toBe("domain:www.example.com");
      expect(resolves.to).toBe("ip:203.0.113.10");
    });
  });

  describe("near matches wait for a decision", () => {
    it("does not merge two spellings of a company name on its own", async () => {
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const companies = graph.entities.filter(
        (e: { kind: string }) => e.kind === "company",
      );
      expect(companies.length).toBeGreaterThanOrEqual(2);
      expect(graph.suggestions.length).toBeGreaterThan(0);
    });

    it("requires an explicit confirmation and a reason to merge", async () => {
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const [suggestion] = graph.suggestions;

      const noConfirm = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/graph/merge`,
        payload: {
          winningKey: suggestion.left,
          losingKey: suggestion.right,
          reason: "same company",
        },
      });
      expect(noConfirm.statusCode).toBe(400);

      const noReason = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/graph/merge`,
        payload: {
          winningKey: suggestion.left,
          losingKey: suggestion.right,
          confirm: true,
        },
      });
      expect(noReason.statusCode).toBe(400);
    });

    it("refuses to merge an entity that is not in the graph", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/graph/merge`,
        payload: {
          winningKey: "company:acme ltd.",
          losingKey: "company:does-not-exist",
          reason: "x",
          confirm: true,
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("unions evidence when a merge is confirmed, and audits it", async () => {
      const before = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const [suggestion] = before.suggestions;

      const merged = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/graph/merge`,
        payload: {
          winningKey: suggestion.left,
          losingKey: suggestion.right,
          reason: "Same company, differing suffix.",
          confirm: true,
        },
      });
      expect(merged.statusCode).toBe(200);

      const after = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const survivor = after.entities.find(
        (e: { key: string }) => e.key === suggestion.left,
      );
      expect(survivor.sourceIds.sort()).toEqual([
        "intelligence-x",
        "opensanctions",
      ]);
      expect(
        after.entities.some((e: { key: string }) => e.key === suggestion.right),
      ).toBe(false);

      // A merge asserts two records describe one company. That belongs in the
      // case record.
      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "graph.merged" },
      });
      expect(event?.detail).toMatchObject({
        reason: "Same company, differing suffix.",
      });
    });

    it("survives a rebuild — the decision persists, the graph does not", async () => {
      const merge = await prisma.entityMerge.findFirst({ where: { caseId } });
      if (merge === null) throw new Error("expected a stored merge");

      // The graph is recomputed from findings on every read, so this is a
      // genuinely fresh build. The merged-away key must still be gone, and
      // its evidence must still be on the survivor.
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();

      expect(
        graph.entities.some((e: { key: string }) => e.key === merge.losingKey),
      ).toBe(false);
      const survivor = graph.entities.find(
        (e: { key: string }) => e.key === merge.winningKey,
      );
      expect(survivor.sourceIds.sort()).toEqual([
        "intelligence-x",
        "opensanctions",
      ]);
    });

    it("can be undone", async () => {
      const merge = await prisma.entityMerge.findFirst({ where: { caseId } });
      if (merge === null) throw new Error("expected a stored merge");

      const undone = await app.inject({
        method: "DELETE",
        url: `/cases/${caseId}/graph/merge/${encodeURIComponent(merge.losingKey)}`,
      });
      expect(undone.statusCode).toBe(204);

      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      expect(
        graph.entities.filter((e: { kind: string }) => e.kind === "company")
          .length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("stops offering a dismissed suggestion", async () => {
      const before = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      const [suggestion] = before.suggestions;

      await app.inject({
        method: "POST",
        url: `/cases/${caseId}/graph/dismiss`,
        payload: { suggestionId: suggestion.id },
      });

      const after = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();
      expect(
        after.suggestions.some((s: { id: string }) => s.id === suggestion.id),
      ).toBe(false);
    });
  });

  describe("the summary is a draft, not a finding", () => {
    it("is marked draft and cites only real findings", async () => {
      const graph = (
        await app.inject({ method: "GET", url: `/cases/${caseId}/graph` })
      ).json();

      expect(graph.summary.draft).toBe(true);
      expect(graph.summary.producedBy).toBe("deterministic");
      const known = new Set(findingIds);
      for (const id of graph.summary.citedFindingIds) {
        expect(known.has(id)).toBe(true);
      }
    });

    it("is never written to the findings table", async () => {
      const findings = await prisma.finding.findMany({ where: { caseId } });
      // A summary is something someone wrote about the findings, not a
      // finding a source reported.
      expect(findings.every((f) => f.sourceId !== "summary")).toBe(true);
      expect(findings).toHaveLength(findingIds.length);
    });
  });

  describe("an empty case", () => {
    it("returns an empty graph rather than failing", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/cases",
        payload: { name: "Empty", authorizationRef: `EMPTY-${Date.now()}` },
      });
      const response = await app.inject({
        method: "GET",
        url: `/cases/${created.json().id}/graph`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().entities).toEqual([]);
      expect(response.json().summary.paragraphs.length).toBeGreaterThan(0);
    });

    it("404s for a case that does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/cases/nope/graph",
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
