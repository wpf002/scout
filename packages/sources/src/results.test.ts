import { describe, expect, it } from "vitest";
import type { InfraObservation } from "./results.js";
import { mergeObservations, observationKey } from "./results.js";

const sub = (hostname: string, extra: Partial<InfraObservation> = {}) =>
  ({
    kind: "subdomain",
    hostname,
    firstSeen: null,
    lastSeen: null,
    ...extra,
  }) as InfraObservation;

describe("observationKey", () => {
  it("keys subdomains case-insensitively", () => {
    expect(observationKey(sub("WWW.Example.com"))).toBe(
      observationKey(sub("www.example.com")),
    );
  });

  it("never collides across kinds", () => {
    const keys = [
      observationKey(sub("a.example.com")),
      observationKey({
        kind: "host",
        ip: "a.example.com",
        hostnames: [],
        ports: [],
        org: null,
        asn: null,
        country: null,
        lastSeen: null,
      }),
    ];
    expect(new Set(keys).size).toBe(2);
  });

  it("prefers the certificate serial as identity", () => {
    const base = {
      kind: "cert" as const,
      commonName: "example.com",
      names: [],
      issuer: null,
      notBefore: null,
      notAfter: null,
    };
    expect(observationKey({ ...base, serial: "0A1B" })).toBe(
      observationKey({ ...base, serial: "0a1b", commonName: "other.example" }),
    );
  });
});

describe("mergeObservations", () => {
  it("dedupes the same subdomain seen by two sources and credits both", () => {
    const merged = mergeObservations([
      { sourceId: "crtsh", observation: sub("admin.example.com") },
      { sourceId: "securitytrails", observation: sub("admin.example.com") },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceIds.sort()).toEqual(["crtsh", "securitytrails"]);
  });

  it("does not credit the same source twice", () => {
    const merged = mergeObservations([
      { sourceId: "crtsh", observation: sub("a.example.com") },
      { sourceId: "crtsh", observation: sub("a.example.com") },
    ]);
    expect(merged[0]?.sourceIds).toEqual(["crtsh"]);
  });

  it("unions host ports and hostnames rather than picking a winner", () => {
    const merged = mergeObservations([
      {
        sourceId: "shodan",
        observation: {
          kind: "host",
          ip: "203.0.113.10",
          hostnames: ["www.example.com"],
          ports: [443, 80],
          org: "Example Org",
          asn: null,
          country: null,
          lastSeen: null,
        },
      },
      {
        sourceId: "censys",
        observation: {
          kind: "host",
          ip: "203.0.113.10",
          hostnames: ["mail.example.com"],
          ports: [25, 443],
          org: null,
          asn: "AS64496",
          country: "US",
          lastSeen: "2026-01-01",
        },
      },
    ]);

    expect(merged).toHaveLength(1);
    const host = merged[0]?.observation;
    expect(host?.kind).toBe("host");
    if (host?.kind !== "host") throw new Error("expected a host observation");

    expect(host.ports).toEqual([25, 80, 443]);
    expect(host.hostnames).toEqual(["mail.example.com", "www.example.com"]);
    // Fills the gaps from whichever source actually had the field.
    expect(host.org).toBe("Example Org");
    expect(host.asn).toBe("AS64496");
    expect(host.country).toBe("US");
    expect(merged[0]?.sourceIds.sort()).toEqual(["censys", "shodan"]);
  });

  it("keeps ports as integers and sorted", () => {
    const merged = mergeObservations([
      {
        sourceId: "shodan",
        observation: {
          kind: "host",
          ip: "203.0.113.1",
          hostnames: [],
          ports: [8443, 22, 8443],
          org: null,
          asn: null,
          country: null,
          lastSeen: null,
        },
      },
    ]);
    const host = merged[0]?.observation;
    if (host?.kind !== "host") throw new Error("expected a host observation");
    expect(host.ports).toEqual([22, 8443]);
    expect(host.ports.every(Number.isInteger)).toBe(true);
  });

  it("keeps distinct things distinct", () => {
    const merged = mergeObservations([
      { sourceId: "crtsh", observation: sub("a.example.com") },
      { sourceId: "crtsh", observation: sub("b.example.com") },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("returns an empty list for no input", () => {
    expect(mergeObservations([])).toEqual([]);
  });
});
