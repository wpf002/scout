import type { InfraObservation, Source, Subject } from "@scout/sources";
import { outputLines, runCli } from "./run.js";

export const theHarvesterSource: Source = {
  id: "theharvester",
  name: "theHarvester",
  tier: "infra",
  mode: "cli",
  requiresScope: false,
  accepts: ["domain"],
  description:
    "Subdomain and host enumeration aggregated across public search sources.",
  homepage: "https://github.com/laramies/theHarvester",
  keyEnv: null,
  binary: "theHarvester",
};

/**
 * Sources theHarvester queries.
 *
 * Deliberately none that Scout already queries directly. It used to run
 * crtsh, hackertarget, rapiddns, otx and certspotter — every one of which is
 * now a first-class adapter here. So it spent 62 seconds re-fetching data
 * Scout had already collected, and most of that was spent waiting on crt.sh
 * (502ing) and HackerTarget (quota spent) rather than finding anything.
 *
 * Pointed at search engines and subdomain indexes Scout has no adapter for,
 * the same domain took 17 seconds and returned 14 hosts instead of 7 — faster
 * and better, because it is finally being asked something the other sources
 * cannot answer.
 *
 * Every name must exist in the installed version: theHarvester rejects an
 * unknown backend by refusing the whole invocation and printing nothing, which
 * silently produces "no results" for every domain.
 */
const BACKENDS = "duckduckgo,mojeek,subdomaincenter,subdomainfinderc99";

/** Still an aggregator, but no longer waiting on dead upstreams. */
const TIMEOUT_MS = 90_000;

export async function fetchTheHarvester(
  subject: Subject,
): Promise<InfraObservation[]> {
  const { stdout, stderr, code, timedOut } = await runCli(
    theHarvesterSource.binary as string,
    ["-d", subject.value, "-b", BACKENDS],
    { timeoutMs: TIMEOUT_MS },
  );

  const observations = parseTheHarvester(stdout, subject.value);
  if (observations.length > 0) return observations;

  // Nothing parsed. That is either a genuine empty result or a run that never
  // happened, and the two must not look alike — an investigator reading "no
  // results" concludes there is nothing out there, which is a finding, while
  // "it refused to start" is not. So an empty parse is only accepted when the
  // tool actually completed and reported its host section.
  assertRan(stdout, stderr, code, timedOut);
  return observations;
}

/**
 * Throws unless the tool genuinely ran and found nothing.
 *
 * Exported for tests. The distinction it draws is the one that matters when a
 * source produces no rows: silence because there was nothing, or silence
 * because the tool never got started.
 */
export function assertRan(
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean,
): void {
  if (timedOut) {
    throw new Error("theHarvester timed out before reporting.");
  }

  const combined = `${stdout}\n${stderr}`;

  const invalid = /not supported|invalid source/i.exec(combined);
  if (invalid !== null) {
    throw new Error(
      "theHarvester rejected the backend list; no search was performed.",
    );
  }

  // The host section header is printed even when the count is zero, so its
  // absence means the run did not reach the reporting stage.
  if (!/\[\*\]\s+(No hosts found|Hosts found)/i.test(combined)) {
    if (code !== 0 && code !== null) {
      throw new Error(`theHarvester exited with ${code} without reporting.`);
    }
    throw new Error("theHarvester produced no report.");
  }
}

/**
 * Pulls hosts out of theHarvester's report.
 *
 * Parsed from the human-readable stdout rather than the `-f` JSON file,
 * because the file path has to be unique per concurrent run and cleaned up
 * afterwards, and the JSON schema has changed shape between releases while
 * the "[*] Hosts found:" section has not.
 *
 * Exported for tests: the parser is the part that breaks when the tool
 * updates, and it should be testable without the tool installed.
 */
export function parseTheHarvester(
  stdout: string,
  domain: string,
): InfraObservation[] {
  const observations: InfraObservation[] = [];
  const seen = new Set<string>();
  let inHosts = false;

  for (const line of outputLines(stdout)) {
    if (/^\[\*\]\s+Hosts found/i.test(line)) {
      inHosts = true;
      continue;
    }
    // Any other section header ends the host block.
    if (/^\[\*\]/.test(line)) {
      inHosts = false;
      continue;
    }
    if (!inHosts) continue;
    if (/^-+$/.test(line)) continue;

    // Rows are `hostname` or `hostname:ip`.
    const [rawHost, rawIp] = line.split(":", 2);
    const hostname = rawHost?.trim().toLowerCase();
    if (hostname === undefined || hostname.length === 0) continue;

    // A run for one domain should not report names belonging to another. The
    // upstream backends occasionally return unrelated hits, and letting those
    // through would attribute a finding to the wrong subject.
    if (!hostname.endsWith(domain.toLowerCase())) continue;
    if (seen.has(hostname)) continue;
    seen.add(hostname);

    observations.push({
      kind: "subdomain",
      hostname,
      firstSeen: null,
      lastSeen: null,
    });

    const ip = rawIp?.trim();
    if (ip !== undefined && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      observations.push({
        kind: "host",
        ip,
        hostnames: [hostname],
        ports: [],
        org: null,
        asn: null,
        country: null,
        lastSeen: null,
      });
    }
  }

  return observations;
}
