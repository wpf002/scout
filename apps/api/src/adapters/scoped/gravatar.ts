import { createHash } from "node:crypto";
import { z } from "zod";
import type { Source, Subject, UsernameSighting } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const gravatarSource: Source = requireSource("gravatar");

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Gravatar, keyed by the hash of an address.
 *
 * One of the few things that answers a question about an email address without
 * a key or an account. A profile is opt-in and public by construction — the
 * holder published it — but it routinely carries a real name and links to
 * other accounts, which is exactly the kind of pivot an investigation wants.
 *
 * Scope-gated like everything else person-facing. The address is hashed before
 * it is sent, which is Gravatar's protocol rather than a privacy measure, and
 * worth not mistaking for one: an MD5 of an email address is trivially
 * reversible for any address someone already suspects.
 */
const profileSchema = z.object({
  entry: z
    .array(
      z.object({
        displayName: z.string().optional(),
        preferredUsername: z.string().optional(),
        aboutMe: z.string().optional(),
        profileUrl: z.string().optional(),
        accounts: z
          .array(
            z.object({
              domain: z.string().optional(),
              url: z.string().optional(),
              username: z.string().optional(),
              shortname: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

export type GravatarProfile = z.infer<typeof profileSchema>;

export function normalizeGravatar(
  payload: GravatarProfile,
  email: string,
): UsernameSighting[] {
  const entry = payload.entry[0];
  if (entry === undefined) return [];

  const sightings: UsernameSighting[] = [];
  const handle = entry.preferredUsername ?? entry.displayName ?? email;

  if (entry.profileUrl !== undefined) {
    sightings.push({
      kind: "username-sighting",
      username: handle,
      site: "Gravatar",
      category: entry.displayName ?? null,
      url: entry.profileUrl,
    });
  }

  // The linked accounts are the point. A Gravatar profile is often the single
  // place someone has voluntarily tied their address to their other handles.
  for (const account of entry.accounts) {
    const url = account.url;
    if (url === undefined) continue;
    sightings.push({
      kind: "username-sighting",
      username: account.username ?? account.shortname ?? handle,
      site: account.domain ?? account.shortname ?? "linked account",
      category: "Linked from Gravatar",
      url,
    });
  }

  return sightings;
}

export async function fetchGravatar(
  subject: Subject,
): Promise<UsernameSighting[]> {
  const email = subject.value.trim().toLowerCase();
  const hash = createHash("md5").update(email).digest("hex");

  const response = await fetch(`https://gravatar.com/${hash}.json`, {
    headers: {
      accept: "application/json",
      "user-agent": "Scout-OSINT/0.1 (+authorized-engagement-tooling)",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // 404 is "no profile for this address", which is the common and correct
  // answer rather than a failure.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Gravatar responded ${response.status}`);
  }

  return normalizeGravatar(profileSchema.parse(await response.json()), email);
}
