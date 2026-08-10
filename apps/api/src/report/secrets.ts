/**
 * Keeping credential material out of deliverables.
 *
 * Scout redacts credential material at the adapter unless an operator opts in
 * (`SCOUT_ALLOW_CREDENTIAL_MATERIAL`). When they do, the material lands in
 * `Finding.data` — which reports never render — but nothing stops an
 * investigator typing it into a finding title or a case note by hand, and
 * scope-based redaction cannot catch it because a password is not an
 * identifier.
 *
 * So before export, the credential values stored on this case are collected
 * and struck out of every free-text field. The opt-in governs what Scout
 * *collects*; this governs what reaches a client.
 */

/** JSON keys whose values are secret material, whatever the shape around them. */
const SECRET_KEYS = new Set([
  "password",
  "hashedpassword",
  "hashed_password",
  "passwordhash",
  "password_hash",
  "secret",
  "token",
  "apikey",
  "api_key",
]);

/**
 * Very short values are not credentials, and striking them would mangle
 * ordinary prose — a 3-character "password" would blank every occurrence of
 * those letters in the report.
 */
const MIN_SECRET_LENGTH = 4;

export const SECRET_MARKER = "[REDACTED: credential material]";

/** Walks a stored finding payload and collects every secret-looking value. */
export function collectSecretValues(payloads: readonly unknown[]): string[] {
  const found = new Set<string>();

  const walk = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (
        key !== undefined &&
        SECRET_KEYS.has(key.toLowerCase()) &&
        value.length >= MIN_SECRET_LENGTH
      ) {
        found.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        walk(childValue, childKey);
      }
    }
  };

  for (const payload of payloads) walk(payload);
  return [...found];
}

export interface SecretScrubResult {
  text: string;
  /** How many distinct secrets were struck. Values are never reported. */
  count: number;
}

/** Strikes every known credential value out of `text`. */
export function scrubSecrets(
  text: string,
  secrets: readonly string[],
): SecretScrubResult {
  let out = text;
  let count = 0;

  for (const secret of secrets) {
    if (!out.includes(secret)) continue;
    count += 1;
    out = out.split(secret).join(SECRET_MARKER);
  }

  return { text: out, count };
}
