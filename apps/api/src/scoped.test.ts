/**
 * Phase 5 exit-gate tests: the scoped tier.
 *
 * The roadmap sets a kill criterion for this phase — if per-case scope and
 * audit cannot be made airtight, these adapters do not ship. So the bulk of
 * this file is the red-team block: every route, every subject kind, every
 * shape of out-of-scope input, asserting there is no path that executes a
 * person-facing source for a subject the case does not authorize.
 *
 * Upstreams are stubbed, and every stub records whether it was reached. A test
 * that only checks the HTTP status could pass while the request still went
 * out; these assert the upstream was never touched.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";
import { SCOPED_ADAPTERS } from "./adapters/scoped/index.js";
import { isHit, siteLimit } from "./adapters/scoped/whatsmyname.js";
import { normalizeHibp } from "./adapters/hibp.js";
import { normalizeHunterDomain } from "./adapters/scoped/hunter.js";

// ── pure normalizers (no database, no network) ───────────────────────────
describe("WhatsMyName hit detection", () => {
  const site = {
    name: "ExampleSite",
    uri_check: "https://example.com/{account}",
    e_code: 200,
    e_string: "profile-header",
    cat: "social",
  };

  it("requires both the status and the marker string", () => {
    expect(isHit(site, 200, "<div class=profile-header>")).toBe(true);
    // Status alone would false-positive on sites that 200 for every URL — and
    // a false positive asserts a named person holds an account they may not.
    expect(isHit(site, 200, "<h1>Not found</h1>")).toBe(false);
    expect(isHit(site, 404, "profile-header")).toBe(false);
  });

  it("defaults the site cap and honours an override", () => {
    expect(siteLimit({})).toBe(40);
    expect(siteLimit({ WHATSMYNAME_SITE_LIMIT: "5" })).toBe(5);
    expect(siteLimit({ WHATSMYNAME_SITE_LIMIT: "nonsense" })).toBe(40);
    expect(siteLimit({ WHATSMYNAME_SITE_LIMIT: "-3" })).toBe(40);
  });
});

describe("HIBP normalization", () => {
  it("keeps pwn counts as bigints past the 32-bit boundary", () => {
    const [record] = normalizeHibp([
      {
        Name: "Cam4",
        Title: "Cam4",
        Domain: "cam4.com",
        BreachDate: "2020-03-16",
        PwnCount: 10_880_000_000,
        DataClasses: ["Email addresses"],
        IsVerified: true,
      },
    ]);
    expect(record?.pwnCount).toBe(10_880_000_000n);
  });
});

describe("Hunter normalization", () => {
  it("lowercases addresses and keeps the pattern", () => {
    const [result] = normalizeHunterDomain(
      {
        data: {
          domain: "example.com",
          pattern: "{first}.{last}",
          organization: "Example Ltd",
          emails: [
            {
              value: "Bob.Example@Example.com",
              type: "personal",
              confidence: 92,
              first_name: "Bob",
              last_name: "Example",
              position: "Engineer",
            },
          ],
        },
      },
      "example.com",
    );
    expect(result?.pattern).toBe("{first}.{last}");
    expect(result?.emails[0]?.value).toBe("bob.example@example.com");
  });
});

// ── routes, against a real database ──────────────────────────────────────
const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

/** Every upstream call the stub sees. Empty means nothing left the process. */
let upstreamCalls: string[] = [];
const realFetch = globalThis.fetch;

function stubFetch() {
  upstreamCalls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    upstreamCalls.push(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.startsWith("https://haveibeenpwned.com/")) {
      return json([
        {
          Name: "ExampleBreach",
          Title: "Example Breach",
          Domain: "example.com",
          BreachDate: "2025-01-01",
          PwnCount: 1000,
          DataClasses: ["Email addresses"],
          IsVerified: true,
        },
      ]);
    }
    if (url.startsWith("https://api.hunter.io/")) {
      return json({
        data: {
          domain: "example.com",
          pattern: "{first}.{last}",
          organization: "Example Ltd",
          emails: [],
        },
      });
    }
    throw new Error(`unexpected upstream call: ${url}`);
  }) as typeof fetch;
}

let app: FastifyInstance;
let caseId: string;
const AUTH_REF = `SCOPED-${Date.now()}`;

/** Every scoped route, with a subject kind each one accepts. */
const SCOPED_ROUTES = [
  { path: "/exposure/hibp", kind: "email" as const },
  { path: "/people/hunter-io", kind: "domain" as const },
  { path: "/people/whatsmyname", kind: "username" as const },
];

run("Scout scoped tier — Phase 5", () => {
  beforeAll(async () => {
    process.env["HIBP_API_KEY"] = "k-hibp";
    process.env["HUNTER_API_KEY"] = "k-hunter";
    // WhatsMyName stays off, so it exercises the inert path.
    delete process.env["WHATSMYNAME_ENABLED"];

    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Scoped tier",
        authorizationRef: AUTH_REF,
        scope: [
          { kind: "domain", value: "example.com" },
          { kind: "identifier", value: "target_handle" },
        ],
      },
    });
    caseId = created.json().id;
  });

  beforeEach(() => stubFetch());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    for (const key of ["HIBP_API_KEY", "HUNTER_API_KEY"]) {
      delete process.env[key];
    }
  });

  describe("every scoped source runs for an in-scope subject", () => {
    it("returns breach records from HIBP", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/exposure/hibp",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().observations[0].name).toBe("ExampleBreach");
    });


    it("returns an email pattern from Hunter", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/people/hunter-io",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().observations[0].pattern).toBe("{first}.{last}");
    });

    it("reports WhatsMyName inert while it is switched off", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/people/whatsmyname",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "username", value: "target_handle" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("inert");
      // Inert means nothing was attempted, not that nothing was found.
      expect(upstreamCalls).toEqual([]);
    });
  });

  // ── the red team ───────────────────────────────────────────────────────
  describe("red team: no path executes a scoped source out of scope", () => {
    const OUT_OF_SCOPE: Record<string, string> = {
      email: "victim@unrelated.net",
      domain: "unrelated.net",
      username: "someone_else",
    };

    it.each(SCOPED_ROUTES)(
      "refuses $path for an out-of-scope subject and never calls upstream",
      async ({ path, kind }) => {
        const response = await app.inject({
          method: "POST",
          url: path,
          payload: {
            caseId,
            confirm: true,
            subject: { kind, value: OUT_OF_SCOPE[kind] },
          },
        });

        expect(response.statusCode).toBe(403);
        expect(response.json().reason).toBe("out-of-scope");
        // The gate runs before the network call is reachable, so nothing left.
        expect(upstreamCalls).toEqual([]);
      },
    );

    it.each(SCOPED_ROUTES)(
      "writes a DENIED audit row for the refused $path attempt",
      async ({ path, kind }) => {
        const sourceId = path.split("/")[2] as string;
        const denial = await prisma.queryLog.findFirst({
          where: {
            caseId,
            sourceId,
            outcome: "DENIED",
            subjectValue: OUT_OF_SCOPE[kind],
          },
        });
        expect(denial).not.toBeNull();
        expect(denial?.reason).toBe("out-of-scope");
        expect(denial?.requiresScope).toBe(true);
        expect(denial?.authorizationRef).toBe(AUTH_REF);
      },
    );

    it.each(SCOPED_ROUTES)("refuses $path without a case", async ({ path, kind }) => {
      const response = await app.inject({
        method: "POST",
        url: path,
        payload: { confirm: true, subject: { kind, value: "bob@example.com" } },
      });
      expect(response.statusCode).toBe(400);
      expect(upstreamCalls).toEqual([]);
    });

    it.each(SCOPED_ROUTES)(
      "refuses $path without confirmation",
      async ({ path, kind }) => {
        const response = await app.inject({
          method: "POST",
          url: path,
          payload: {
            caseId,
            subject: { kind, value: kind === "domain" ? "example.com" : "target_handle" },
          },
        });
        expect(response.statusCode).toBe(400);
        expect(upstreamCalls).toEqual([]);
      },
    );

    it.each(SCOPED_ROUTES)(
      "refuses $path under a case with empty scope",
      async ({ path, kind }) => {
        const created = await app.inject({
          method: "POST",
          url: "/cases",
          payload: {
            name: "empty",
            authorizationRef: `${AUTH_REF}-EMPTY-${path}`,
          },
        });
        const response = await app.inject({
          method: "POST",
          url: path,
          payload: {
            caseId: created.json().id,
            confirm: true,
            subject: { kind, value: "bob@example.com" },
          },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().reason).toBe("scope-empty");
        expect(upstreamCalls).toEqual([]);
      },
    );

    it("ignores scope-shaped fields smuggled into the body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/exposure/hibp",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "victim@unrelated.net" },
          scope: [{ kind: "domain", value: "unrelated.net" }],
          authorizationRef: "FORGED",
          requiresScope: false,
          scopedKinds: [],
        },
      });
      expect(response.statusCode).toBe(403);
      expect(upstreamCalls).toEqual([]);
    });

    it("refuses lookalike domains across every scoped route", async () => {
      for (const value of [
        "bob@notexample.com",
        "bob@example.com.evil.net",
        "bob@example.com@evil.net",
      ]) {
        const response = await app.inject({
          method: "POST",
          url: "/exposure/hibp",
          payload: { caseId, confirm: true, subject: { kind: "email", value } },
        });
        expect(response.statusCode, `${value} must be refused`).toBe(403);
      }
      expect(upstreamCalls).toEqual([]);
    });

    it("cannot reach a scoped source through the infra sweep", async () => {
      for (const sourceId of SCOPED_ADAPTERS.map((a) => a.source.id)) {
        const response = await app.inject({
          method: "POST",
          url: "/infra/sweep",
          payload: {
            caseId,
            confirm: true,
            sourceIds: [sourceId],
            subject: { kind: "domain", value: "example.com" },
          },
        });
        expect(response.statusCode, `${sourceId} must not be sweepable`).toBe(
          400,
        );
      }
      expect(upstreamCalls).toEqual([]);
    });

    it("cannot reach a scoped source through the dataset sweep", async () => {
      for (const sourceId of SCOPED_ADAPTERS.map((a) => a.source.id)) {
        const response = await app.inject({
          method: "POST",
          url: "/datasets/sweep",
          payload: {
            caseId,
            confirm: true,
            sourceIds: [sourceId],
            subject: { kind: "domain", value: "example.com" },
          },
        });
        expect(response.statusCode, `${sourceId} must not be sweepable`).toBe(
          400,
        );
      }
      expect(upstreamCalls).toEqual([]);
    });

    it("cannot reach a scoped source through the dataset route", async () => {
      for (const sourceId of SCOPED_ADAPTERS.map((a) => a.source.id)) {
        const response = await app.inject({
          method: "POST",
          url: `/datasets/${sourceId}`,
          payload: {
            caseId,
            confirm: true,
            subject: { kind: "email", value: "victim@unrelated.net" },
          },
        });
        expect(response.statusCode).toBe(404);
      }
      expect(upstreamCalls).toEqual([]);
    });

    it("cannot reach a scoped source through the infra route", async () => {
      for (const sourceId of SCOPED_ADAPTERS.map((a) => a.source.id)) {
        const response = await app.inject({
          method: "POST",
          url: `/infra/${sourceId}`,
          payload: {
            caseId,
            subject: { kind: "email", value: "victim@unrelated.net" },
          },
        });
        expect(response.statusCode).toBe(404);
      }
      expect(upstreamCalls).toEqual([]);
    });

    it("does not serve a scoped source from another case's scope", async () => {
      const other = await app.inject({
        method: "POST",
        url: "/cases",
        payload: {
          name: "other",
          authorizationRef: `${AUTH_REF}-OTHER`,
          scope: [{ kind: "domain", value: "unrelated.net" }],
        },
      });
      // In scope for the OTHER case, not for this one.
      const response = await app.inject({
        method: "POST",
        url: "/exposure/hibp",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "bob@unrelated.net" },
        },
      });
      expect(response.statusCode).toBe(403);
      expect(other.statusCode).toBe(201);
      expect(upstreamCalls).toEqual([]);
    });

    it("plans every scoped source as blocked for an out-of-scope subject", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/query",
        payload: {
          caseId,
          subject: { kind: "email", value: "victim@unrelated.net" },
        },
      });
      const scoped = response
        .json()
        .plan.filter((e: { requiresScope: boolean }) => e.requiresScope);
      expect(scoped.length).toBeGreaterThan(0);
      for (const entry of scoped) {
        expect(entry.status).toBe("blocked");
        expect(entry.execution).toBeUndefined();
      }
    });
  });

  describe("route surface", () => {
    it("404s a scoped source addressed under the wrong tier", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/people/hibp",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      expect(response.statusCode).toBe(404);
    });

    it("refuses a subject kind the source does not accept", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/people/whatsmyname",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("lists the built scoped adapters", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/scoped/adapters",
      });
      expect(response.json().count).toBe(4);
      for (const adapter of response.json().adapters) {
        expect(adapter.requiresScope).toBe(true);
      }
    });
  });
});
