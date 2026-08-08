import { z } from "zod";
import type { ExposureData, SourceResult, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";
import type { ScopedRunContext } from "./base.js";
import { executeScopedSource } from "./base.js";

const HIBP = requireSource("hibp");

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

async function fetchBreaches(subject: Subject): Promise<ExposureData> {
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
  if (response.status === 404) {
    return { subject: subject.value, breachCount: 0, breaches: [] };
  }

  if (!response.ok) {
    // Status only. The body can echo request detail back, and this string
    // lands in the audit log.
    throw new Error(`HIBP responded ${response.status}`);
  }

  const parsed = breachListSchema.parse(await response.json());

  return {
    subject: subject.value,
    breachCount: parsed.length,
    breaches: parsed.map((b) => ({
      name: b.Name,
      title: b.Title,
      domain: b.Domain,
      breachDate: b.BreachDate,
      // Counted things are integers. The largest known breaches exceed a
      // signed 32-bit int, so this is a bigint (locked invariant 7).
      pwnCount: BigInt(b.PwnCount),
      dataClasses: b.DataClasses,
      verified: b.IsVerified,
    })),
  };
}

/**
 * Breach exposure for an account.
 *
 * Scope-gated: `executeScopedSource` enforces the case's scope and writes the
 * audit row before `fetchBreaches` becomes reachable.
 */
export function queryHibp(
  ctx: ScopedRunContext,
): Promise<SourceResult<ExposureData>> {
  return executeScopedSource(HIBP, ctx, fetchBreaches);
}

export const hibpSource = HIBP;
