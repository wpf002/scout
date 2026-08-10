import type { Source, Subject, UsernameSighting } from "@scout/sources";
import { outputLines, runCli } from "./run.js";

/**
 * Sherlock and Maigret.
 *
 * Both take a username and report where it exists across hundreds of sites,
 * and both print the same `[+] Site: url` line for a hit, so one parser serves
 * them. They are separate sources rather than one because their site lists
 * differ enough that running both finds more than running either.
 *
 * Both are `requiresScope`. This is the same profile as WhatsMyName, which is
 * already gated: one input produces hundreds of outbound requests about a
 * named individual. The gate is what makes that defensible, so it applies here
 * for the same reason.
 */

export const sherlockSource: Source = {
  id: "sherlock",
  name: "Sherlock",
  tier: "people",
  mode: "cli",
  requiresScope: true,
  accepts: ["username"],
  description: "Username presence across several hundred social platforms.",
  homepage: "https://github.com/sherlock-project/sherlock",
  keyEnv: null,
  binary: "sherlock",
};

export const maigretSource: Source = {
  id: "maigret",
  name: "Maigret",
  tier: "people",
  mode: "cli",
  requiresScope: true,
  accepts: ["username"],
  description:
    "Username presence across a wider site list, with profile detail where available.",
  homepage: "https://github.com/soxoj/maigret",
  keyEnv: null,
  binary: "maigret",
};

/** These enumerate hundreds of sites; the default timeout is not enough. */
const TIMEOUT_MS = 300_000;

export async function fetchSherlock(
  subject: Subject,
): Promise<UsernameSighting[]> {
  const { stdout } = await runCli(
    sherlockSource.binary as string,
    [subject.value, "--print-found", "--no-color", "--timeout", "10"],
    { timeoutMs: TIMEOUT_MS },
  );

  return parseSightings(stdout, subject.value);
}

export async function fetchMaigret(
  subject: Subject,
): Promise<UsernameSighting[]> {
  const { stdout } = await runCli(
    maigretSource.binary as string,
    [subject.value, "--no-color", "--timeout", "10"],
    { timeoutMs: TIMEOUT_MS },
  );

  return parseSightings(stdout, subject.value);
}

/**
 * Pulls found-profile lines out of either tool's output.
 *
 * Only `[+]` lines are read. Both tools also print `[-]` for a miss and `[?]`
 * for an inconclusive check, and an inconclusive result is not a sighting —
 * recording it as one would put a profile in a case file that was never
 * confirmed to exist.
 *
 * Exported for tests, so the parser can be checked without either tool
 * installed.
 */
export function parseSightings(
  stdout: string,
  username: string,
): UsernameSighting[] {
  const sightings: UsernameSighting[] = [];
  const seen = new Set<string>();

  for (const line of outputLines(stdout)) {
    const match = /^\[\+\]\s*([^:]+):\s*(https?:\/\/\S+)/.exec(line);
    if (match === null) continue;

    const site = match[1]?.trim();
    const url = match[2]?.trim();
    if (site === undefined || url === undefined) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    sightings.push({
      kind: "username-sighting",
      username,
      site,
      category: null,
      url,
    });
  }

  return sightings;
}
