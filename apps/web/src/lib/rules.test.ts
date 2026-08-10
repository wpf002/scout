import { describe, expect, it } from "vitest";
import { analyze } from "./rules";
import type { ResultRow } from "./flatten";

const row = (over: Partial<ResultRow>): ResultRow => ({
  type: "Subdomains",
  value: "a.example.com",
  detail: "",
  sources: ["crt.sh"],
  occurrences: 1,
  url: null,
  evidence: [],
  ...over,
});

const host = (ip: string, observation: Record<string, unknown>): ResultRow =>
  row({
    type: "Hosts",
    value: ip,
    evidence: [{ source: "Shodan", observation: { kind: "host", ...observation } }],
  });

const daysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

describe("finding what matters in a long table", () => {
  it("says nothing when there is nothing to say", () => {
    // A rules layer that always fires is noise, and noise gets ignored —
    // taking the real findings with it.
    expect(analyze([row({})], "example.com")).toEqual([]);
  });

  it("flags a threat-intel association above everything else", () => {
    const insights = analyze(
      [
        host("1.2.3.4", { ports: [3306] }),
        row({ type: "Threat Intel", value: "Some Campaign" }),
      ],
      "example.com",
    );

    expect(insights[0]?.severity).toBe("high");
    expect(insights.map((i) => i.id)).toContain("threat-intel");
  });

  it("flags sensitive services, naming the port and protocol", () => {
    const insights = analyze([host("1.2.3.4", { ports: [80, 443, 3389] })], "x");
    const found = insights.find((i) => i.id === "sensitive-ports");

    expect(found?.evidence[0]).toContain("3389");
    expect(found?.evidence[0]).toContain("RDP");
    // 80 and 443 on a web host are not a finding.
    expect(found?.evidence.join(" ")).not.toContain(":443");
  });

  it("flags CVEs but says banner matching is fallible", () => {
    const insights = analyze(
      [host("1.2.3.4", { ports: [], vulns: ["CVE-2021-44228"] })],
      "x",
    );
    const found = insights.find((i) => i.id === "cves");

    expect(found?.evidence[0]).toContain("CVE-2021-44228");
    expect(found?.detail).toMatch(/false positive/i);
  });

  it("separates an expired certificate from one expiring soon", () => {
    const insights = analyze(
      [
        row({
          type: "Certificates",
          value: "old.example.com",
          evidence: [
            { source: "crt.sh", observation: { notAfter: daysFromNow(-10) } },
          ],
        }),
        row({
          type: "Certificates",
          value: "soon.example.com",
          evidence: [
            { source: "crt.sh", observation: { notAfter: daysFromNow(9) } },
          ],
        }),
      ],
      "x",
    );

    expect(insights.find((i) => i.id === "expired-certs")?.severity).toBe(
      "medium",
    );
    // Expiring soon is a reminder, not a finding, and is ranked accordingly.
    expect(insights.find((i) => i.id === "expiring-certs")?.severity).toBe("low");
  });

  it("ignores a certificate valid for another year", () => {
    const insights = analyze(
      [
        row({
          type: "Certificates",
          value: "fine.example.com",
          evidence: [
            { source: "crt.sh", observation: { notAfter: daysFromNow(300) } },
          ],
        }),
      ],
      "x",
    );
    expect(insights).toEqual([]);
  });

  it("picks out non-production names", () => {
    const insights = analyze(
      [
        row({ value: "staging.example.com" }),
        row({ value: "jenkins.example.com" }),
        row({ value: "www.example.com" }),
      ],
      "x",
    );
    const found = insights.find((i) => i.id === "non-prod");

    expect(found?.evidence).toContain("staging.example.com");
    expect(found?.evidence).toContain("jenkins.example.com");
    expect(found?.evidence).not.toContain("www.example.com");
  });

  it("counts named people but not shared mailboxes", () => {
    const insights = analyze(
      [
        row({
          type: "Emails",
          value: "ryan@example.com",
          detail: "Ryan White · Creative Director · 98% match",
        }),
        row({
          type: "Emails",
          value: "info@example.com",
          detail: "Shared mailbox · 96% match",
        }),
      ],
      "x",
    );
    const found = insights.find((i) => i.id === "named-people");

    expect(found?.title).toContain("1 named individual");
  });

  it("flags a young domain and leaves an old one alone", () => {
    const young = analyze(
      [
        row({
          type: "Web Scans",
          value: "New Site",
          evidence: [
            { source: "urlscan.io", observation: { domainAgeDays: 12 } },
          ],
        }),
      ],
      "new.example.com",
    );
    expect(young.find((i) => i.id === "young-domain")).toBeDefined();

    const old = analyze(
      [
        row({
          type: "Web Scans",
          value: "Old Site",
          evidence: [
            { source: "urlscan.io", observation: { domainAgeDays: 2507 } },
          ],
        }),
      ],
      "old.example.com",
    );
    expect(old.find((i) => i.id === "young-domain")).toBeUndefined();
  });

  it("never claims impact, only what was observed", () => {
    // The rules report facts. Whether a fact matters depends on context the
    // tool does not have, and asserting otherwise would be the tool guessing.
    const insights = analyze(
      [host("1.2.3.4", { ports: [22], vulns: ["CVE-2020-0001"] })],
      "x",
    );

    for (const insight of insights) {
      expect(insight.detail).not.toMatch(/you are (vulnerable|compromised)/i);
    }
    expect(insights.find((i) => i.id === "sensitive-ports")?.detail).toMatch(
      /deliberate|controls/i,
    );
  });
});
