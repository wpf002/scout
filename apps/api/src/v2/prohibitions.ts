import type { FastifyRequest } from "fastify";
import { prisma, recordAuditEvent } from "@scout/db";
import { assertMaxAutonomousTier, refuseForcedResolution, ProhibitionError } from "@scout/scope";

import { operatorOf } from "../auth.js";

/**
 * The five hard prohibitions, as the API meets them.
 *
 * Two are settled before the process serves a request: a collapsed review
 * band (forced resolution) and an autonomous tier above "prepare" are
 * refused at startup, and the refusal is written to the audit log before
 * the process exits. The other three are refused by guards inside routes
 * (biometrics, and the structural absence of any access or interception
 * route); every ProhibitionError that reaches the error handler is written
 * to the audit log with the route, the actor and the case it was about, so
 * an attempt is on the record whether or not it got anywhere.
 */

const KINDS = ["PERSON", "ORG", "VESSEL", "AIRCRAFT", "VEHICLE", "ACCOUNT", "LOCATION", "DEVICE", "INFRASTRUCTURE"] as const;

export interface StartupCheck {
  agentTier: "observe" | "prepare";
  thresholds: Record<string, { matchThresholdBp: number; reviewThresholdBp: number }>;
}

const readBp = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return Number(raw);
};

/**
 * Validates the environment the prohibitions depend on. Throws
 * ProhibitionError; the caller decides whether that ends the process (it
 * does, at startup) or the test.
 */
export function validateV2Startup(env: NodeJS.ProcessEnv = process.env): StartupCheck {
  const agentTier = assertMaxAutonomousTier(env["AGENT_MAX_AUTONOMOUS_TIER"]);
  const thresholds: StartupCheck["thresholds"] = {};
  const base = {
    matchThresholdBp: readBp(env, "RESOLUTION_MATCH_THRESHOLD", 9_500),
    reviewThresholdBp: readBp(env, "RESOLUTION_REVIEW_THRESHOLD", 7_000),
  };
  refuseForcedResolution(base);
  thresholds["*"] = base;
  // Per-kind overrides can collapse the band on their own; each is checked.
  for (const kind of KINDS) {
    const match = env[`RESOLUTION_MATCH_THRESHOLD_${kind}`];
    const review = env[`RESOLUTION_REVIEW_THRESHOLD_${kind}`];
    if ((match === undefined || match.trim() === "") && (review === undefined || review.trim() === "")) continue;
    const t = {
      matchThresholdBp: readBp(env, `RESOLUTION_MATCH_THRESHOLD_${kind}`, base.matchThresholdBp),
      reviewThresholdBp: readBp(env, `RESOLUTION_REVIEW_THRESHOLD_${kind}`, base.reviewThresholdBp),
    };
    try {
      refuseForcedResolution(t);
    } catch (caught) {
      if (caught instanceof ProhibitionError) throw new ProhibitionError(caught.prohibition, `${caught.message} (kind ${kind})`);
      throw caught;
    }
    thresholds[kind] = t;
  }
  return { agentTier, thresholds };
}

/** Records a startup refusal, best effort: a database that is down must not hide the reason the process stopped. */
export async function auditStartupRefusal(error: ProhibitionError): Promise<void> {
  try {
    await recordAuditEvent({ action: "v2.startup.refused", actor: "system", detail: { prohibition: error.prohibition, message: error.message } });
  } catch {
    // Logged by the caller; the refusal stands either way.
  }
}

/** The case a request was about, if it said. */
function caseIdOf(request: FastifyRequest): string | null {
  const body = request.body as { caseId?: unknown } | null | undefined;
  const query = request.query as { caseId?: unknown } | null | undefined;
  const params = request.params as { id?: unknown } | null | undefined;
  const candidate = body?.caseId ?? query?.caseId ?? (request.url.startsWith("/cases/") ? params?.id : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Every prohibition refusal the API answers is an audit event: who tried,
 * which route, which guard, and the case if one was named. The case id is
 * kept only if it exists, since the event table's foreign key must hold.
 */
export async function auditProhibition(request: FastifyRequest, error: ProhibitionError): Promise<void> {
  const caseId = caseIdOf(request);
  const known = caseId === null ? null : await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } }).catch(() => null);
  try {
    await recordAuditEvent({
      caseId: known?.id ?? undefined,
      action: "v2.prohibition.refused",
      actor: operatorOf(request),
      detail: { prohibition: error.prohibition, message: error.message, method: request.method, route: request.routeOptions?.url ?? request.url, caseId },
    });
  } catch {
    // The refusal is already the reply; a failed audit write is logged by the handler.
  }
}
