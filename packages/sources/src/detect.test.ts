import { describe, expect, it } from "vitest";
import { asCoordinate, detectSubjectKind, isImoNumber, isMmsi, normalizeIndicator } from "./detect.js";

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

describe("location", () => {
  it("reads a decimal coordinate pair as a location", () => {
    expect(kindOf("32.9240, -96.7645")).toBe("location");
    expect(kindOf("32.9240 -96.7645")).toBe("location");
    expect(kindOf("-33.8688, 151.2093")).toBe("location");
  });

  it("is certain about a coordinate, with no alternatives to offer", () => {
    const d = detectSubjectKind("51.5074, -0.1278");
    expect(d.confidence).toBe("certain");
    expect(d.alternatives).toEqual([]);
  });

  it("reads degrees-minutes-seconds", () => {
    expect(kindOf("32°55'26\"N 96°45'11\"W")).toBe("location");
  });

  it("does not mistake an IP for a coordinate", () => {
    expect(kindOf("10.5.20.3")).toBe("ip");
    expect(kindOf("192.168.1.1")).toBe("ip");
  });

  it("leaves a bare integer pair alone — that is not a place", () => {
    expect(kindOf("32 96")).not.toBe("location");
  });

  it("refuses an out-of-range pair", () => {
    expect(asCoordinate("91.5, 0.0")).toBeNull();
    expect(asCoordinate("0.0, 181.5")).toBeNull();
  });

  it("returns the numbers a caller needs, not just the verdict", () => {
    expect(asCoordinate("32.9240, -96.7645")).toEqual({ lat: 32.924, lon: -96.7645 });
  });
});

describe("maritime, phone and address", () => {
  it("validates an IMO number by its check digit", () => {
    // 9074729 is a real IMO checksum; flipping the last digit must fail.
    expect(isImoNumber("9074729")).toBe(true);
    expect(isImoNumber("9074728")).toBe(false);
  });

  it("reads a prefixed IMO number as a vessel", () => {
    expect(kindOf("IMO 9074729")).toBe("vessel");
    expect(detectSubjectKind("IMO 9074729").normalized).toBe("IMO9074729");
  });

  it("accepts an MMSI only when the MID is a real flag state", () => {
    expect(isMmsi("366999712")).toBe(true);
    // 199 is below the MID range, so this is nine digits and not a ship.
    expect(isMmsi("199999712")).toBe(false);
  });

  it("offers phone as an alternative to a bare MMSI, never silently deciding", () => {
    const d = detectSubjectKind("366999712");
    expect(d.kind).toBe("vessel");
    expect(d.confidence).toBe("likely");
    expect(d.alternatives).toContain("phone");
  });

  it("reads E.164 as a phone and normalizes to digits", () => {
    const d = detectSubjectKind("+1 (555) 010-9999");
    expect(d.kind).toBe("phone");
    expect(d.normalized).toBe("+15550109999");
  });

  it("reads a punctuated number as a phone", () => {
    expect(kindOf("555-010-9999")).toBe("phone");
  });

  it("reads a street address", () => {
    expect(kindOf("1600 Pennsylvania Avenue NW")).toBe("address");
    expect(kindOf("221 Baker Street")).toBe("address");
  });

  it("does not call a company an address", () => {
    expect(kindOf("Anvil Logistics Inc")).toBe("company");
  });

  it("does not let a domain or IP fall into the new kinds", () => {
    expect(kindOf("acme.com")).toBe("domain");
    // acme.example stays a username with domain offered — .example is not a
    // known TLD, so the handle reading wins. Pre-existing and deliberate.
    expect(detectSubjectKind("acme.example").alternatives).toContain("domain");
    expect(kindOf("192.168.1.1")).toBe("ip");
    expect(kindOf("32.9240, -96.7645")).toBe("location");
  });
});
