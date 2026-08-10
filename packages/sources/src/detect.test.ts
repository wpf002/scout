import { describe, expect, it } from "vitest";
import { detectSubjectKind, normalizeIndicator } from "./detect.js";

const kindOf = (raw: string) => detectSubjectKind(raw).kind;

describe("normalizing what was pasted", () => {
  it("refangs defanged indicators", () => {
    expect(normalizeIndicator("acme[.]com")).toBe("acme.com");
    expect(normalizeIndicator("hxxps://acme.com")).toBe("acme.com");
  });

  it("reduces a url to its host", () => {
    expect(normalizeIndicator("https://acme.com/path?q=1")).toBe("acme.com");
    expect(normalizeIndicator("http://acme.com:8443/x")).toBe("acme.com");
  });

  it("strips wrapping picked up from copied text", () => {
    expect(normalizeIndicator("<acme.com>")).toBe("acme.com");
    expect(normalizeIndicator('"acme.com"')).toBe("acme.com");
    expect(normalizeIndicator("  acme.com.  ")).toBe("acme.com");
  });

  it("leaves an email address intact", () => {
    expect(normalizeIndicator("j.doe@acme.com")).toBe("j.doe@acme.com");
  });
});

describe("detecting the kind", () => {
  it("reads addresses", () => {
    expect(kindOf("93.184.216.34")).toBe("ip");
    expect(kindOf("2606:2800:220:1:248:1893:25c8:1946")).toBe("ip");
  });

  it("does not read a version string as an address", () => {
    expect(kindOf("999.999.999.999")).not.toBe("ip");
  });

  it("reads email addresses", () => {
    expect(kindOf("j.doe@acme.com")).toBe("email");
    expect(kindOf("J.Doe@Acme.COM")).toBe("email");
  });

  it("reads domains, including through a url", () => {
    expect(kindOf("acme.com")).toBe("domain");
    expect(kindOf("mail.acme.co.uk")).toBe("domain");
    expect(kindOf("https://acme.com/login")).toBe("domain");
  });

  it("reads hashes at known lengths only", () => {
    expect(kindOf("d41d8cd98f00b204e9800998ecf8427e")).toBe("hash");
    expect(kindOf("a".repeat(64))).toBe("hash");
    // 31 hex characters is not a hash, and should not be called one.
    expect(kindOf("a".repeat(31))).not.toBe("hash");
  });

  it("reads handles", () => {
    expect(kindOf("someone")).toBe("username");
    expect(kindOf("some_one-1")).toBe("username");
  });

  it("reads company names by their suffix", () => {
    expect(kindOf("Acme Holdings Ltd")).toBe("company");
    expect(kindOf("Initech LLC")).toBe("company");
  });

  it("falls back to keyword rather than guessing a person", () => {
    // The unrecognisable case must not land on the gated path.
    expect(kindOf("")).toBe("keyword");
    expect(kindOf("four or more loose words here")).toBe("keyword");
  });
});

describe("ambiguity is reported, not resolved", () => {
  it("never claims certainty about a person", () => {
    const detection = detectSubjectKind("Jane Doe");
    expect(detection.kind).toBe("person");
    expect(detection.confidence).toBe("guess");
    expect(detection.alternatives).toContain("company");
  });

  it("offers domain alongside a dotted handle", () => {
    const detection = detectSubjectKind("first.last");
    expect(detection.alternatives).toContain("domain");
    expect(detection.confidence).toBe("guess");
  });

  it("leaves unambiguous input with no alternatives", () => {
    expect(detectSubjectKind("acme.com").alternatives).toEqual([]);
    expect(detectSubjectKind("93.184.216.34").alternatives).toEqual([]);
    expect(detectSubjectKind("j.doe@acme.com").alternatives).toEqual([]);
  });

  it("carries the normalized value so the run uses it", () => {
    expect(detectSubjectKind("https://ACME.com/x").normalized).toBe("ACME.com");
  });
});
