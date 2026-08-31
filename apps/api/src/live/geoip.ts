

import { UA } from "./http.js";

/**
 * Where an IP address is, roughly.
 *
 * Threat feeds publish addresses, not coordinates, so putting them on a map
 * means a geolocation lookup for each one. Two things follow.
 *
 * First, this is batched and cached hard. ip-api's free tier takes 100
 * addresses a request and allows 45 requests a minute from one address; a
 * naive loop over a thousand hosts would exhaust that in seconds and get the
 * whole layer blocked.
 *
 * Second, and worth stating plainly: IP geolocation is approximate. City-level
 * results are frequently the datacentre, the registrar, or the country
 * centroid. These dots say "an address registered around here", not "a machine
 * standing here", and the layer is described that way.
 */

export interface Located {
  ip: string;
  lat: number;
  lon: number;
  country: string | null;
  countryCode: string | null;
  city: string | null;
  asn: number | null;
  asName: string | null;
}

const BATCH = 100;
const TTL_MS = 24 * 60 * 60_000;

interface Row {
  status?: string;
  query?: string;
  lat?: number;
  lon?: number;
  country?: string;
  countryCode?: string;
  city?: string;
  as?: string;
  asname?: string;
}

function parseAsn(raw: string | undefined): number | null {
  const match = /^AS(\d+)/.exec(raw ?? "");
  return match === null ? null : Number(match[1]);
}

async function lookupBatch(ips: string[]): Promise<Located[]> {
  const response = await fetch(
    "http://ip-api.com/batch?fields=status,query,lat,lon,country,countryCode,city,as,asname",
    {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify(ips),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`ip-api responded ${response.status}`);
  const rows = (await response.json()) as Row[];

  return rows.flatMap((row) => {
    if (row.status !== "success") return [];
    if (typeof row.lat !== "number" || typeof row.lon !== "number") return [];
    return [
      {
        ip: row.query ?? "",
        lat: row.lat,
        lon: row.lon,
        country: row.country ?? null,
        countryCode: row.countryCode ?? null,
        city: row.city ?? null,
        asn: parseAsn(row.as),
        asName: row.asname ?? row.as ?? null,
      },
    ];
  });
}

/**
 * ip-api's free tier is plain HTTP only — HTTPS is a paid feature. The request
 * carries no credentials and no subject data, only addresses that are already
 * published on a threat blocklist, and it is made from the API process rather
 * than the browser.
 */
const known = new Map<string, { at: number; value: Located }>();

export async function locate(ips: string[]): Promise<Map<string, Located>> {
  const unique = [...new Set(ips.filter((ip) => ip.length > 0))];
  const found = new Map<string, Located>();
  const now = Date.now();

  // Cached per address rather than per batch, so a second layer asking about
  // a host the first one already placed costs nothing.
  const missing: string[] = [];
  for (const ip of unique) {
    const hit = known.get(ip);
    if (hit !== undefined && now - hit.at < TTL_MS) found.set(ip, hit.value);
    else missing.push(ip);
  }

  for (let i = 0; i < missing.length; i += BATCH) {
    try {
      for (const located of await lookupBatch(missing.slice(i, i + BATCH))) {
        found.set(located.ip, located);
        known.set(located.ip, { at: now, value: located });
      }
    } catch {
      // A batch that fails costs those hosts their dots, not the layer.
      break;
    }
    // 45 requests a minute is the documented limit; this stays inside it.
    if (i + BATCH < missing.length) {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }

  return found;
}
