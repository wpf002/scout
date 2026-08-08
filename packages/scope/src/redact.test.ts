import { describe, expect, it } from "vitest";
import { REDACTED_MARKER, redactAll, redactOutOfScope } from "./redact.js";
import type { ScopeEntry } from "./types.js";

const scope: ScopeEntry[] = [
  { id: "s1", kind: "domain", value: "example.com" },
  { id: "s2", kind: "identifier", value: "alice@example.org" },
];

describe("redactOutOfScope", () => {
  it("leaves in-scope identifiers alone", () => {
    const result = redactOutOfScope(
      "Contacted bob@example.com about mail.example.com.",
      scope,
    );
    expect(result.text).toContain("bob@example.com");
    expect(result.text).toContain("mail.example.com");
    expect(result.redactions).toHaveLength(0);
  });

  it("strips an out-of-scope email that leaked into a note", () => {
    // The bystander whose address got pasted in while chasing a lead. The
    // engagement was never authorized to collect it, so it does not leave.
    const result = redactOutOfScope(
      "Lead came via bystander@unrelated.net, worth a look.",
      scope,
    );
    expect(result.text).not.toContain("bystander@unrelated.net");
    expect(result.text).toContain(REDACTED_MARKER);
    expect(result.redactions).toHaveLength(1);
    expect(result.redactions[0]?.kind).toBe("email");
  });

  it("strips an out-of-scope domain", () => {
    const result = redactOutOfScope("Referrer was tracker.evil.net.", scope);
    expect(result.text).not.toContain("tracker.evil.net");
    expect(result.redactions[0]?.reason).toBe("out-of-scope");
  });

  it("keeps an identifier scoped by exact match", () => {
    const result = redactOutOfScope("alice@example.org replied.", scope);
    expect(result.text).toContain("alice@example.org");
  });

  it("removes every occurrence, whatever the casing", () => {
    const result = redactOutOfScope(
      "Bystander@Unrelated.NET wrote; reply to bystander@unrelated.net.",
      scope,
    );
    expect(result.text.toLowerCase()).not.toContain("bystander@unrelated.net");
  });

  it("does not treat a lookalike domain as in scope", () => {
    const result = redactOutOfScope("Saw notexample.com in the logs.", scope);
    expect(result.text).not.toContain("notexample.com");
  });

  it("strips an out-of-scope IP address", () => {
    const result = redactOutOfScope("Callback came from 198.51.100.7.", scope);
    expect(result.text).not.toContain("198.51.100.7");
    expect(result.redactions[0]?.kind).toBe("ip");
  });

  it("keeps an in-scope IP address", () => {
    const withIp: ScopeEntry[] = [
      ...scope,
      { id: "s3", kind: "identifier", value: "203.0.113.10" },
    ];
    expect(
      redactOutOfScope("Host 203.0.113.10 responded.", withIp).text,
    ).toContain("203.0.113.10");
  });

  it("does not mistake an out-of-range dotted quad for an address", () => {
    // Octets are validated, so this is not treated as an IP. It is also not a
    // domain (numeric TLD), so it survives untouched.
    const text = "Build 1.2.3.400 shipped.";
    expect(redactOutOfScope(text, scope).text).toBe(text);
  });

  it("redacts everything when the case has no scope", () => {
    // Empty scope is OFF, so nothing is authorized and nothing goes out.
    const result = redactOutOfScope("bob@example.com and example.com", []);
    expect(result.text).not.toContain("bob@example.com");
    expect(result.redactions.length).toBeGreaterThan(0);
    expect(result.redactions[0]?.reason).toBe("scope-empty");
  });

  it("handles empty and absent text", () => {
    expect(redactOutOfScope("", scope).text).toBe("");
    expect(redactOutOfScope(null, scope).text).toBe("");
    expect(redactOutOfScope(undefined, scope).redactions).toEqual([]);
  });

  it("leaves prose with no identifiers untouched", () => {
    const prose = "Subject appears to run several unrelated businesses.";
    expect(redactOutOfScope(prose, scope).text).toBe(prose);
  });
});

describe("redactAll", () => {
  it("pools redactions across several fields", () => {
    const result = redactAll(
      ["a@unrelated.net", "fine: bob@example.com", "b@elsewhere.net"],
      scope,
    );
    expect(result.redactions).toHaveLength(2);
    expect(result.texts[1]).toContain("bob@example.com");
  });
});
