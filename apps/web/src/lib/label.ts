/**
 * Turning identifiers into labels a person should read.
 *
 * The dropdowns took their options straight from the values behind them, so the
 * interface offered "domain", "ip", "hash" — machine keys, presented as though
 * they were prose. This is the one place that decides how such a key is written
 * out, so a kind added later reads the same everywhere it appears.
 */

/**
 * Words that are not capitalised, they are spelled.
 *
 * "Ip Address" is worse than leaving it lowercase, because it looks like
 * someone tried. Keyed lowercase; the value is the exact rendering.
 */
const SPELLED: Record<string, string> = {
  api: "API",
  asn: "ASN",
  btc: "BTC",
  cctv: "CCTV",
  cidr: "CIDR",
  cve: "CVE",
  dns: "DNS",
  eth: "ETH",
  gnss: "GNSS",
  gps: "GPS",
  http: "HTTP",
  https: "HTTPS",
  id: "ID",
  imo: "IMO",
  ip: "IP",
  ipv4: "IPv4",
  ipv6: "IPv6",
  mmsi: "MMSI",
  osint: "OSINT",
  ssl: "SSL",
  tls: "TLS",
  url: "URL",
  uuid: "UUID",
};

/**
 * Words that stay lowercase inside a title, never at the start of one.
 */
const MINOR = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of",
  "on", "or", "per", "the", "to", "via", "vs",
]);

/**
 * A key or a sentence, as a title.
 *
 * Splits on the separators an identifier actually uses — spaces, underscores,
 * hyphens — and keeps hyphens, because "Sub-Domain" is a hyphenated word and
 * "sub_domain" is a key. A word already carrying capitals of its own is left
 * exactly as it is: "iPhone", "eBay" and "McDonald" are all correct already, and
 * every rule that would "fix" them makes them wrong.
 */
export function titleCase(input: string): string {
  const words = input.trim().split(/([\s_]+|-)/);
  let index = 0;

  return words
    .map((word) => {
      if (/^([\s_]+|-)$/.test(word)) return word === "-" ? "-" : " ";

      const position = index;
      index += 1;
      const lower = word.toLowerCase();

      if (SPELLED[lower] !== undefined) return SPELLED[lower];

      // Already mixed-case: the author meant it. Only an all-lowercase or
      // all-uppercase word is safe to re-case.
      if (word !== lower && word !== word.toUpperCase()) return word;

      if (position > 0 && MINOR.has(lower)) return lower;

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

/**
 * Collector ids, written out.
 *
 * These are hyphenated identifiers, so title-casing them word by word gives
 * "Adsb-Live" and "Sec-Edgar". The set is small and known, so it is spelled
 * rather than derived; anything unrecognised falls back to titleCase.
 */
const SOURCE_LABEL: Record<string, string> = {
  "adsb-live": "ADS-B Live",
  "ais-live": "AIS Live",
  "first-party-telemetry": "First-Party Telemetry",
  "open-web": "Open Web",
  "sec-edgar": "SEC EDGAR",
  "sentinel-2": "Sentinel-2",
};

export function sourceLabel(id: string): string {
  return SOURCE_LABEL[id] ?? titleCase(id);
}
