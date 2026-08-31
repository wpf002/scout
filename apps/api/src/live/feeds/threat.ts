import { z } from "zod";
import { cached } from "../cache.js";
import { getJson, getText } from "../http.js";
import { locate } from "../geoip.js";
import { line, point, type Feature, type FeatureCollection } from "../types.js";

/**
 * Live threat infrastructure, from abuse.ch.
 *
 * One thing to know about this source: the URLhaus *API* now requires an
 * Auth-Key, but the bulk dumps at urlhaus.abuse.ch/downloads/ do not. Those
 * dumps are what this uses, which is why the layer works with no key at all.
 *
 * And one thing to be honest about: nothing here is an observed attack. These
 * are hosts currently serving malware and command-and-control servers
 * currently online. A map that drew arcs between random points and called them
 * live attacks would look better and mean nothing.
 */

const URLHAUS_CSV = "https://urlhaus.abuse.ch/downloads/csv_recent/";
const FEODO_JSON = "https://feodotracker.abuse.ch/downloads/ipblocklist.json";

const TTL_MS = 10 * 60_000;

interface Payload {
  id: string;
  url: string;
  host: string;
  malware: string;
  threatType: string;
  status: string;
  firstSeen: string | null;
  reporter: string | null;
  tags: string[];
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * The dump is CSV with a hash-comment preamble and quoted fields. Columns:
 * id, dateadded, url, url_status, last_online, threat, tags, urlhaus_link,
 * reporter.
 */
function parseUrlhaus(csv: string): Payload[] {
  const out: Payload[] = [];

  for (const raw of csv.split("\n")) {
    const row = raw.trim();
    if (row.length === 0 || row.startsWith("#")) continue;

    const cells = row.match(/"([^"]*)"/g)?.map((c) => c.slice(1, -1)) ?? [];
    if (cells.length < 8) continue;

    const [id, dateAdded, url, status, , threat, tags, , reporter] = cells;
    if (url === undefined || id === undefined) continue;

    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    // Only addresses can be placed. A domain would need resolving, and
    // resolving thousands of malware domains from this process is neither
    // fast nor a good idea.
    if (!IPV4.test(host)) continue;

    const tagList = (tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    out.push({
      id,
      url,
      host,
      malware: tagList[0] ?? (threat ?? "malware"),
      threatType: threat ?? "malware_download",
      status: status ?? "unknown",
      firstSeen: dateAdded ?? null,
      reporter: reporter ?? null,
      tags: tagList,
    });
  }
  return out;
}

/** Newest first, one entry per host — a host serving forty payloads is one dot. */
function byHost(payloads: Payload[]): Map<string, Payload & { urlCount: number }> {
  const map = new Map<string, Payload & { urlCount: number }>();
  for (const payload of payloads) {
    const existing = map.get(payload.host);
    if (existing === undefined) map.set(payload.host, { ...payload, urlCount: 1 });
    else existing.urlCount += 1;
  }
  return map;
}

async function loadPayloadHosts() {
  const csv = await getText(URLHAUS_CSV, { timeoutMs: 60_000 });
  return byHost(parseUrlhaus(csv));
}

const MALWARE_LIMIT = 900;

/** Enough C2 to read as infrastructure without spending the whole geoip budget. */
const C2_LIMIT = 400;

export async function malware(): Promise<FeatureCollection> {
  const hosts = await cached("urlhaus-hosts", TTL_MS, loadPayloadHosts);

  // Online hosts first — a host still serving is the one that matters, and the
  // geolocation budget should be spent there.
  const ranked = [...hosts.values()]
    .sort((a, b) =>
      a.status === b.status ? b.urlCount - a.urlCount : a.status === "online" ? -1 : 1,
    )
    .slice(0, MALWARE_LIMIT);

  const placed = await locate(ranked.map((h) => h.host));

  return {
    type: "FeatureCollection",
    features: ranked.flatMap((host) => {
      const where = placed.get(host.host);
      if (where === undefined) return [];
      return [
        point(where.lon, where.lat, {
          layer: "malware",
          id: `urlhaus-${host.host}`,
          label: `${host.malware} — ${where.city ?? where.country ?? host.host}`,
          ip: host.host,
          malware: host.malware,
          threatType: host.threatType,
          status: host.status,
          urlCount: host.urlCount,
          country: where.country,
          city: where.city,
          asn: where.asn,
          asName: where.asName,
          firstSeen: host.firstSeen,
          reporter: host.reporter,
          tags: host.tags.join(", "),
          url: `https://urlhaus.abuse.ch/host/${host.host}/`,
          colour: host.status === "online" ? "#ff3b52" : "#8e8e93",
        }),
      ];
    }),
    meta: {
      source: "abuse.ch URLhaus",
      hostsSeen: hosts.size,
      note: "Hosts observed serving malware. Positions are IP geolocation, which is approximate.",
    },
  };
}

// ── Command and control ────────────────────────────────────────────────────

const THREATFOX_SCHEMA = z.record(
  z.string(),
  z.array(
    z.object({
      ioc_value: z.string(),
      ioc_type: z.string(),
      threat_type: z.string().nullable().optional(),
      malware: z.string().nullable().optional(),
      malware_printable: z.string().nullable().optional(),
      confidence_level: z.number().nullable().optional(),
      first_seen_utc: z.string().nullable().optional(),
      last_seen_utc: z.string().nullable().optional(),
      reporter: z.string().nullable().optional(),
      // A comma-separated string, not an array — the API's own docs say
      // otherwise, which is why this is pinned to what it actually sends.
      tags: z.string().nullable().optional(),
    }),
  ),
);

const THREATFOX_JSON = "https://threatfox.abuse.ch/export/json/recent/";

interface C2 {
  ip: string;
  port: number | null;
  malware: string;
  threatType: string;
  confidence: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  reporter: string | null;
}

/**
 * Command-and-control servers, from abuse.ch ThreatFox.
 *
 * Feodo Tracker is the obvious choice and is the wrong one: it is still
 * served, still keyless, and down to a handful of entries whose most recent
 * sighting is months old. It is alive but empty, which on a map is worse than
 * absent — five dots read as "quiet", not as "this feed stopped". ThreatFox is
 * its live replacement and carries thousands of current indicators.
 */
async function loadC2(): Promise<C2[]> {
  const body = await getText(THREATFOX_JSON, { timeoutMs: 60_000 });
  const parsed = THREATFOX_SCHEMA.parse(JSON.parse(body));

  const out: C2[] = [];
  for (const rows of Object.values(parsed)) {
    for (const row of rows) {
      // `ip:port` is the only type that can be placed. A domain would need
      // resolving, and resolving thousands of C2 domains from this process is
      // neither fast nor a good idea.
      if (row.ioc_type !== "ip:port") continue;
      const split = row.ioc_value.lastIndexOf(":");
      const ip = split === -1 ? row.ioc_value : row.ioc_value.slice(0, split);
      if (!IPV4.test(ip)) continue;

      out.push({
        ip,
        port: split === -1 ? null : Number(row.ioc_value.slice(split + 1)) || null,
        malware: row.malware_printable ?? row.malware ?? "Unknown",
        threatType: row.threat_type ?? "botnet_cc",
        confidence: row.confidence_level ?? null,
        firstSeen: row.first_seen_utc ?? null,
        lastSeen: row.last_seen_utc ?? null,
        reporter: row.reporter ?? null,
      });
    }
  }
  return out;
}

const FAMILY_COLOUR: Record<string, string> = {
  Emotet: "#ff3b52",
  QakBot: "#ff9f0a",
  IcedID: "#ffd60a",
  Dridex: "#e0173a",
  TrickBot: "#c8b0ff",
  BumbleBee: "#5ac8fa",
  Pikabot: "#30d0c0",
};

/**
 * Botnet command-and-control servers, linked to payload hosts of the same
 * malware family.
 *
 * Each line joins two addresses that abuse.ch is currently observing in the
 * same campaign: a C2 server from Feodo Tracker, and a host serving that
 * family's payload from URLhaus. That relationship is real and published.
 *
 * What it is not, and what the reference implementation's equivalent layer
 * quietly is: a live attack. There is no keyless feed of observed attacks with
 * both endpoints, so drawing one would mean inventing the coordinates. This
 * draws infrastructure, and says so.
 */
export async function attackInfrastructure(): Promise<FeatureCollection> {
  const [servers, hosts] = await Promise.all([
    cached("threatfox-c2", TTL_MS, loadC2),
    cached("urlhaus-hosts", TTL_MS, loadPayloadHosts),
  ]);

  // One entry per address. ThreatFox lists an indicator per port, and a host
  // with twenty open ports is one machine, not twenty.
  const byIp = new Map<string, C2>();
  for (const server of servers) {
    if (!byIp.has(server.ip)) byIp.set(server.ip, server);
  }
  const unique = [...byIp.values()].slice(0, C2_LIMIT);

  const payloads = [...hosts.values()].filter((h) => h.status === "online");
  const placed = await locate([
    ...unique.map((s) => s.ip),
    ...payloads.slice(0, 200).map((h) => h.host),
  ]);

  const features: Feature[] = [];

  for (const server of unique) {
    const where = placed.get(server.ip);
    if (where === undefined) continue;

    features.push(
      point(where.lon, where.lat, {
        layer: "cyber_attacks",
        role: "c2",
        id: `c2-${server.ip}`,
        label: `${server.malware} C2 — ${where.city ?? where.country ?? server.ip}`,
        ip: server.ip,
        port: server.port,
        malware: server.malware,
        threatType: server.threatType,
        confidence: server.confidence,
        country: where.country,
        city: where.city,
        asn: where.asn,
        asName: where.asName,
        firstSeen: server.firstSeen,
        lastSeen: server.lastSeen,
        reporter: server.reporter,
        url: `https://threatfox.abuse.ch/browse.php?search=ioc%3A${encodeURIComponent(server.ip)}`,
        colour: FAMILY_COLOUR[server.malware] ?? "#e0173a",
      }),
    );

    /*
     * One link per server, to a payload host of the same family.
     *
     * Both ends are addresses abuse.ch is currently observing in the same
     * campaign, which is a real and published relationship. It is not an
     * observed attack — there is no keyless feed of those with both
     * endpoints, and drawing one would mean inventing the coordinates.
     */
    const family = server.malware.toLowerCase();
    const match = payloads.find(
      (h) => h.malware.toLowerCase() === family && placed.has(h.host),
    );
    if (match === undefined) continue;
    const to = placed.get(match.host);
    if (to === undefined) continue;

    features.push(
      line(
        [
          [where.lon, where.lat],
          [to.lon, to.lat],
        ],
        {
          layer: "cyber_attacks",
          role: "link",
          id: `link-${server.ip}-${match.host}`,
          label: `${server.malware}: C2 ${server.ip} to payload host ${match.host}`,
          malware: server.malware,
          colour: FAMILY_COLOUR[server.malware] ?? "#e0173a",
        },
      ),
    );
  }

  return {
    type: "FeatureCollection",
    features,
    meta: {
      source: "abuse.ch ThreatFox and URLhaus",
      c2Seen: byIp.size,
      note: "Command-and-control servers and payload hosts of the same family, both currently observed. Not observed attacks. Positions are IP geolocation, which is approximate.",
    },
  };
}
