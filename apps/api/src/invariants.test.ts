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
import {
  SOURCES,
  requiresScopeFor,
  scopedSources,
  type SubjectKind,
} from "@scout/sources";
import { INFRA_ADAPTERS } from "./adapters/infra/index.js";
import { SCOPED_ADAPTERS } from "./adapters/scoped/index.js";
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
 * A source whose person-identifying kinds are covered by `scopedKinds` is not
 * on this list — it is gated, just per kind rather than wholesale. That is how
 * `intelligence-x` was resolved in Phase 4: free for domains, gated for email.
 *
 * `opensanctions` — sanctions, PEP and watchlist screening, which is a
 * compliance function performed against names you have no prior relationship
 * with. Requiring per-target authorization would make it useless, and the
 * dataset exists precisely to be searched by name. It returns published
 * designations rather than private facts about the person, which is what
 * separates it from the exposure and people tiers. This one is expected to
 * stay unscoped.
 *
 */
const REVIEWED_UNSCOPED_PERSON_SOURCES = ["opensanctions"];

describe("invariant 1 — the scope gate is absolute", () => {
  it("pins the set of person-facing sources", () => {
    expect(scopedSources().map((s) => s.id).sort()).toEqual([
      "hibp",
      "hunter-io",
      "maigret",
      "sherlock",
      "whatsmyname",
    ]);
  });

  it("keeps every scoped source behind a built adapter, and vice versa", () => {
    // The scoped registry and the registry's own scoped set must be the same
    // four sources. A person-facing source with no adapter is unreachable
    // (fine), but an adapter for a source not marked scoped would run
    // ungated through the wrong runner.
    expect(SCOPED_ADAPTERS.map((a) => a.source.id).sort()).toEqual(
      scopedSources().map((s) => s.id).sort(),
    );
    for (const adapter of SCOPED_ADAPTERS) {
      expect(adapter.source.requiresScope).toBe(true);
    }
  });

  it("routes every scoped source under its own tier", () => {
    for (const adapter of SCOPED_ADAPTERS) {
      expect(EXECUTION_ROUTES[adapter.source.id]).toBe(
        `/${adapter.source.tier}/${adapter.source.id}`,
      );
    }
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

  it("leaves no ungated api source accepting a person identifier", () => {
    const ungated = SOURCES.filter((source) => {
      if (source.mode !== "api") return false;
      if (REVIEWED_UNSCOPED_PERSON_SOURCES.includes(source.id)) return false;
      // Any person-identifying kind this source accepts must be gated —
      // wholesale via requiresScope, or per kind via scopedKinds.
      return source.accepts.some(
        (kind) =>
          PERSON_IDENTIFYING.includes(kind) &&
          !requiresScopeFor(source, kind),
      );
    }).map((s) => s.id);

    // A new api source that accepts email/username/person without a gate
    // fails here until someone decides, on purpose, that it should not have
    // one — and writes down why.
    expect(ungated).toEqual([]);
  });

  it("gates Intelligence X for email selectors but not for domains", () => {
    const intelx = SOURCES.find((s) => s.id === "intelligence-x");
    if (intelx === undefined) throw new Error("intelligence-x missing");

    // The same source, two different answers. Searching a domain here is
    // dataset research; searching an email is a lookup about a person.
    expect(requiresScopeFor(intelx, "email")).toBe(true);
    expect(requiresScopeFor(intelx, "domain")).toBe(false);
    expect(requiresScopeFor(intelx, "ip")).toBe(false);
  });

  it("keeps scopedKinds a subset of what the source accepts", () => {
    // Gating a kind a source never receives is dead configuration that reads
    // like protection.
    for (const source of SOURCES) {
      for (const kind of source.scopedKinds ?? []) {
        expect(
          source.accepts,
          `${source.id} gates ${kind} but does not accept it`,
        ).toContain(kind);
      }
    }
  });

  it("treats a wholesale-scoped source as gated for every kind it accepts", () => {
    for (const source of scopedSources()) {
      for (const kind of source.accepts) {
        expect(requiresScopeFor(source, kind)).toBe(true);
      }
    }
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

  it("only batch-executes non-person tiers", () => {
    // The guarantee that matters is the per-kind gate asserted below — a tier
    // label is a UI grouping, not a safety property. This check stays as a
    // coarse tripwire: the sweep may carry infrastructure and utility sources
    // (hosts, certificates, archives), and nothing from the exposure, people
    // or datasets tiers, where person-facing sources live.
    for (const adapter of INFRA_ADAPTERS) {
      expect(["infra", "utils"]).toContain(adapter.source.tier);
    }
  });

  it("keeps every batch-executable source ungated for every kind it accepts", () => {
    // Per-kind gating means "not requiresScope" is no longer enough to be
    // safely sweepable — a source free for domains and gated for email must
    // not be swept with an email.
    for (const adapter of INFRA_ADAPTERS) {
      for (const kind of adapter.source.accepts) {
        expect(
          requiresScopeFor(adapter.source, kind),
          `${adapter.source.id} is gated for ${kind} and must not be sweepable with it`,
        ).toBe(false);
      }
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
    expect(keyless.sort()).toEqual([
      "certspotter",
      "crtsh",
      "hackertarget",
      "rapiddns",
      "rdap",
      "wayback-machine",
    ]);
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
