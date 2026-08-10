import { z } from "zod";
import type { EmailPatternResult, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const hunterSource = requireSource("hunter-io");

const REQUEST_TIMEOUT_MS = 15_000;

const domainSearchSchema = z.object({
  data: z.object({
    domain: z.string().default(""),
    pattern: z.string().nullable().default(null),
    organization: z.string().nullable().default(null),
    emails: z
      .array(
        z.object({
          value: z.string(),
          type: z.string().nullable().default(null),
          confidence: z.number().nullable().default(null),
          first_name: z.string().nullable().default(null),
          last_name: z.string().nullable().default(null),
          position: z.string().nullable().default(null),
        }),
      )
      .default([]),
  }),
});

const verifySchema = z.object({
  data: z.object({
    email: z.string(),
    status: z.string().default("unknown"),
    score: z.number().nullable().default(null),
  }),
});

export type HunterDomainSearch = z.infer<typeof domainSearchSchema>;
export type HunterVerify = z.infer<typeof verifySchema>;

export function normalizeHunterDomain(
  payload: HunterDomainSearch,
  fallbackDomain: string,
): EmailPatternResult[] {
  const data = payload.data;
  return [
    {
      kind: "email-pattern",
      domain: data.domain.length > 0 ? data.domain : fallbackDomain,
      pattern: data.pattern,
      organization: data.organization,
      emails: data.emails.map((email) => ({
        value: email.value.toLowerCase(),
        type: email.type,
        confidence: email.confidence,
        firstName: email.first_name,
        lastName: email.last_name,
        position: email.position,
      })),
    },
  ];
}

export function normalizeHunterVerify(
  payload: HunterVerify,
): EmailPatternResult[] {
  const data = payload.data;
  const at = data.email.lastIndexOf("@");
  return [
    {
      kind: "email-pattern",
      domain: at > 0 ? data.email.slice(at + 1).toLowerCase() : "",
      pattern: null,
      organization: null,
      emails: [
        {
          value: data.email.toLowerCase(),
          // Verification status carried in the `type` slot so one shape
          // serves both endpoints.
          type: data.status,
          confidence: data.score,
          firstName: null,
          lastName: null,
          position: null,
        },
      ],
    },
  ];
}

/**
 * Hunter caps results per plan, and asking for more than the plan allows is a
 * 400 for the whole request rather than a truncated answer — so a hardcoded
 * `limit=100` meant every lookup failed on a free plan while the same request
 * without it succeeded. Omitted by default so the plan's own maximum applies;
 * set HUNTER_RESULT_LIMIT to raise it on a plan that permits more.
 */
function resultLimit(): string {
  const raw = process.env["HUNTER_RESULT_LIMIT"]?.trim() ?? "";
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? `&limit=${parsed}` : "";
}

export async function fetchHunter(
  subject: Subject,
): Promise<EmailPatternResult[]> {
  const key = process.env["HUNTER_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("HUNTER_API_KEY is not configured");
  }

  const value = subject.value.trim().toLowerCase();

  // Hunter puts the key in the query string. The built URL is never logged
  // and never returned — it carries both the key and the subject term.
  const url =
    subject.kind === "email"
      ? `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(value)}&api_key=${encodeURIComponent(key)}`
      : `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(value)}${resultLimit()}&api_key=${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Hunter.io responded ${response.status}`);

  const body: unknown = await response.json();
  return subject.kind === "email"
    ? normalizeHunterVerify(verifySchema.parse(body))
    : normalizeHunterDomain(domainSearchSchema.parse(body), value);
}
