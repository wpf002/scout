import type { ScopeContext } from "./context.js";

/**
 * The five things Scout is built to be unable to do.
 *
 * Each has a named guard below. A subsystem calls the guard at the point where
 * the prohibited act would otherwise happen; the guard throws, the caller
 * records the refusal, and nothing else runs. These are not configuration.
 * There is no flag that turns one off, and adding one would be the change that
 * turns Scout from a product into evidence.
 *
 * docs/LEGAL_POSTURE.md carries the statutory basis in a form a customer's
 * counsel can read. The strings here are the short form.
 */

export const PROHIBITIONS = [
  {
    id: "UNAUTHORIZED_ACCESS",
    statute: "Computer Fraud and Abuse Act, 18 U.S.C. § 1030",
    plain:
      "Scout never reaches into a device, account, network or system it is not enrolled and authorized for. No credential stuffing, no exploitation, no session hijacking, no cameras or microphones that are not consented.",
  },
  {
    id: "INTERCEPTION",
    statute: "Wiretap Act and ECPA, 18 U.S.C. §§ 2511 and 2701",
    plain:
      "Scout never captures communications in transit and never reads messages it is not a party to or explicitly authorized to receive.",
  },
  {
    id: "OPEN_WORLD_BIOMETRICS",
    statute:
      "Illinois BIPA (740 ILCS 14), Texas CUBI (Bus. & Com. Code § 503.001), GDPR Article 9",
    plain:
      "Face and voice matching runs only against an enrolled gallery with a recorded lawful basis per identity. There is no search of the open internet for a face, and no scraped images become templates.",
  },
  {
    id: "AUTONOMOUS_CONSEQUENTIAL_ACTION",
    statute: "Scout policy. See docs/LEGAL_POSTURE.md.",
    plain:
      "The agent observes and proposes. Anything with an external effect waits for a recorded human approval, tied to one proposal, that expires.",
  },
  {
    id: "FORCED_RESOLUTION",
    statute: "Scout policy. See docs/ENTITY_RESOLUTION.md.",
    plain:
      "Resolution can answer UNRESOLVED or INDETERMINATE. It never merges two entities to avoid an empty answer, and the review band between the thresholds cannot be collapsed.",
  },
] as const;

export type ProhibitionId = (typeof PROHIBITIONS)[number]["id"];

/** Thrown by every guard. Carries a 403 and the prohibition it enforced. */
export class ProhibitionError extends Error {
  readonly statusCode = 403;
  readonly prohibition: ProhibitionId;

  constructor(prohibition: ProhibitionId, message: string) {
    super(message);
    this.name = "ProhibitionError";
    this.prohibition = prohibition;
  }
}

// ── 1. Unauthorized access ────────────────────────────────────────────────

export interface AccessTarget {
  kind: "device" | "account" | "network" | "endpoint" | "camera" | "microphone";
  /** Enrolled through the first-party ingest path, by its owner. */
  enrolled: boolean;
  /** The consent or ownership record that enrolled it. */
  consentRef: string | null;
}

/** Refuses any target that was not enrolled by its owner with a consent record. */
export function refuseUnauthorizedAccess(target: AccessTarget): void {
  if (!target.enrolled || target.consentRef === null || target.consentRef === "") {
    throw new ProhibitionError(
      "UNAUTHORIZED_ACCESS",
      `Refused: this ${target.kind} is not enrolled with a consent record. Scout does not access what it is not authorized for.`,
    );
  }
}

// ── 2. Interception ───────────────────────────────────────────────────────

export interface InterceptionRequest {
  kind: "packet-capture" | "telecom-intercept" | "message-read";
  /** Scout, or the authorizing party, is a party to the communication. */
  scoutIsParty: boolean;
  /** An explicit authorization to receive these messages, if any. */
  explicitAuthorizationRef: string | null;
}

/**
 * Packet capture and telecom interception are refused unconditionally. Reading
 * a message is permitted only when Scout is a party to it or is explicitly
 * authorized to receive it.
 */
export function refuseInterception(request: InterceptionRequest): void {
  if (request.kind !== "message-read") {
    throw new ProhibitionError(
      "INTERCEPTION",
      `Refused: ${request.kind} is interception of communications in transit. Scout does not do this under any authorization.`,
    );
  }
  const authorized =
    request.scoutIsParty ||
    (request.explicitAuthorizationRef !== null &&
      request.explicitAuthorizationRef !== "");
  if (!authorized) {
    throw new ProhibitionError(
      "INTERCEPTION",
      "Refused: Scout is not a party to this communication and has no explicit authorization to receive it.",
    );
  }
}

// ── 3. Open-world biometrics ──────────────────────────────────────────────

export interface BiometricRequest {
  /** The named gallery to compare against. Never optional. */
  galleryId: string | null;
  /** The gallery's recorded lawful basis document. */
  galleryLawfulBasisRef: string | null;
  context: ScopeContext;
}

/**
 * A comparison needs all three: a named gallery, a lawful basis on record for
 * it, and a scope that permits BIOMETRIC_COMPARE. Missing any one is a refusal.
 */
export function refuseOpenWorldBiometric(request: BiometricRequest): void {
  if (request.galleryId === null || request.galleryId === "") {
    throw new ProhibitionError(
      "OPEN_WORLD_BIOMETRICS",
      "Refused: a biometric comparison must name an enrolled gallery. Scout has no open-world face or voice search.",
    );
  }
  if (
    request.galleryLawfulBasisRef === null ||
    request.galleryLawfulBasisRef === ""
  ) {
    throw new ProhibitionError(
      "OPEN_WORLD_BIOMETRICS",
      `Refused: gallery ${request.galleryId} has no recorded lawful basis.`,
    );
  }
  if (!request.context.permitsAction("BIOMETRIC_COMPARE")) {
    throw new ProhibitionError(
      "OPEN_WORLD_BIOMETRICS",
      `Refused: authorization ${request.context.reference} does not permit BIOMETRIC_COMPARE.`,
    );
  }
}

export interface EnrollmentSource {
  /** Where the media came from. Scraped public images are refused. */
  origin: "consented-upload" | "court-ordered" | "employment-record" | "public-scrape" | "open-web";
  lawfulBasisDocumentRef: string | null;
}

/** Refuses building a template from anything scraped, or without a document. */
export function refuseBiometricIndexing(source: EnrollmentSource): void {
  if (source.origin === "public-scrape" || source.origin === "open-web") {
    throw new ProhibitionError(
      "OPEN_WORLD_BIOMETRICS",
      `Refused: enrollment from ${source.origin} media. Scout does not build biometric indexes from scraped or open-web images.`,
    );
  }
  if (
    source.lawfulBasisDocumentRef === null ||
    source.lawfulBasisDocumentRef === ""
  ) {
    throw new ProhibitionError(
      "OPEN_WORLD_BIOMETRICS",
      "Refused: an enrollment needs a lawful basis document reference.",
    );
  }
}

// ── 4. Autonomous consequential action ────────────────────────────────────

export const ACTION_TIERS = ["observe", "prepare", "consequential"] as const;
export type ActionTier = (typeof ACTION_TIERS)[number];

export interface Approval {
  proposalId: string;
  approvedBy: string;
  approvedAt: Date;
  expiresAt: Date;
  /** Set when the approval is consumed. An approval is used once. */
  usedAt: Date | null;
}

export interface ProposedAction {
  proposalId: string;
  tier: ActionTier;
  approval: Approval | null;
}

/**
 * Observe and prepare run on their own. Consequential needs an approval that
 * names this proposal, has not expired, and has not been used before.
 */
export function refuseAutonomousConsequential(
  action: ProposedAction,
  now: Date = new Date(),
): void {
  if (action.tier !== "consequential") return;

  const a = action.approval;
  if (a === null) {
    throw new ProhibitionError(
      "AUTONOMOUS_CONSEQUENTIAL_ACTION",
      `Refused: proposal ${action.proposalId} is consequential and has no recorded human approval.`,
    );
  }
  if (a.proposalId !== action.proposalId) {
    throw new ProhibitionError(
      "AUTONOMOUS_CONSEQUENTIAL_ACTION",
      `Refused: the approval is for proposal ${a.proposalId}, not ${action.proposalId}. Approvals are not transferable.`,
    );
  }
  if (a.usedAt !== null) {
    throw new ProhibitionError(
      "AUTONOMOUS_CONSEQUENTIAL_ACTION",
      `Refused: the approval for ${action.proposalId} was already used at ${a.usedAt.toISOString()}. Approvals are single-use.`,
    );
  }
  if (now >= a.expiresAt) {
    throw new ProhibitionError(
      "AUTONOMOUS_CONSEQUENTIAL_ACTION",
      `Refused: the approval for ${action.proposalId} expired at ${a.expiresAt.toISOString()}.`,
    );
  }
}

/**
 * Validates AGENT_MAX_AUTONOMOUS_TIER at startup. "consequential" is not a
 * permitted value, so a process configured that way does not boot.
 */
export function assertMaxAutonomousTier(value: string | undefined): "observe" | "prepare" {
  const tier = value === undefined || value === "" ? "observe" : value;
  if (tier === "observe" || tier === "prepare") return tier;
  throw new ProhibitionError(
    "AUTONOMOUS_CONSEQUENTIAL_ACTION",
    `Refused to start: AGENT_MAX_AUTONOMOUS_TIER=${value} is not permitted. Allowed: observe, prepare.`,
  );
}

// ── 5. Forced resolution ──────────────────────────────────────────────────

export interface ResolutionThresholds {
  /** Basis points, 0–10000. At or above this: automatic MATCH. */
  matchThresholdBp: number;
  /** Basis points, 0–10000. Below this: automatic NON_MATCH. */
  reviewThresholdBp: number;
}

/**
 * The review band is the space between the two thresholds. Setting them equal,
 * or crossed, removes the human from the loop for borderline pairs. Refused.
 */
export function refuseForcedResolution(t: ResolutionThresholds): void {
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= 10_000;
  if (!inRange(t.matchThresholdBp) || !inRange(t.reviewThresholdBp)) {
    throw new ProhibitionError(
      "FORCED_RESOLUTION",
      "Refused: thresholds are integer basis points between 0 and 10000.",
    );
  }
  if (t.matchThresholdBp <= t.reviewThresholdBp) {
    throw new ProhibitionError(
      "FORCED_RESOLUTION",
      `Refused: match threshold (${t.matchThresholdBp}) must exceed review threshold (${t.reviewThresholdBp}). A collapsed review band forces a decision on every borderline pair.`,
    );
  }
}

export const MATCH_OUTCOMES = ["MATCH", "NON_MATCH", "REVIEW", "INDETERMINATE"] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

/**
 * Turns a score into an outcome. The band in the middle is REVIEW, and a
 * score with no basis (null) is INDETERMINATE. Neither is ever promoted here.
 */
export function classifyScore(
  scoreBp: number | null,
  t: ResolutionThresholds,
): MatchOutcome {
  refuseForcedResolution(t);
  if (scoreBp === null || !Number.isFinite(scoreBp)) return "INDETERMINATE";
  if (scoreBp >= t.matchThresholdBp) return "MATCH";
  if (scoreBp < t.reviewThresholdBp) return "NON_MATCH";
  return "REVIEW";
}

export interface ClusterEdge {
  left: string;
  right: string;
  outcome: MatchOutcome;
}

/**
 * The transitivity guard. If A–B and B–C matched but A–C is a non-match, the
 * three are not one entity. The cluster is DISPUTED and goes to review rather
 * than being merged.
 */
export function assertClusterConsistent(
  members: readonly string[],
  edges: readonly ClusterEdge[],
): "RESOLVED" | "DISPUTED" {
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const byPair = new Map(edges.map((e) => [key(e.left, e.right), e.outcome]));
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i] as string;
      const b = members[j] as string;
      if (byPair.get(key(a, b)) === "NON_MATCH") return "DISPUTED";
    }
  }
  return "RESOLVED";
}
