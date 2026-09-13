import { assertMaxAutonomousTier, type ActionTier } from "@scout/scope";

/**
 * What the agent can do, and the tier each act belongs to. The list is
 * closed: an act not named here cannot be proposed, so nothing reaches the
 * consequential tier by being called something else.
 */
export const ACTION_KINDS = {
  "draft-report": { tier: "prepare", title: "Draft the case report", effect: "Produces a report file for review. Nothing leaves." },
  "stage-collection": { tier: "prepare", title: "Stage a collection request", effect: "Records a request an operator can dispatch. No upstream is called." },
  "assemble-package": { tier: "prepare", title: "Assemble an evidence package", effect: "Gathers what the case holds into one manifest. Nothing leaves." },
  "dispatch-collection": { tier: "consequential", title: "Dispatch collection", effect: "Calls an upstream about a subject and writes observations." },
  "send-report": { tier: "consequential", title: "Send the report to a third party", effect: "Delivers the report outside Scout." },
  "write-external": { tier: "consequential", title: "Write to an external system", effect: "Changes a system outside Scout. No writer is registered." },
  "request-scope-expansion": { tier: "consequential", title: "Request wider authorization", effect: "Records a request to the issuer. The authorization itself does not change." },
} as const satisfies Record<string, { tier: ActionTier; title: string; effect: string }>;

export type ActionKind = keyof typeof ACTION_KINDS;
export const ACTION_KIND_NAMES = Object.keys(ACTION_KINDS) as ActionKind[];

const RANK: Record<ActionTier, number> = { observe: 0, prepare: 1, consequential: 2 };

export function tierOf(kind: ActionKind): ActionTier {
  return ACTION_KINDS[kind].tier;
}

/** The highest tier that runs without a human, from the environment, validated the same way startup validates it. */
export function maxAutonomousTier(): "observe" | "prepare" {
  return assertMaxAutonomousTier(process.env["AGENT_MAX_AUTONOMOUS_TIER"]);
}

/** Consequential never runs on its own. Prepare runs on its own only when the environment says so. */
export function needsApproval(tier: ActionTier): boolean {
  if (tier === "consequential") return true;
  return RANK[tier] > RANK[maxAutonomousTier()];
}

export const toDbTier = (tier: ActionTier): "OBSERVE" | "PREPARE" | "CONSEQUENTIAL" => tier.toUpperCase() as "OBSERVE" | "PREPARE" | "CONSEQUENTIAL";
export const fromDbTier = (tier: "OBSERVE" | "PREPARE" | "CONSEQUENTIAL"): ActionTier => tier.toLowerCase() as ActionTier;
