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
 * Named explicitly rather than using `-b all`. `all` includes backends that
 * need their own API keys and ones that routinely hang, and a single slow
 * backend holds the whole run — which, inside a sweep, holds every other
 * source's results with it. These four are keyless and fast.
 */
const BACKENDS = "crtsh,anubis,hackertarget,rapiddns";

/** theHarvester is an aggregator itself, so it is legitimately slower. */
const TIMEOUT_MS = 180_000;

export async function fetchTheHarvester(
  subject: Subject,
): Promise<InfraObservation[]> {
  const { stdout } = await runCli(
    theHarvesterSource.binary as string,
    ["-d", subject.value, "-b", BACKENDS],
    { timeoutMs: TIMEOUT_MS },
  );

  return parseTheHarvester(stdout, subject.value);
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
