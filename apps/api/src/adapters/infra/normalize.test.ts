/**
 * Normalizer tests.
 *
 * The normalizers are pure functions over fixture payloads, so the shape each
 * upstream produces is pinned without a network call and without a key. This
 * is the part of an adapter that actually has logic in it; the fetch around it
 * is plumbing.
 */
import { describe, expect, it } from "vitest";
import { normalizeCrtsh } from "./crtsh.js";
import { normalizeShodanDomain, normalizeShodanHost } from "./shodan.js";
import {
  normalizeSecurityTrailsIps,
  normalizeSecurityTrailsSubdomains,
} from "./securitytrails.js";
import { normalizeCensys } from "./censys.js";
import { mergeObservations } from "@scout/sources";

describe("crt.sh", () => {
  const rows = [
    {
      common_name: "example.com",
      name_value: "example.com\nwww.example.com\n*.example.com",
      issuer_name: "C=US, O=Let's Encrypt, CN=R3",
      serial_number: "04a1",
      not_before: "2026-01-01T00:00:00",
      not_after: "2026-04-01T00:00:00",
    },
    {
      common_name: "admin.example.com",
      name_value: "admin.example.com\nunrelated.other.net",
      issuer_name: "C=US, O=Let's Encrypt, CN=R3",
      serial_number: "04a2",
      not_before: "2026-02-01T00:00:00",
      not_after: "2026-05-01T00:00:00",
    },
  ];

  const observations = normalizeCrtsh(rows, "example.com");

  it("emits one cert observation per row", () => {
    expect(observations.filter((o) => o.kind === "cert")).toHaveLength(2);
  });

  it("pulls SANs out as subdomains", () => {
    const hostnames = observations
      .filter((o) => o.kind === "subdomain")
      .map((o) => (o.kind === "subdomain" ? o.hostname : ""));
    expect(hostnames).toContain("www.example.com");
    expect(hostnames).toContain("admin.example.com");
  });

  it("never emits a wildcard as a subdomain", () => {
    // `*.example.com` is not a host you can resolve. It stays on the cert.
    const hostnames = observations
      .filter((o) => o.kind === "subdomain")
      .map((o) => (o.kind === "subdomain" ? o.hostname : ""));
    expect(hostnames.some((h) => h.startsWith("*"))).toBe(false);

    const certNames = observations.flatMap((o) =>
      o.kind === "cert" ? o.names : [],
    );
    expect(certNames).toContain("*.example.com");
  });

  it("drops SANs that are not under the subject domain", () => {
    const hostnames = observations
      .filter((o) => o.kind === "subdomain")
      .map((o) => (o.kind === "subdomain" ? o.hostname : ""));
    expect(hostnames).not.toContain("unrelated.other.net");
  });

  it("does not treat a lookalike apex as in-domain", () => {
    const sneaky = normalizeCrtsh(
      [
        {
          common_name: "notexample.com",
          name_value: "notexample.com",
          issuer_name: null,
          serial_number: "1",
          not_before: null,
          not_after: null,
        },
      ],
      "example.com",
    );
    expect(sneaky.filter((o) => o.kind === "subdomain")).toHaveLength(0);
  });

  it("handles an empty result set", () => {
    expect(normalizeCrtsh([], "example.com")).toEqual([]);
  });
});

describe("Shodan", () => {
  it("expands subdomain labels onto the apex and lifts A records to hosts", () => {
    const observations = normalizeShodanDomain({
      domain: "example.com",
      subdomains: ["www", "mail"],
      data: [
        {
          subdomain: "www",
          type: "A",
          value: "203.0.113.10",
          last_seen: "2026-01-05",
        },
        { subdomain: "", type: "MX", value: "mx.example.com", last_seen: null },
      ],
    });

    const hostnames = observations
      .filter((o) => o.kind === "subdomain")
      .map((o) => (o.kind === "subdomain" ? o.hostname : ""));
    expect(hostnames).toContain("www.example.com");
    expect(hostnames).toContain("mail.example.com");
    // The empty label is the apex itself, not "".
    expect(hostnames).toContain("example.com");

    const hosts = observations.filter((o) => o.kind === "host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.kind === "host" && hosts[0].ip).toBe("203.0.113.10");
  });

  it("normalizes a host lookup with sorted, unique integer ports", () => {
    const observations = normalizeShodanHost({
      ip_str: "203.0.113.10",
      hostnames: ["WWW.example.com"],
      ports: [443, 80, 443],
      org: "Example Org",
      asn: "AS64496",
      country_name: "US",
      last_update: "2026-01-05",
    });

    const host = observations[0];
    if (host?.kind !== "host") throw new Error("expected a host observation");
    expect(host.ports).toEqual([80, 443]);
    expect(host.hostnames).toEqual(["www.example.com"]);
    expect(host.asn).toBe("AS64496");
  });
});

describe("SecurityTrails", () => {
  it("joins bare labels onto the apex so they dedupe against crt.sh", () => {
    const observations = normalizeSecurityTrailsSubdomains(
      { subdomains: ["www", "admin", "www"] },
      "example.com",
    );
    const hostnames = observations.map((o) =>
      o.kind === "subdomain" ? o.hostname : "",
    );
    expect(hostnames).toEqual(["admin.example.com", "www.example.com"]);
  });

  it("normalizes nearby IP blocks into hosts", () => {
    const observations = normalizeSecurityTrailsIps({
      blocks: [
        {
          ip: "203.0.113.10",
          hostname: "WWW.example.com",
          organization: "Example Org",
        },
      ],
    });
    const host = observations[0];
    if (host?.kind !== "host") throw new Error("expected a host observation");
    expect(host.hostnames).toEqual(["www.example.com"]);
    expect(host.org).toBe("Example Org");
  });
});

describe("Censys", () => {
  it("normalizes hits into hosts with ASN prefixed", () => {
    const observations = normalizeCensys({
      result: {
        hits: [
          {
            ip: "203.0.113.10",
            names: ["www.example.com", "www.example.com"],
            autonomous_system: { asn: 64496, name: "EXAMPLE-AS" },
            location: { country: "US" },
            services: [{ port: 443 }, { port: 80 }],
            last_updated_at: "2026-01-05T00:00:00Z",
          },
        ],
      },
    });

    const host = observations[0];
    if (host?.kind !== "host") throw new Error("expected a host observation");
    expect(host.asn).toBe("AS64496");
    expect(host.org).toBe("EXAMPLE-AS");
    expect(host.ports).toEqual([80, 443]);
    expect(host.hostnames).toEqual(["www.example.com"]);
  });

  it("skips hits with no IP rather than emitting a blank host", () => {
    expect(
      normalizeCensys({
        result: {
          hits: [
            {
              ip: "",
              names: [],
              autonomous_system: null,
              location: null,
              services: [],
              last_updated_at: null,
            },
          ],
        },
      }),
    ).toEqual([]);
  });
});

describe("cross-source merge — the point of normalizing at all", () => {
  it("folds the same subdomain from three sources into one attributed row", () => {
    const crtsh = normalizeCrtsh(
      [
        {
          common_name: "www.example.com",
          name_value: "www.example.com",
          issuer_name: null,
          serial_number: "1",
          not_before: null,
          not_after: null,
        },
      ],
      "example.com",
    );
    const shodan = normalizeShodanDomain({
      domain: "example.com",
      subdomains: ["www"],
      data: [],
    });
    const st = normalizeSecurityTrailsSubdomains(
      { subdomains: ["www"] },
      "example.com",
    );

    const merged = mergeObservations([
      ...crtsh.map((observation) => ({ sourceId: "crtsh", observation })),
      ...shodan.map((observation) => ({ sourceId: "shodan", observation })),
      ...st.map((observation) => ({
        sourceId: "securitytrails",
        observation,
      })),
    ]);

    const www = merged.find(
      (m) =>
        m.observation.kind === "subdomain" &&
        m.observation.hostname === "www.example.com",
    );
    expect(www).toBeDefined();
    expect(www?.sourceIds.sort()).toEqual([
      "crtsh",
      "securitytrails",
      "shodan",
    ]);
  });
});
