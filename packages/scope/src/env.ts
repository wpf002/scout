import type { ScopeEntry } from "./types.js";

function split(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Env-derived scope: the keyless local fallback.
 *
 * Used only when there is no case in play — planning previews and local
 * poking. It deliberately cannot authorize an *execution* of a scoped source:
 * that path requires a real case, because an execution has to land in the
 * audit log against an authorization reference, and env vars carry neither.
 *
 * SCOUT_SCOPE_DOMAINS=example.com,corp.example.net
 * SCOUT_SCOPE_IDENTIFIERS=alice@example.com,bob_handle
 */
export function envScope(env: NodeJS.ProcessEnv = process.env): ScopeEntry[] {
  return [
    ...split(env["SCOUT_SCOPE_DOMAINS"]).map(
      (value): ScopeEntry => ({ kind: "domain", value }),
    ),
    ...split(env["SCOUT_SCOPE_IDENTIFIERS"]).map(
      (value): ScopeEntry => ({ kind: "identifier", value }),
    ),
  ];
}
