import { z } from "zod";
import type { BreachRecord, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const hibpSource = requireSource("hibp");

const HIBP_BASE = "https://haveibeenpwned.com/api/v3";
const REQUEST_TIMEOUT_MS = 10_000;

const breachSchema = z.object({
  Name: z.string(),
  Title: z.string(),
  Domain: z.string().nullable().default(null),
  BreachDate: z.string().nullable().default(null),
  PwnCount: z.number().int().nonnegative(),
  DataClasses: z.array(z.string()).default([]),
  IsVerified: z.boolean().default(false),
});

const breachListSchema = z.array(breachSchema);

export type HibpBreach = z.infer<typeof breachSchema>;

export function normalizeHibp(
  breaches: readonly HibpBreach[],
): BreachRecord[] {
  return breaches.map((breach) => ({
    name: breach.Name,
    title: breach.Title,
    domain: breach.Domain,
    breachDate: breach.BreachDate,
    // Counted things are integers. The largest known breaches exceed a signed
    // 32-bit int, so this is a bigint (locked invariant 7).
    pwnCount: BigInt(breach.PwnCount),
    dataClasses: breach.DataClasses,
    verified: breach.IsVerified,
  }));
}

/**
 * Breach exposure for an account.
 *
 * Scope-gated: `executeScopedSource` enforces the case's scope and writes the
 * audit row before this function becomes reachable.
 */
export async function fetchHibp(subject: Subject): Promise<BreachRecord[]> {
  const key = process.env["HIBP_API_KEY"];
  if (key === undefined || key.trim().length === 0) {
    // Unreachable via executeScopedSource, which checks hasKey first. Kept as
    // a guard so a future direct caller cannot make a keyless request.
    throw new Error("HIBP_API_KEY is not configured");
  }

  // The account is a path segment because that is HIBP's API shape. It is
  // encoded here, and the built URL is never logged — a subject term must not
  // end up in a log line or an error string.
  const url = `${HIBP_BASE}/breachedaccount/${encodeURIComponent(
    subject.value,
  )}?truncateResponse=false`;

  const response = await fetch(url, {
    headers: {
      "hibp-api-key": key.trim(),
      "user-agent": "Scout-OSINT/0.1 (+authorized-engagement-tooling)",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // HIBP uses 404 for "this account appears in no breaches" — a successful
  // negative answer, not a failure.
  if (response.status === 404) return [];

  if (!response.ok) {
    // Status only. The body can echo request detail back, and this string
    // lands in the audit log.
    throw new Error(`HIBP responded ${response.status}`);
  }

  return normalizeHibp(breachListSchema.parse(await response.json()));
}
