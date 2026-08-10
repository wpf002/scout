import { Resolver } from "node:dns/promises";

/**
 * Resolving a domain to addresses, for sources that only speak IP.
 *
 * Censys asset lookup and Shodan's InternetDB both answer about an address,
 * not a name. Rather than skipping those sources for a domain subject, the
 * domain is resolved first and each address looked up.
 *
 * Public resolvers, for the same reason as the RDAP adapter: on a corporate or
 * VPN network the host's own resolver returns split-horizon answers, and
 * recording internal addresses as public findings would be worse than
 * returning nothing.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];
const DNS_TIMEOUT_MS = 5_000;

/**
 * Addresses for a domain, capped.
 *
 * The cap matters because these feed metered endpoints — Censys bills per
 * lookup and a free plan has 100 credits a month, so a domain behind a large
 * CDN pool could spend the entire allowance in one search.
 */
export async function resolveAddresses(
  domain: string,
  limit = 3,
): Promise<string[]> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers(PUBLIC_RESOLVERS);

  try {
    const addresses = await resolver.resolve4(domain);
    return [...new Set(addresses)].slice(0, limit);
  } catch {
    return [];
  }
}
