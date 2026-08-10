import type {
  SerializableSource,
  Source,
  SubjectKind,
  Tier,
} from "./types.js";
import { TIERS } from "./types.js";

const q = encodeURIComponent;

/**
 * The tiered source registry: 19 sources across 6 tiers.
 *
 * Two fields carry the platform's safety posture:
 *   - `mode`          — deeplink sources never route subject data through Scout.
 *   - `requiresScope` — person-facing sources that the scope gate must clear.
 *
 * Exactly the four `requiresScope` sources below are person-facing. Adding a
 * fifth is a deliberate act that must come with an adapter-level
 * `enforceScope()` call; `registry.test.ts` pins the current set so the
 * addition cannot happen silently.
 */
export const SOURCES: readonly Source[] = Object.freeze([
  // ── datasets ────────────────────────────────────────────────────────────
  {
    id: "icij-offshore-leaks",
    name: "ICIJ Offshore Leaks",
    tier: "datasets",
    mode: "deeplink",
    requiresScope: false,
    accepts: ["person", "company", "keyword"],
    description:
      "Panama/Paradise/Pandora Papers entity and officer records.",
    homepage: "https://offshoreleaks.icij.org",
    keyEnv: null,
    deeplink: (term) => `https://offshoreleaks.icij.org/search?q=${q(term)}`,
  },
  {
    id: "opencorporates",
    name: "OpenCorporates",
    tier: "datasets",
    mode: "deeplink",
    requiresScope: false,
    accepts: ["company", "person", "keyword"],
    description: "Corporate registry data — companies, officers, filings.",
    homepage: "https://opencorporates.com",
    keyEnv: null,
    deeplink: (term) => `https://opencorporates.com/companies?q=${q(term)}`,
  },
  {
    id: "wikidata",
    name: "Wikidata",
    tier: "datasets",
    mode: "deeplink",
    requiresScope: false,
    accepts: ["person", "company", "keyword"],
    description: "Structured knowledge base — entity identifiers and cross-references.",
    homepage: "https://www.wikidata.org",
    keyEnv: null,
    deeplink: (term) =>
      `https://www.wikidata.org/w/index.php?search=${q(term)}`,
  },
  {
    id: "intelligence-x",
    name: "Intelligence X",
    tier: "datasets",
    mode: "api",
    // Not person-facing wholesale — searching a domain or a CIDR here is
    // ordinary dataset research.
    requiresScope: false,
    // But an email selector is a lookup about a person, and it goes through
    // the same gate as the exposure tier.
    scopedKinds: ["email"],
    accepts: ["domain", "email", "keyword", "ip", "hash"],
    description:
      "Archive of leaks, pastes, darknet and historical web data. Selector-based search.",
    homepage: "https://intelx.io",
    keyEnv: "INTELX_API_KEY",
  },
  {
    id: "opensanctions",
    name: "OpenSanctions",
    tier: "datasets",
    mode: "api",
    requiresScope: false,
    accepts: ["person", "company", "keyword"],
    description:
      "Sanctions, PEP and watchlist matching with per-dataset provenance.",
    homepage: "https://www.opensanctions.org",
    keyEnv: "OPENSANCTIONS_API_KEY",
  },

  // ── infra ───────────────────────────────────────────────────────────────
  {
    id: "shodan",
    name: "Shodan",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain", "ip"],
    description: "Internet-wide host, port and banner index.",
    homepage: "https://www.shodan.io",
    keyEnv: "SHODAN_API_KEY",
  },
  {
    id: "censys",
    name: "Censys",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain", "ip"],
    description: "Host and certificate scanning data with structured services.",
    homepage: "https://search.censys.io",
    keyEnv: "CENSYS_API_KEY",
  },
  {
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
  },
  {
    id: "greynoise",
    name: "GreyNoise",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain", "ip"],
    description:
      "Whether an address is aimed at you or spraying the whole internet.",
    homepage: "https://www.greynoise.io",
    // The Community endpoint answers unauthenticated, verified against the
    // live API. A key raises the rate limit; it is not needed to get answers.
    keyEnv: null,
  },
  {
    id: "feodo",
    name: "Feodo Tracker",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain", "ip"],
    description: "abuse.ch botnet command-and-control blocklist.",
    homepage: "https://feodotracker.abuse.ch",
    keyEnv: null,
  },
  {
    id: "rdap",
    name: "RDAP + DNS",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain"],
    description:
      "Registrar, registration dates, nameservers and live A/MX/TXT/NS records.",
    homepage: "https://rdap.org",
    // No account exists to hold a key. Registration data and DNS are public
    // infrastructure, which is why this is the one source that can never be
    // inert.
    keyEnv: null,
  },
  {
    id: "certspotter",
    name: "CertSpotter",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain"],
    description:
      "Certificate Transparency issuances — subdomains and certificate history.",
    homepage: "https://sslmate.com/certspotter",
    // Anonymous access is rate limited per address rather than keyed.
    keyEnv: null,
  },
  {
    id: "hackertarget",
    name: "HackerTarget",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain"],
    description: "Host search — subdomains paired with their addresses.",
    homepage: "https://hackertarget.com",
    keyEnv: null,
  },
  {
    id: "rapiddns",
    name: "RapidDNS",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain"],
    description: "Passive DNS subdomain index.",
    homepage: "https://rapiddns.io",
    keyEnv: null,
  },
  {
    id: "otx",
    name: "AlienVault OTX",
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain"],
    description: "Open Threat Exchange passive DNS.",
    homepage: "https://otx.alienvault.com",
    // Anonymous requests are throttled to the point of uselessness (429 on the
    // first call), so this is treated as keyed. The key itself is free.
    keyEnv: "OTX_API_KEY",
  },
  {
    id: "crtsh",
    name: "crt.sh",
    tier: "infra",
    // `api` because Scout can fetch and normalize its JSON output. It keeps a
    // deeplink as a convenience, but the mode is what tells the truth about
    // where the request originates. Subject kind is restricted to `domain`,
    // so no personal identifier is ever sent.
    mode: "api",
    requiresScope: false,
    accepts: ["domain"],
    description:
      "Certificate Transparency log search — a free, keyless subdomain oracle.",
    homepage: "https://crt.sh",
    keyEnv: null,
    deeplink: (term) => `https://crt.sh/?q=${q(term)}`,
  },
  {
    id: "viewdns",
    name: "ViewDNS",
    tier: "infra",
    mode: "deeplink",
    requiresScope: false,
    accepts: ["domain", "ip"],
    description: "Reverse WHOIS, reverse IP and DNS tooling.",
    homepage: "https://viewdns.info",
    keyEnv: null,
    deeplink: (term) => `https://viewdns.info/reversewhois/?q=${q(term)}`,
  },

  // ── exposure (scoped) ───────────────────────────────────────────────────
  {
    id: "hibp",
    name: "Have I Been Pwned",
    tier: "exposure",
    mode: "api",
    requiresScope: true,
    accepts: ["email", "domain"],
    description: "Breach exposure for an account. Scope-gated: person-facing.",
    homepage: "https://haveibeenpwned.com",
    keyEnv: "HIBP_API_KEY",
  },
  {
    id: "hunter-io",
    name: "Hunter.io",
    tier: "people",
    mode: "api",
    requiresScope: true,
    accepts: ["domain", "email"],
    description:
      "Email pattern discovery and verification. Scope-gated to authorized domains.",
    homepage: "https://hunter.io",
    keyEnv: "HUNTER_API_KEY",
  },
  {
    id: "whatsmyname",
    name: "WhatsMyName",
    tier: "people",
    mode: "api",
    requiresScope: true,
    accepts: ["username"],
    description:
      "Username enumeration across sites. Scope-gated to authorized identifiers.",
    homepage: "https://whatsmyname.app",
    // Not an API key — WhatsMyName has no hosted API, and Scout does the
    // enumeration itself from the project's public site list. That makes this
    // the most outbound-heavy thing Scout does, so it stays inert until an
    // operator turns it on deliberately. There is no key to act as an
    // accidental off switch, so the switch is explicit.
    keyEnv: "WHATSMYNAME_ENABLED",
  },
  {
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
  },
  {
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
  },

  // ── onion ───────────────────────────────────────────────────────────────
  {
    id: "ahmia",
    name: "Ahmia",
    tier: "onion",
    mode: "deeplink",
    requiresScope: false,
    accepts: ["keyword", "domain", "email"],
    description: "Clearnet-indexed search over Tor hidden services.",
    homepage: "https://ahmia.fi",
    keyEnv: null,
    deeplink: (term) => `https://ahmia.fi/search/?q=${q(term)}`,
  },
  {
    id: "torch",
    name: "Torch",
    tier: "onion",
    mode: "deeplink",
    requiresScope: false,
    accepts: ["keyword", "domain"],
    description:
      "Long-running onion search engine. Requires Tor Browser to open.",
    homepage:
      "http://torchdeedp3i2jigzjdmfpn5ttjhthh5wbmda2rr3jvqjg5p77c54dqd.onion",
    keyEnv: null,
    deeplink: (term) =>
      `http://torchdeedp3i2jigzjdmfpn5ttjhthh5wbmda2rr3jvqjg5p77c54dqd.onion/search?query=${q(term)}`,
  },

  // ── utils ───────────────────────────────────────────────────────────────
  {
    id: "wayback-machine",
    name: "Wayback Machine",
    tier: "utils",
    // Promoted from deeplink: archive.org refuses to be iframed, and its CDX
    // index answers the actual question (what was archived, and when) as data.
    mode: "api",
    requiresScope: false,
    accepts: ["domain", "keyword"],
    description: "Historical snapshots of a host or URL.",
    homepage: "https://web.archive.org",
    keyEnv: null,
    deeplink: (term) => `https://web.archive.org/web/*/${q(term)}*`,
  },
  {
    id: "urlscan",
    name: "urlscan.io",
    // Infra, not utils. It returns hosts, addresses and ASNs — the same shape
    // Shodan and Censys return — and the batch sweep is restricted to the
    // infra tier, so classifying it anywhere else would keep it out of the
    // consolidated run for no reason other than where it sits in a list.
    tier: "infra",
    mode: "api",
    requiresScope: false,
    accepts: ["domain", "ip", "keyword"],
    description: "Page-load forensics — requests, redirects, embedded assets.",
    homepage: "https://urlscan.io",
    keyEnv: "URLSCAN_API_KEY",
  },
]);

const BY_ID = new Map<string, Source>(SOURCES.map((s) => [s.id, s]));

export function getSource(id: string): Source | undefined {
  return BY_ID.get(id);
}

/**
 * Looks up a source that the caller knows must exist — an adapter naming the
 * source it implements. Throws at import time rather than degrading to
 * `undefined` somewhere deep in a request.
 */
export function requireSource(id: string): Source {
  const source = BY_ID.get(id);
  if (source === undefined) {
    throw new Error(`No source registered with id "${id}".`);
  }
  return source;
}

export function listSources(): readonly Source[] {
  return SOURCES;
}

export function sourcesByTier(tier: Tier): readonly Source[] {
  return SOURCES.filter((s) => s.tier === tier);
}

/** Sources grouped into reach-for order, for the dashboard. */
export function groupedByTier(): { tier: Tier; sources: readonly Source[] }[] {
  return TIERS.map((tier) => ({ tier, sources: sourcesByTier(tier) }));
}

/** The person-facing sources. Every one of these must call `enforceScope()`. */
export function scopedSources(): readonly Source[] {
  return SOURCES.filter((s) => s.requiresScope);
}

/**
 * Whether asking `source` about a `kind` subject needs the scope gate.
 *
 * This — not `source.requiresScope` — is the question every caller actually
 * has. A source can be person-facing wholesale (`requiresScope`) or only for
 * certain inputs (`scopedKinds`), and the planner, the adapters and the audit
 * log must all agree on which applies to the query in hand.
 */
export function requiresScopeFor(
  source: Source,
  kind: SubjectKind,
): boolean {
  if (source.requiresScope) return true;
  return source.scopedKinds?.includes(kind) ?? false;
}

/** Sources gated for at least one subject kind, wholesale or per-kind. */
export function gatedSources(): readonly Source[] {
  return SOURCES.filter(
    (s) => s.requiresScope || (s.scopedKinds?.length ?? 0) > 0,
  );
}

/**
 * A source is `inert` when it needs a key and the key is absent. Inert is a
 * reported state, never an error and never a guess (locked invariant 6).
 */
export function hasKey(
  source: Source,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (source.keyEnv === null) return true;
  const value = env[source.keyEnv];
  return typeof value === "string" && value.trim().length > 0;
}

/** Strips the function-valued `deeplink` so a source can be sent as JSON. */
export function serializeSource(source: Source): SerializableSource {
  const { deeplink, ...rest } = source;
  return { ...rest, hasDeeplink: typeof deeplink === "function" };
}
