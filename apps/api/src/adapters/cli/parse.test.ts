import { describe, expect, it } from "vitest";
import { parseTheHarvester } from "./theharvester.js";
import { parseSightings } from "./sherlock.js";
import { outputLines, parseJsonOutput } from "./run.js";

describe("theHarvester output", () => {
  const report = [
    "*******************************************************************",
    "*  theHarvester 4.5.0                                             *",
    "*******************************************************************",
    "",
    "[*] Target: example.com",
    "",
    "[*] Emails found:",
    "------------------",
    "press@example.com",
    "",
    "[*] Hosts found: 4",
    "---------------------",
    "www.example.com:93.184.216.34",
    "mail.example.com",
    "WWW.EXAMPLE.COM:93.184.216.34",
    "unrelated.attacker.test:10.0.0.1",
  ].join("\n");

  it("reads hosts out of the hosts section", () => {
    const found = parseTheHarvester(report, "example.com");
    const names = found
      .filter((o) => o.kind === "subdomain")
      .map((o) => (o as { hostname: string }).hostname);

    expect(names).toContain("www.example.com");
    expect(names).toContain("mail.example.com");
  });

  it("does not read the emails section as hosts", () => {
    const found = parseTheHarvester(report, "example.com");
    const names = found.map((o) =>
      o.kind === "subdomain" ? (o as { hostname: string }).hostname : "",
    );
    expect(names).not.toContain("press@example.com");
  });

  it("drops hosts belonging to a different domain", () => {
    // An upstream backend returning an unrelated hit must not have it
    // attributed to this subject.
    const found = parseTheHarvester(report, "example.com");
    expect(JSON.stringify(found)).not.toContain("attacker.test");
  });

  it("deduplicates case-insensitively", () => {
    const found = parseTheHarvester(report, "example.com");
    const www = found.filter(
      (o) =>
        o.kind === "subdomain" &&
        (o as { hostname: string }).hostname === "www.example.com",
    );
    expect(www).toHaveLength(1);
  });

  it("pairs an address with its hostname when one is present", () => {
    const found = parseTheHarvester(report, "example.com");
    const host = found.find((o) => o.kind === "host");
    expect(host).toMatchObject({ ip: "93.184.216.34", ports: [] });
  });

  it("returns nothing rather than throwing on empty output", () => {
    expect(parseTheHarvester("", "example.com")).toEqual([]);
  });
});

describe("Sherlock and Maigret output", () => {
  const report = [
    "[*] Checking username someone on:",
    "[+] GitHub: https://github.com/someone",
    "[+] Reddit: https://reddit.com/user/someone",
    "[-] Facebook: Not Found!",
    "[?] Pinterest: Error connecting",
    "[+] GitHub: https://github.com/someone",
  ].join("\n");

  it("keeps only confirmed sightings", () => {
    const found = parseSightings(report, "someone");
    const sites = found.map((s) => s.site);

    expect(sites).toContain("GitHub");
    expect(sites).toContain("Reddit");
    expect(sites).not.toContain("Facebook");
  });

  it("treats an inconclusive check as no sighting", () => {
    // A profile that was never confirmed to exist must not land in a case
    // file as though it had been.
    const found = parseSightings(report, "someone");
    expect(found.map((s) => s.site)).not.toContain("Pinterest");
  });

  it("deduplicates repeated urls", () => {
    const found = parseSightings(report, "someone");
    expect(found.filter((s) => s.site === "GitHub")).toHaveLength(1);
  });

  it("carries the username onto every sighting", () => {
    for (const sighting of parseSightings(report, "someone")) {
      expect(sighting.username).toBe("someone");
      expect(sighting.kind).toBe("username-sighting");
    }
  });

  it("returns nothing rather than throwing on empty output", () => {
    expect(parseSightings("", "someone")).toEqual([]);
  });
});

describe("output helpers", () => {
  it("strips ansi colour codes", () => {
    expect(outputLines("[32m[+] GitHub[0m")).toEqual(["[+] GitHub"]);
  });

  it("finds json after a leading banner", () => {
    expect(
      parseJsonOutput<{ ok: boolean }>('banner text\n{"ok":true}'),
    ).toEqual({ ok: true });
  });

  it("returns null on unparseable output rather than throwing", () => {
    expect(parseJsonOutput("no json here")).toBeNull();
    expect(parseJsonOutput("{broken")).toBeNull();
  });
});
