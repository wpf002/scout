import { describe, expect, it } from "vitest";
import { getSource } from "@scout/sources";
import type { Source, Subject } from "@scout/sources";
import { checkScope, enforceScope } from "./gate.js";
import { envScope } from "./env.js";
import type { ScopeEntry } from "./types.js";
import { ScopeError } from "./types.js";

const hibp = getSource("hibp") as Source;

const scope: ScopeEntry[] = [
  { id: "s1", kind: "domain", value: "example.com" },
  { id: "s2", kind: "identifier", value: "alice@example.org" },
  { id: "s3", kind: "identifier", value: "target_handle" },
];

const subject = (kind: Subject["kind"], value: string): Subject => ({
  kind,
  value,
});

describe("checkScope — empty scope is OFF, not open", () => {
  it("denies every subject when no scope entries exist", () => {
    const decision = checkScope(subject("domain", "example.com"), []);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("scope-empty");
  });
});

describe("checkScope — domain entries", () => {
  it("allows the scope domain itself", () => {
    const decision = checkScope(subject("domain", "example.com"), scope);
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.matched.id).toBe("s1");
  });

  it("allows a subdomain of the scope domain", () => {
    expect(
      checkScope(subject("domain", "mail.corp.example.com"), scope).allowed,
    ).toBe(true);
  });

  it("denies a sibling domain that merely ends with the same text", () => {
    // The classic suffix-check bug: "notexample.com".endsWith("example.com").
    const decision = checkScope(subject("domain", "notexample.com"), scope);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toBe("out-of-scope");
  });

  it("denies a domain that only prefixes the scope domain", () => {
    expect(
      checkScope(subject("domain", "example.com.evil.net"), scope).allowed,
    ).toBe(false);
  });

  it("normalizes case, trailing dots, ports and schemes before matching", () => {
    for (const value of [
      "EXAMPLE.com",
      "example.com.",
      "example.com:8443",
      "https://example.com/admin",
      "  example.com  ",
    ]) {
      expect(checkScope(subject("domain", value), scope).allowed).toBe(true);
    }
  });

  it("does not let a URL with the scope domain in the path or query slip through", () => {
    for (const value of [
      "https://evil.net/?next=example.com",
      "https://evil.net/#example.com",
      "https://evil.net/example.com",
    ]) {
      expect(checkScope(subject("domain", value), scope).allowed).toBe(false);
    }
  });
});

describe("checkScope — emails", () => {
  it("allows an email whose domain falls under a domain entry", () => {
    const decision = checkScope(subject("email", "bob@mail.example.com"), scope);
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.matched.id).toBe("s1");
  });

  it("allows an email listed exactly as an identifier entry", () => {
    const decision = checkScope(subject("email", "Alice@Example.ORG"), scope);
    expect(decision.allowed).toBe(true);
    expect(decision.allowed === true && decision.matched.id).toBe("s2");
  });

  it("denies an email at an unrelated domain", () => {
    expect(
      checkScope(subject("email", "carol@example.org"), scope).allowed,
    ).toBe(false);
  });

  it("splits on the last @, so a spoofed local part cannot smuggle scope", () => {
    // Domain is evil.net, not example.com.
    expect(
      checkScope(subject("email", "alice@example.com@evil.net"), scope).allowed,
    ).toBe(false);
  });
});

describe("checkScope — identifiers", () => {
  it("allows an exactly-matching username", () => {
    expect(
      checkScope(subject("username", "Target_Handle"), scope).allowed,
    ).toBe(true);
  });

  it("denies a username that merely contains a scoped one", () => {
    expect(
      checkScope(subject("username", "target_handle2"), scope).allowed,
    ).toBe(false);
  });

  it("never matches a person or company name against a domain entry", () => {
    expect(checkScope(subject("person", "example.com"), scope).allowed).toBe(
      false,
    );
    expect(checkScope(subject("company", "example.com"), scope).allowed).toBe(
      false,
    );
  });
});

describe("checkScope — unparseable input fails closed", () => {
  it("denies rather than wildcards when a subject cannot be parsed", () => {
    for (const value of ["   ", "@", "not a host", "@example.com"]) {
      const decision = checkScope(subject("email", value), scope);
      expect(decision.allowed).toBe(false);
    }
  });
});

describe("enforceScope — the adapter-level gate", () => {
  const authorized = {
    scope,
    source: hibp,
    caseId: "case_1",
    authorizationRef: "ENG-2026-014",
  };

  it("returns the matching entry for an in-scope subject", () => {
    const matched = enforceScope({
      ...authorized,
      subject: subject("email", "bob@example.com"),
    });
    expect(matched.id).toBe("s1");
  });

  it("throws a 403 ScopeError for an out-of-scope subject", () => {
    expect(() =>
      enforceScope({
        ...authorized,
        subject: subject("email", "victim@unrelated.net"),
      }),
    ).toThrowError(ScopeError);

    try {
      enforceScope({
        ...authorized,
        subject: subject("email", "victim@unrelated.net"),
      });
      expect.unreachable("enforceScope must throw for out-of-scope subjects");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeError);
      expect((error as ScopeError).statusCode).toBe(403);
      expect((error as ScopeError).reason).toBe("out-of-scope");
      expect((error as ScopeError).sourceId).toBe("hibp");
    }
  });

  it("refuses to run a scoped source without a case", () => {
    try {
      enforceScope({
        ...authorized,
        caseId: null,
        subject: subject("email", "bob@example.com"),
      });
      expect.unreachable("a scoped source must not run without a case");
    } catch (error) {
      expect((error as ScopeError).reason).toBe("case-required");
    }
  });

  it("refuses to run when the case carries no authorization reference", () => {
    try {
      enforceScope({
        ...authorized,
        authorizationRef: "   ",
        subject: subject("email", "bob@example.com"),
      });
      expect.unreachable("a scoped source must not run without an auth ref");
    } catch (error) {
      expect((error as ScopeError).reason).toBe("authorization-missing");
    }
  });

  it("refuses when the case has an empty scope", () => {
    try {
      enforceScope({
        ...authorized,
        scope: [],
        subject: subject("email", "bob@example.com"),
      });
      expect.unreachable("empty scope must be treated as off");
    } catch (error) {
      expect((error as ScopeError).reason).toBe("scope-empty");
    }
  });
});

describe("envScope — the keyless local fallback", () => {
  it("parses comma-separated domains and identifiers", () => {
    const entries = envScope({
      SCOUT_SCOPE_DOMAINS: "example.com, corp.example.net",
      SCOUT_SCOPE_IDENTIFIERS: "alice@example.com",
    });
    expect(entries).toEqual([
      { kind: "domain", value: "example.com" },
      { kind: "domain", value: "corp.example.net" },
      { kind: "identifier", value: "alice@example.com" },
    ]);
  });

  it("yields an empty list when unset, which reads as scope-empty", () => {
    expect(envScope({})).toEqual([]);
    expect(checkScope(subject("domain", "example.com"), envScope({})).allowed).toBe(
      false,
    );
  });
});
