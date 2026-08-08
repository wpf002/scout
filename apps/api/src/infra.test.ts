/**
 * Phase 3 exit-gate tests.
 *
 * Upstream `fetch` is stubbed with fixture payloads, so the full route —
 * adapter, normalizer, dedupe, audit row, provenance — runs end to end without
 * touching a third party or needing a real key. The normalizers themselves are
 * covered separately in adapters/infra/normalize.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";
import { clearResponseCache } from "./adapters/base.js";
import { infraRateLimiter } from "./lib/ratelimit.js";

// The structural guarantees around this tier — no scoped source in the
// adapter set, no deeplink source with an execution route — live in
// invariants.test.ts, alongside the other locked invariants.

// ── route-level, against a real database ─────────────────────────────────
const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

const CRTSH_ROWS = [
  {
    common_name: "example.com",
    name_value: "example.com\nwww.example.com\n*.example.com",
    issuer_name: "C=US, O=Let's Encrypt, CN=R3",
    serial_number: "04a1",
    not_before: "2026-01-01T00:00:00",
    not_after: "2026-04-01T00:00:00",
  },
];

const SHODAN_DOMAIN = {
  domain: "example.com",
  subdomains: ["www", "vpn"],
  data: [
    { subdomain: "www", type: "A", value: "203.0.113.10", last_seen: "2026-01-05" },
  ],
};

const ST_SUBDOMAINS = { subdomains: ["www", "admin"] };

const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.startsWith("https://crt.sh/")) return json(CRTSH_ROWS);
    if (url.startsWith("https://api.shodan.io/")) return json(SHODAN_DOMAIN);
    if (url.startsWith("https://api.securitytrails.com/")) {
      return json(ST_SUBDOMAINS);
    }
    throw new Error(`unexpected upstream call: ${url}`);
  }) as typeof fetch;
}

let app: FastifyInstance;
let caseId: string;

run("Scout infrastructure tier", () => {
  beforeAll(async () => {
    process.env["SHODAN_API_KEY"] = "test-shodan-key";
    process.env["SECURITYTRAILS_API_KEY"] = "test-st-key";
    // Censys is deliberately left keyless, so a sweep shows a live source and
    // an inert one side by side.
    delete process.env["CENSYS_API_KEY"];

    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Infra sweep",
        authorizationRef: `INFRA-${Date.now()}`,
        scope: [{ kind: "domain", value: "example.com" }],
      },
    });
    caseId = created.json().id;
  });

  beforeEach(() => {
    stubFetch();
    clearResponseCache();
    infraRateLimiter.reset();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    delete process.env["SHODAN_API_KEY"];
    delete process.env["SECURITYTRAILS_API_KEY"];
  });

  describe("single source", () => {
    it("normalizes crt.sh output into observations", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/crtsh",
        payload: { caseId, subject: { kind: "domain", value: "example.com" } },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.status).toBe("ok");
      const kinds = new Set(
        body.observations.map((o: { kind: string }) => o.kind),
      );
      expect(kinds.has("cert")).toBe(true);
      expect(kinds.has("subdomain")).toBe(true);
      expect(body.provenance.sourceId).toBe("crtsh");
    });

    it("refuses a subject kind the source does not accept", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/crtsh",
        payload: { caseId, subject: { kind: "email", value: "a@example.com" } },
      });
      expect(response.statusCode).toBe(400);
    });

    it("404s for a source with no adapter", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/viewdns",
        payload: { caseId, subject: { kind: "domain", value: "example.com" } },
      });
      expect(response.statusCode).toBe(404);
    });

    it("writes an audit row for a non-scoped execution too", async () => {
      const log = await prisma.queryLog.findFirst({
        where: { caseId, sourceId: "crtsh", outcome: "ALLOWED" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.requiresScope).toBe(false);
      expect(log?.phase).toBe("EXECUTE");
    });

    it("serves a repeat query from cache instead of calling out again", async () => {
      let calls = 0;
      const counting = globalThis.fetch;
      globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        calls += 1;
        return counting(...args);
      }) as typeof fetch;

      const payload = {
        caseId,
        subject: { kind: "domain", value: "cache-test.example" },
      };
      await app.inject({ method: "POST", url: "/infra/crtsh", payload });
      await app.inject({ method: "POST", url: "/infra/crtsh", payload });

      expect(calls).toBe(1);

      const cached = await prisma.queryLog.findFirst({
        where: { caseId, sourceId: "crtsh", reason: "cache-hit" },
        orderBy: { createdAt: "desc" },
      });
      // The cache hit is still recorded — the timeline stays complete.
      expect(cached).not.toBeNull();
    });
  });

  describe("sweep — the batch path invariant 2 permits for non-scoped sources", () => {
    it("merges subdomain, host and cert findings across sources, deduped", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Exit gate: Shodan + crt.sh + SecurityTrails all produce normalized
      // findings for one domain subject.
      const live = body.sources.filter(
        (s: { status: string }) => s.status === "ok",
      );
      expect(live.map((s: { sourceId: string }) => s.sourceId).sort()).toEqual([
        "crtsh",
        "securitytrails",
        "shodan",
      ]);

      // Censys has no key, so it reports inert rather than inventing anything.
      const censys = body.sources.find(
        (s: { sourceId: string }) => s.sourceId === "censys",
      );
      expect(censys.status).toBe("inert");
      expect(censys.reason).toBe("missing-key");

      expect(body.totals.subdomain).toBeGreaterThan(0);
      expect(body.totals.host).toBeGreaterThan(0);
      expect(body.totals.cert).toBeGreaterThan(0);
      // Dedupe actually removed something.
      expect(body.totals.merged).toBeLessThan(body.totals.rawObservations);

      // www.example.com is reported by all three — attribution unions.
      const www = body.observations.find(
        (o: { observation: { kind: string; hostname?: string } }) =>
          o.observation.kind === "subdomain" &&
          o.observation.hostname === "www.example.com",
      );
      expect(www).toBeDefined();
      expect(www.sourceIds.sort()).toEqual([
        "crtsh",
        "securitytrails",
        "shodan",
      ]);
    });

    it("requires an explicit confirmation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/sweep",
        payload: {
          caseId,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("refuses to sweep a scoped source", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/sweep",
        payload: {
          caseId,
          confirm: true,
          sourceIds: ["hibp"],
          subject: { kind: "domain", value: "example.com" },
        },
      });
      // hibp is not an infra adapter at all, so it cannot even be named here.
      expect(response.statusCode).toBe(400);
    });

    it("never reaches a person-facing source from the sweep", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/infra/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      const touched = response
        .json()
        .sources.map((s: { sourceId: string }) => s.sourceId);
      for (const scoped of ["hibp", "dehashed", "hunter-io", "whatsmyname"]) {
        expect(touched).not.toContain(scoped);
      }
    });
  });

  describe("findings from infra results carry provenance", () => {
    it("saves a merged observation as a finding tied to its source", async () => {
      const sweep = await app.inject({
        method: "POST",
        url: "/infra/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      const crtsh = sweep
        .json()
        .sources.find((s: { sourceId: string }) => s.sourceId === "crtsh");

      const saved = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/findings`,
        payload: {
          sourceId: "crtsh",
          title: "www.example.com observed in CT logs",
          queryTerm: "example.com",
          queryKind: "domain",
          queryLogId: crtsh.queryLogId,
          data: { hostname: "www.example.com" },
        },
      });

      expect(saved.statusCode).toBe(201);
      const finding = saved.json();
      expect(finding.tier).toBe("INFRA");
      expect(finding.queryLogId).toBe(crtsh.queryLogId);
      expect(finding.queryTerm).toBe("example.com");
    });
  });
});
