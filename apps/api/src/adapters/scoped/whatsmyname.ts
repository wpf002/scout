import { z } from "zod";
import type { Subject, UsernameSighting } from "@scout/sources";
import { requireSource } from "@scout/sources";
import { TtlCache } from "../../lib/cache.js";

export const whatsMyNameSource = requireSource("whatsmyname");

const WMN_DATA_URL =
  "https://raw.githubusercontent.com/WebBreacher/WhatsMyName/main/wmn-data.json";

const PROBE_TIMEOUT_MS = 6_000;
const DATA_TIMEOUT_MS = 20_000;
const DEFAULT_SITE_LIMIT = 40;
const CONCURRENCY = 8;

const siteSchema = z.object({
  name: z.string(),
  uri_check: z.string(),
  e_code: z.number().int(),
  e_string: z.string(),
  m_string: z.string().optional(),
  m_code: z.number().int().optional(),
  cat: z.string().optional(),
  known: z.array(z.string()).optional(),
});

const dataSchema = z.object({ sites: z.array(siteSchema).default([]) });

export type WmnSite = z.infer<typeof siteSchema>;

/** The site list is large and changes rarely; refetching it per query is rude. */
const siteListCache = new TtlCache<WmnSite[]>({
  ttlMs: 6 * 60 * 60 * 1000,
  maxEntries: 1,
});

export async function loadSites(): Promise<WmnSite[]> {
  const cached = siteListCache.get("wmn");
  if (cached !== undefined) return cached;

  const response = await fetch(WMN_DATA_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(DATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`WhatsMyName data responded ${response.status}`);
  }

  const sites = dataSchema.parse(await response.json()).sites;
  siteListCache.set("wmn", sites);
  return sites;
}

/**
 * Decides whether a probe response means the account exists.
 *
 * Both conditions must hold — the expected status AND the expected marker
 * string. Status alone produces false positives on sites that return 200 for
 * every profile URL, and a false positive here is an assertion that a named
 * person holds an account they may not.
 */
export function isHit(
  site: WmnSite,
  status: number,
  body: string,
): boolean {
  return status === site.e_code && body.includes(site.e_string);
}

export function siteLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["WHATSMYNAME_SITE_LIMIT"];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SITE_LIMIT;
}

async function probe(
  site: WmnSite,
  username: string,
): Promise<UsernameSighting | null> {
  const url = site.uri_check.replace("{account}", encodeURIComponent(username));
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "user-agent": "Scout-OSINT/0.1 (+authorized-engagement-tooling)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!isHit(site, response.status, body)) return null;
    return {
      kind: "username-sighting",
      username,
      site: site.name,
      category: site.cat ?? null,
      url,
    };
  } catch {
    // A site that times out or refuses is not evidence either way. Silence is
    // the honest answer — reporting it as "not found" would be a claim we did
    // not establish.
    return null;
  }
}

/**
 * Username enumeration across public sites.
 *
 * This is the most invasive thing Scout does: it makes dozens of requests to
 * third parties about one named person. So it is scope-gated, requires
 * confirmation, is capped at `WHATSMYNAME_SITE_LIMIT` sites per query, and is
 * inert until an operator sets `WHATSMYNAME_ENABLED` — there is no API key to
 * act as an accidental off switch, so the switch is explicit.
 */
export async function fetchWhatsMyName(
  subject: Subject,
): Promise<UsernameSighting[]> {
  if (process.env["WHATSMYNAME_ENABLED"]?.trim() !== "true") {
    throw new Error("WHATSMYNAME_ENABLED is not set");
  }

  const username = subject.value.trim();
  const limit = siteLimit();
  const sites = (await loadSites()).slice(0, limit);

  const found: UsernameSighting[] = [];
  // Bounded concurrency: enumeration is a fan-out across sites, and hammering
  // forty hosts at once is both rude and conspicuous.
  for (let i = 0; i < sites.length; i += CONCURRENCY) {
    const batch = sites.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map((site) => probe(site, username)),
    );
    for (const sighting of settled) {
      if (sighting !== null) found.push(sighting);
    }
  }

  return found;
}
