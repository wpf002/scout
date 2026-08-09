/**
 * Monitoring, change detection and the alert feed.
 *
 * The load-bearing assertion is the restriction: a monitor may never include a
 * source that is gated for its subject kind. Continuous automated re-running
 * is the exact opposite of "one confirmed action at a time", so the boundary
 * between "watch this domain" and "watch this person" has to be structural.
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
import { clearResponseCache } from "./adapters/base.js";
import { infraRateLimiter } from "./lib/ratelimit.js";

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

/** Hostnames the stubbed crt.sh returns. Mutated to simulate change. */
let currentHosts = ["www.example.com", "mail.example.com"];
const realFetch = globalThis.fetch;
let upstreamFails = false;

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (upstreamFails) throw new Error("simulated outage");
    if (url.startsWith("https://crt.sh/")) {
      return new Response(
        JSON.stringify(
          currentHosts.map((host, index) => ({
            common_name: host,
            name_value: host,
            issuer_name: "CN=R3",
            serial_number: `0${index}`,
            not_before: "2026-01-01T00:00:00",
            not_after: "2026-04-01T00:00:00",
          })),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected upstream call: ${url}`);
  }) as typeof fetch;
}

let app: FastifyInstance;
let caseId: string;
let monitorId: string;

run("monitoring and alerts", () => {
  beforeAll(async () => {
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Monitored",
        authorizationRef: `MON-${Date.now()}`,
        scope: [{ kind: "domain", value: "example.com" }],
      },
    });
    caseId = created.json().id;
  });

  beforeEach(() => {
    stubFetch();
    clearResponseCache();
    infraRateLimiter.reset();
    upstreamFails = false;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── the restriction ────────────────────────────────────────────────────
  describe("a monitor can never watch a person-facing source", () => {
    it.each(["hibp", "dehashed", "hunter-io", "whatsmyname"])(
      "refuses to create a monitor on %s",
      async (sourceId) => {
        const response = await app.inject({
          method: "POST",
          url: `/cases/${caseId}/monitors`,
          payload: {
            name: "should not exist",
            subject: { kind: "email", value: "bob@example.com" },
            sourceIds: [sourceId],
          },
        });
        expect(response.statusCode).toBe(400);
        expect(await prisma.monitor.count({ where: { caseId } })).toBe(0);
      },
    );

    it("refuses a per-kind gated source for the gated kind", async () => {
      // Intelligence X is free for a domain and gated for an email selector.
      const gated = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/monitors`,
        payload: {
          name: "email watch",
          subject: { kind: "email", value: "bob@example.com" },
          sourceIds: ["intelligence-x"],
        },
      });
      expect(gated.statusCode).toBe(400);
      expect(gated.json().message).toMatch(/scope-gated|one confirmed action/i);
    });

    it("allows the same source for the ungated kind", async () => {
      const allowed = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/monitors`,
        payload: {
          name: "domain watch",
          subject: { kind: "domain", value: "example.com" },
          sourceIds: ["intelligence-x"],
        },
      });
      expect(allowed.statusCode).toBe(201);
      await prisma.monitor.delete({ where: { id: allowed.json().id } });
    });

    it("refuses a source that does not accept the subject kind", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/monitors`,
        payload: {
          name: "bad kind",
          subject: { kind: "username", value: "bob" },
          sourceIds: ["crtsh"],
        },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ── change detection ───────────────────────────────────────────────────
  describe("change detection", () => {
    it("creates a monitor on an ungated source", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/monitors`,
        payload: {
          name: "example.com certs",
          subject: { kind: "domain", value: "example.com" },
          sourceIds: ["crtsh"],
          intervalMinutes: 60,
        },
      });
      expect(response.statusCode).toBe(201);
      monitorId = response.json().id;
    });

    it("treats the first run as a baseline and raises nothing", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/monitors/${monitorId}/run`,
      });
      expect(response.statusCode).toBe(200);

      const result = response.json();
      expect(result.baseline).toBe(true);
      expect(result.added).toBe(0);
      expect(result.observationCount).toBeGreaterThan(0);
      // Everything visible on day one is not "newly appeared". Reporting it
      // that way would bury the first real change.
      expect(await prisma.monitorChange.count({ where: { monitorId } })).toBe(0);
    });

    it("raises an alert when something new appears", async () => {
      currentHosts = ["www.example.com", "mail.example.com", "vpn.example.com"];
      clearResponseCache();

      const result = (
        await app.inject({
          method: "POST",
          url: `/cases/${caseId}/monitors/${monitorId}/run`,
        })
      ).json();

      expect(result.baseline).toBe(false);
      expect(result.added).toBeGreaterThan(0);

      const change = await prisma.monitorChange.findFirst({
        where: { monitorId, changeType: "ADDED" },
        orderBy: { createdAt: "desc" },
      });
      expect(change?.observationKey).toContain("vpn.example.com");
      expect(change?.sourceIds).toContain("crtsh");
    });

    it("raises an alert when something disappears", async () => {
      currentHosts = ["www.example.com"];
      clearResponseCache();

      const result = (
        await app.inject({
          method: "POST",
          url: `/cases/${caseId}/monitors/${monitorId}/run`,
        })
      ).json();
      expect(result.removed).toBeGreaterThan(0);
    });

    it("raises nothing when nothing changed", async () => {
      clearResponseCache();
      const result = (
        await app.inject({
          method: "POST",
          url: `/cases/${caseId}/monitors/${monitorId}/run`,
        })
      ).json();
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });

    it("does not report an outage as everything disappearing", async () => {
      const before = await prisma.monitorChange.count({ where: { monitorId } });
      upstreamFails = true;
      clearResponseCache();

      const result = (
        await app.inject({
          method: "POST",
          url: `/cases/${caseId}/monitors/${monitorId}/run`,
        })
      ).json();

      // A run that reached nothing is not evidence that everything is gone.
      expect(result.removed).toBe(0);
      expect(await prisma.monitorChange.count({ where: { monitorId } })).toBe(
        before,
      );
    });

    it("recovers cleanly after the outage, without an alert storm", async () => {
      upstreamFails = false;
      clearResponseCache();
      const result = (
        await app.inject({
          method: "POST",
          url: `/cases/${caseId}/monitors/${monitorId}/run`,
        })
      ).json();
      // The failed run carried the previous snapshot forward, so the world
      // has not "reappeared".
      expect(result.added).toBe(0);
    });

    it("audit-logs the monitored queries like any other", async () => {
      const logs = await prisma.queryLog.count({
        where: { caseId, sourceId: "crtsh", phase: "EXECUTE" },
      });
      // A recurring lookup is not a lesser event than a one-off.
      expect(logs).toBeGreaterThan(1);
    });
  });

  // ── the feed ───────────────────────────────────────────────────────────
  describe("the alert feed", () => {
    it("lists unacknowledged changes with their case", async () => {
      const response = await app.inject({ method: "GET", url: "/alerts" });
      expect(response.statusCode).toBe(200);

      const feed = response.json();
      expect(feed.alerts.length).toBeGreaterThan(0);
      expect(feed.alerts[0].caseName).toBe("Monitored");
      expect(feed.alerts[0].monitor.subjectValue).toBe("example.com");
    });

    it("filters to one case", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/alerts?caseId=${caseId}`,
      });
      expect(
        response.json().alerts.every((a: { caseId: string }) => a.caseId === caseId),
      ).toBe(true);
    });

    it("drops acknowledged alerts from the feed", async () => {
      const before = (await app.inject({ method: "GET", url: "/alerts" })).json();
      const ids = before.alerts.slice(0, 2).map((a: { id: string }) => a.id);

      const acked = await app.inject({
        method: "POST",
        url: "/alerts/acknowledge",
        payload: { ids },
      });
      expect(acked.json().acknowledged).toBe(ids.length);

      const after = (await app.inject({ method: "GET", url: "/alerts" })).json();
      expect(after.alerts.length).toBe(before.alerts.length - ids.length);
    });

    it("can still show acknowledged alerts on request", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/alerts?includeAcknowledged=true",
      });
      expect(
        response
          .json()
          .alerts.some((a: { acknowledgedAt: string | null }) => a.acknowledgedAt !== null),
      ).toBe(true);
    });

    it("records who acknowledged", async () => {
      const acked = await prisma.monitorChange.findFirst({
        where: { monitorId, acknowledgedAt: { not: null } },
      });
      expect(acked?.acknowledgedBy).toBeTruthy();
    });
  });

  // ── scheduling seam ────────────────────────────────────────────────────
  describe("run-due", () => {
    it("skips monitors whose interval has not elapsed", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/monitors/run-due",
      });
      expect(response.statusCode).toBe(200);
      // Just ran above with a 60-minute interval, so nothing is due.
      expect(response.json().ran).toBe(0);
    });

    it("runs a monitor that has never run", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/monitors`,
        payload: {
          name: "fresh",
          subject: { kind: "domain", value: "example.com" },
          sourceIds: ["crtsh"],
        },
      });
      clearResponseCache();

      const response = await app.inject({
        method: "POST",
        url: "/monitors/run-due",
      });
      expect(response.json().ran).toBeGreaterThan(0);
      await prisma.monitor.delete({ where: { id: created.json().id } });
    });

    it("disabling a monitor takes it out of the rotation", async () => {
      await app.inject({
        method: "PATCH",
        url: `/cases/${caseId}/monitors/${monitorId}`,
        payload: { enabled: false },
      });
      const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
      expect(monitor?.enabled).toBe(false);
    });
  });
});
