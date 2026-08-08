/**
 * The locked invariants, enforced mechanically.
 *
 * Everything here is a structural property of the registry and the adapter
 * wiring — no database, no network, no keys. These are the rules that must
 * fail a test run rather than a code review, because "someone will notice in
 * review" is exactly how a safety property erodes.
 *
 * Invariants covered here: 1 (scope gate), 2 (no blind fan-out), 4 (deeplink
 * sources), 6 (inert, never guessed). Invariants 3 (audit) and 5 (provenance)
 * are behavioural and live in api.test.ts and the Prisma schema; 7 (counted
 * things) lives in packages/db/src/audit.test.ts.
 */
import { describe, expect, it } from "vitest";
import { SOURCES, scopedSources, type SubjectKind } from "@scout/sources";
import { INFRA_ADAPTERS } from "./adapters/infra/index.js";
import { executeUnscopedSource } from "./adapters/base.js";
import { EXECUTION_ROUTES } from "./routes/query.js";

/**
 * Subject kinds that identify a natural person. Deliberately excludes `hash`
 * (a file hash is not a person) and `ip`/`domain` (infrastructure).
 */
const PERSON_IDENTIFYING: readonly SubjectKind[] = [
  "email",
  "username",
  "person",
];

/**
 * Non-scoped `api` sources that nonetheless accept a person-identifying
 * subject kind.
 *
 * Every entry here is a source Scout could be asked to query about a person
 * with no scope gate in front of it. The list is pinned so adding one is a
 * deliberate, reviewable act rather than a side effect of editing `accepts`.
 *
 * `intelligence-x` — searches leaks and pastes by selector, and one of those
 * selectors is an email address. That is a person-facing lookup in everything
 * but tier placement. The roadmap locks it into the datasets tier as
 * non-scoped, and its adapter is not built yet (Phase 4), so nothing currently
 * executes a person-facing IntelX lookup. Whether it stays unscoped is a
 * Phase 4 decision, and the likely resolution is per-subject-kind scoping:
 * free for domains, gated for email selectors.
 *
 * `opensanctions` — sanctions, PEP and watchlist screening, which is a
 * compliance function performed against names you have no prior relationship
 * with. Requiring per-target authorization would make it useless, and the
 * dataset exists precisely to be searched by name. It returns published
 * designations rather than private facts about the person, which is what
 * separates it from the exposure and people tiers. This one is expected to
 * stay unscoped.
 */
const REVIEWED_UNSCOPED_PERSON_SOURCES = ["intelligence-x", "opensanctions"];

describe("invariant 1 — the scope gate is absolute", () => {
  it("pins the set of person-facing sources", () => {
    expect(scopedSources().map((s) => s.id).sort()).toEqual([
      "dehashed",
      "hibp",
      "hunter-io",
      "whatsmyname",
    ]);
  });

  it("refuses to run a scoped source on the unscoped path", async () => {
    const hibp = SOURCES.find((s) => s.id === "hibp");
    if (hibp === undefined) throw new Error("hibp missing from registry");

    // The guard fires before the case is even loaded, so this needs no
    // database. Routing a scoped source here must fail loudly rather than
    // quietly skip enforceScope().
    await expect(
      executeUnscopedSource(
        hibp,
        {
          caseId: "irrelevant",
          subject: { kind: "email", value: "someone@example.com" },
          operator: "test",
        },
        async () => {
          throw new Error("the upstream must never be reached");
        },
      ),
    ).rejects.toThrow(/requires scope/i);
  });

  it("keeps every non-scoped api source that accepts a person identifier on the reviewed list", () => {
    const unreviewed = SOURCES.filter(
      (source) =>
        source.mode === "api" &&
        !source.requiresScope &&
        source.accepts.some((kind) => PERSON_IDENTIFYING.includes(kind)) &&
        !REVIEWED_UNSCOPED_PERSON_SOURCES.includes(source.id),
    ).map((s) => s.id);

    // A new api source that accepts email/username/person and is not scoped
    // fails here until someone decides, on purpose, that it should not be.
    expect(unreviewed).toEqual([]);
  });

  it("confirms crt.sh cannot be asked about a person at all", () => {
    // This is what makes crt.sh's move to `api` mode safe, rather than merely
    // convenient: there is no person-identifying subject kind it will accept,
    // so Scout can never transmit a personal identifier to it.
    const crtsh = SOURCES.find((s) => s.id === "crtsh");
    expect(crtsh?.accepts).toEqual(["domain"]);
    for (const kind of PERSON_IDENTIFYING) {
      expect(crtsh?.accepts).not.toContain(kind);
    }
  });
});

describe("invariant 2 — no blind fan-out", () => {
  it("keeps every scoped source out of the batch-executable adapter set", () => {
    // /infra/sweep draws only from INFRA_ADAPTERS. If a scoped source ever
    // landed here, a sweep would become a person-facing fan-out.
    for (const adapter of INFRA_ADAPTERS) {
      expect(
        adapter.source.requiresScope,
        `${adapter.source.id} is scoped and must not be batch-executable`,
      ).toBe(false);
    }
  });

  it("only batch-executes infrastructure-tier sources", () => {
    for (const adapter of INFRA_ADAPTERS) {
      expect(adapter.source.tier).toBe("infra");
    }
  });
});

describe("invariant 4 — deeplink sources never transmit subject data", () => {
  it("gives no deeplink-mode source an execution route", () => {
    // A `deeplink` source must have no way for Scout to fetch it. If one ever
    // gains an adapter, its `mode` has to change to `api` first — a visible,
    // reviewable edit rather than a silent erosion. That is exactly what
    // happened to crt.sh in Phase 3.
    for (const source of SOURCES) {
      if (source.mode === "deeplink") {
        expect(
          EXECUTION_ROUTES[source.id],
          `${source.id} is a deeplink source but has an execution route`,
        ).toBeUndefined();
      }
    }
  });

  it("gives every deeplink source a URL builder", () => {
    for (const source of SOURCES) {
      if (source.mode === "deeplink") {
        expect(typeof source.deeplink).toBe("function");
      }
    }
  });
});

describe("invariant 6 — inert without keys, never guessed", () => {
  it("gives every api source either a key env or a pinned keyless exemption", () => {
    const keyless = SOURCES.filter(
      (s) => s.mode === "api" && s.keyEnv === null,
    ).map((s) => s.id);
    expect(keyless).toEqual(["crtsh"]);
  });

  it("routes every built adapter to a source that exists in the registry", () => {
    for (const [sourceId, path] of Object.entries(EXECUTION_ROUTES)) {
      expect(
        SOURCES.some((s) => s.id === sourceId),
        `${path} points at unknown source ${sourceId}`,
      ).toBe(true);
    }
  });
});
