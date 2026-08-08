import { z } from "zod";
import type { CredentialRecord, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const dehashedSource = requireSource("dehashed");

const REQUEST_TIMEOUT_MS = 20_000;

const entrySchema = z.object({
  id: z.string().optional(),
  email: z.string().nullable().default(null),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
  hashed_password: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  ip_address: z.string().nullable().default(null),
  database_name: z.string().nullable().default(null),
});

const responseSchema = z.object({
  entries: z.array(entrySchema).nullable().default([]),
});

export type DehashedResponse = z.infer<typeof responseSchema>;

/**
 * Whether the operator has explicitly opted in to pulling secret material
 * into the case database.
 *
 * Off by default, deliberately. Knowing that a credential for this account
 * exists in a named breach is the finding; the password itself is rarely
 * needed and turns the case database into a credential store. The opt-in
 * exists because credential-stuffing validation is a real engagement task —
 * but it has to be a decision someone made, not a default they inherited.
 */
export function credentialMaterialAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env["SCOUT_ALLOW_CREDENTIAL_MATERIAL"]?.trim() === "true";
}

export function normalizeDehashed(
  payload: DehashedResponse,
  options: { includeMaterial: boolean },
): CredentialRecord[] {
  return (payload.entries ?? []).map((entry) => {
    const hasPassword =
      typeof entry.password === "string" && entry.password.length > 0;
    const hasHashedPassword =
      typeof entry.hashed_password === "string" &&
      entry.hashed_password.length > 0;

    return {
      kind: "credential-record" as const,
      databaseName: entry.database_name ?? "unknown",
      email: entry.email,
      username: entry.username,
      hasPassword,
      hasHashedPassword,
      // Redacted unless explicitly opted in. The booleans above still tell
      // the investigator what exists.
      password: options.includeMaterial && hasPassword ? entry.password : null,
      hashedPassword:
        options.includeMaterial && hasHashedPassword
          ? entry.hashed_password
          : null,
      name: entry.name,
      phone: entry.phone,
      ipAddress: entry.ip_address,
    };
  });
}

/** The DeHashed field to search, chosen from the subject kind. */
function queryFor(subject: Subject): string {
  const value = subject.value.trim();
  switch (subject.kind) {
    case "email":
      return `email:"${value}"`;
    case "username":
      return `username:"${value}"`;
    case "ip":
      return `ip_address:"${value}"`;
    case "domain":
      return `email:"@${value}"`;
    default:
      return `"${value}"`;
  }
}

export async function fetchDehashed(
  subject: Subject,
): Promise<CredentialRecord[]> {
  const key = process.env["DEHASHED_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("DEHASHED_API_KEY is not configured");
  }

  const response = await fetch("https://api.dehashed.com/v2/search", {
    method: "POST",
    headers: {
      // Key in a header, never the URL.
      "Dehashed-Api-Key": key,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ query: queryFor(subject), size: 100 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 404) return [];
  // Status only — a DeHashed error body can echo the query, and the query is
  // a person's identifier.
  if (!response.ok) throw new Error(`DeHashed responded ${response.status}`);

  return normalizeDehashed(responseSchema.parse(await response.json()), {
    includeMaterial: credentialMaterialAllowed(),
  });
}
