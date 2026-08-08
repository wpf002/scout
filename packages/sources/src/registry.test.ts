import { describe, expect, it } from "vitest";
import {
  SOURCES,
  getSource,
  groupedByTier,
  hasKey,
  scopedSources,
  serializeSource,
} from "./registry.js";
import { TIERS } from "./types.js";

describe("registry shape", () => {
  it("holds 19 sources across 6 tiers", () => {
    expect(SOURCES).toHaveLength(19);
    expect(new Set(SOURCES.map((s) => s.tier)).size).toBe(TIERS.length);
  });

  it("has unique ids", () => {
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
  });

  it("groups tiers in reach-for order", () => {
    expect(groupedByTier().map((g) => g.tier)).toEqual([
      "datasets",
      "infra",
      "exposure",
      "people",
      "onion",
      "utils",
    ]);
  });

  it("gives every source at least one accepted subject kind", () => {
    for (const source of SOURCES) {
      expect(source.accepts.length).toBeGreaterThan(0);
    }
  });
});

describe("scoped sources are exactly the person-facing four", () => {
  // Pinned deliberately. A new `requiresScope` source must be added here on
  // purpose, alongside an adapter that calls enforceScope().
  it("matches the locked set", () => {
    expect(scopedSources().map((s) => s.id).sort()).toEqual([
      "dehashed",
      "hibp",
      "hunter-io",
      "whatsmyname",
    ]);
  });

  it("keeps every scoped source in the exposure or people tier", () => {
    for (const source of scopedSources()) {
      expect(["exposure", "people"]).toContain(source.tier);
    }
  });

  it("never marks a deeplink source as scoped", () => {
    // A deeplink never transmits the subject through Scout, so there is
    // nothing for the gate to guard — and marking one scoped would imply a
    // protection that does not exist.
    for (const source of scopedSources()) {
      expect(source.mode).toBe("api");
    }
  });
});

describe("mode invariants", () => {
  it("gives every deeplink source a builder and no api source one", () => {
    for (const source of SOURCES) {
      if (source.mode === "deeplink") {
        expect(typeof source.deeplink).toBe("function");
      } else {
        expect(source.deeplink).toBeUndefined();
      }
    }
  });

  it("URL-encodes the term so it cannot break out of the deeplink", () => {
    const crtsh = getSource("crtsh");
    const built = crtsh?.deeplink?.("evil.com&x=1 y");
    expect(built).toBe("https://crt.sh/?q=evil.com%26x%3D1%20y");
  });

  it("requires a key env for every api source", () => {
    for (const source of SOURCES) {
      if (source.mode === "api") expect(source.keyEnv).toBeTruthy();
    }
  });
});

describe("hasKey — no key means inert, never a guess", () => {
  it("treats keyless deeplink sources as always usable", () => {
    expect(hasKey(getSource("crtsh")!, {})).toBe(true);
  });

  it("reports an api source with no key as keyless", () => {
    expect(hasKey(getSource("shodan")!, {})).toBe(false);
    expect(hasKey(getSource("shodan")!, { SHODAN_API_KEY: "   " })).toBe(false);
    expect(hasKey(getSource("shodan")!, { SHODAN_API_KEY: "abc" })).toBe(true);
  });
});

describe("serializeSource", () => {
  it("drops the function field so the source can cross a JSON boundary", () => {
    const serialized = serializeSource(getSource("crtsh")!);
    expect(serialized).not.toHaveProperty("deeplink");
    expect(serialized.hasDeeplink).toBe(true);
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });
});
