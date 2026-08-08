/**
 * Normalization for scope matching.
 *
 * Every comparison in the gate runs on normalized values on BOTH sides. The
 * normalizer leans on WHATWG `URL` so that IDN homographs are punycoded and
 * IPv6 forms are canonicalized before anything is compared — a scope check
 * that compared raw user strings would be trivially bypassable with
 * `EXAMPLE.com`, `example.com.`, or a unicode lookalike.
 */

/**
 * Parses an arbitrary user-entered host-ish string into a canonical hostname.
 * Accepts bare hosts, URLs, and host:port. Returns `null` when the input
 * cannot be read as a hostname — the gate treats that as unparseable, i.e.
 * denied, never as a wildcard.
 */
export function normalizeHostname(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Reject whitespace inside — a hostname never contains any, and allowing it
  // invites parser-differential tricks.
  if (/\s/.test(trimmed)) return null;

  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;

  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    return null;
  }

  let host = hostname.toLowerCase();
  // `URL` returns IPv6 literals bracketed.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // Trailing dot is the DNS root; `a.com.` and `a.com` are the same name.
  while (host.endsWith(".")) host = host.slice(0, -1);

  return host.length > 0 ? host : null;
}

/**
 * Normalizes an email to `local@host`. The domain half goes through
 * `normalizeHostname`; the local half is lowercased. RFC 5321 makes local
 * parts case-sensitive, but no real provider does, and an investigator typing
 * `John.Doe@` should match scope written as `john.doe@`.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

  // Split on the LAST '@' — quoted local parts may legally contain one.
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;

  const local = trimmed.slice(0, at).toLowerCase();
  const host = normalizeHostname(trimmed.slice(at + 1));
  if (host === null) return null;

  return `${local}@${host}`;
}

/** Extracts the canonical domain half of an email. */
export function emailDomain(raw: string): string | null {
  const normalized = normalizeEmail(raw);
  if (normalized === null) return null;
  return normalized.slice(normalized.lastIndexOf("@") + 1);
}

/** Case-folded, whitespace-collapsed form for usernames, names, keywords. */
export function normalizeIdentifier(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ").toLowerCase();
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * True when `host` is the scope domain itself or a subdomain of it.
 *
 * Anchored on a label boundary: `notexample.com` does NOT fall under scope
 * `example.com`. This one line is the difference between a scope gate and a
 * substring check.
 */
export function isWithinDomain(host: string, scopeDomain: string): boolean {
  if (host === scopeDomain) return true;
  return host.endsWith(`.${scopeDomain}`);
}
