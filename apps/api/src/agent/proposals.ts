import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { prisma, recordAuditEvent } from "@scout/db";
import { ProhibitionError, refuseAutonomousConsequential, type ScopeContext } from "@scout/scope";

import { HttpError, notFound } from "../errors.js";
import { paramsSchemas, perform, precheck } from "./actions.js";
import { ACTION_KINDS, ACTION_KIND_NAMES, fromDbTier, needsApproval, tierOf, toDbTier, type ActionKind } from "./tiers.js";
import { notify } from "./webhook.js";

/**
 * Proposals and approvals.
 *
 * A proposal says what, why (citing observations under the same
 * authorization), what scope it needs and what it would affect. An approval
 * is one human, one proposal, one use, with an expiry; the guard in the
 * scope package is what checks it, and a consequential act with no valid
 * approval is a prohibition refusal, audited like every other. Nothing
 * here can widen an authorization: an approved act still passes every
 * scope gate on its way through.
 */

export const proposalSchema = z.object({
  caseId: z.string().min(1),
  kind: z.enum(ACTION_KIND_NAMES as [ActionKind, ...ActionKind[]]),
  title: z.string().trim().min(3).max(200),
  rationale: z.string().trim().min(8).max(4000),
  citations: z.array(z.string().min(1)).max(200).default([]),
  requiresScope: z.record(z.string(), z.unknown()).default({}),
  affects: z.record(z.string(), z.unknown()).default({}),
  params: z.record(z.string(), z.unknown()).default({}),
});

export async function propose(input: z.infer<typeof proposalSchema> & { ctx: ScopeContext; operator: string; proposedBy?: string }) {
  const { ctx, caseId, operator, kind } = input;
  const tier = tierOf(kind);
  const params = paramsSchemas[kind].parse(input.params);

  // Evidence: every citation is an observation under this authorization,
  // and anything above observe cites at least one.
  const citations = [...new Set(input.citations)];
  if (citations.length > 0) {
    const known = await prisma.observation.findMany({ where: { id: { in: citations }, authorizationId: ctx.authorizationId }, select: { id: true } });
    const missing = citations.filter((id) => !known.some((k) => k.id === id));
    if (missing.length > 0) throw new HttpError(400, "citation-unknown", `Citations must be observations under authorization ${ctx.reference}; unknown: ${missing.slice(0, 5).join(", ")}.`);
  }
  if (tier !== "observe" && citations.length === 0) {
    throw new HttpError(400, "citation-required", `A ${tier} proposal states its evidence: cite at least one observation.`);
  }

  const row = await prisma.agentProposal.create({
    data: {
      caseId, authorizationId: ctx.authorizationId, kind, tier: toDbTier(tier), title: input.title, rationale: input.rationale, citations,
      requiresScope: input.requiresScope as never, affects: { effect: ACTION_KINDS[kind].effect, ...input.affects } as never, params: params as never,
      proposedBy: input.proposedBy ?? operator,
    },
  });
  await recordAuditEvent({ caseId, action: "v2.agent.proposed", actor: input.proposedBy ?? operator, detail: { proposalId: row.id, kind, tier, title: row.title, citations: citations.length, needsApproval: needsApproval(tier) } });
  if (needsApproval(tier)) {
    await notify("proposal", { caseId, proposalId: row.id, kind, tier, title: row.title, rationale: row.rationale, citations, requiresScope: input.requiresScope, affects: row.affects, authorization: ctx.reference });
  }
  return row;
}

async function load(ctx: ScopeContext, proposalId: string) {
  const row = await prisma.agentProposal.findFirst({ where: { id: proposalId, authorizationId: ctx.authorizationId }, include: { approvals: { orderBy: { approvedAt: "desc" } } } });
  if (row === null) throw notFound(`Proposal ${proposalId} is not under authorization ${ctx.reference}.`);
  return row;
}

export async function approveProposal(input: { ctx: ScopeContext; proposalId: string; approver: string; ttlMinutes: number; note: string }) {
  const { ctx, approver } = input;
  const row = await load(ctx, input.proposalId);
  if (row.status !== "PROPOSED" && row.status !== "APPROVED") throw new HttpError(409, "proposal-closed", `Proposal ${row.id} is ${row.status.toLowerCase()}; it cannot be approved.`);
  const now = new Date();
  const live = row.approvals.find((a) => a.usedAt === null && a.expiresAt > now);
  if (live !== undefined) throw new HttpError(409, "approval-exists", `Proposal ${row.id} already has an unused approval by ${live.approvedBy} until ${live.expiresAt.toISOString()}. Approvals are one at a time.`);
  const approval = await prisma.agentApproval.create({
    data: { proposalId: row.id, approvedBy: approver, expiresAt: new Date(now.getTime() + input.ttlMinutes * 60_000), note: input.note },
  });
  await prisma.agentProposal.update({ where: { id: row.id }, data: { status: "APPROVED", decidedAt: now, decidedBy: approver, decisionNote: input.note } });
  await recordAuditEvent({ caseId: row.caseId, action: "v2.agent.approved", actor: approver, detail: { proposalId: row.id, approvalId: approval.id, kind: row.kind, tier: fromDbTier(row.tier), expiresAt: approval.expiresAt, note: input.note } });
  return approval;
}

export async function rejectProposal(input: { ctx: ScopeContext; proposalId: string; operator: string; reason: string }) {
  const row = await load(input.ctx, input.proposalId);
  if (row.status === "EXECUTED") throw new HttpError(409, "proposal-closed", `Proposal ${row.id} was executed; it cannot be rejected.`);
  const updated = await prisma.agentProposal.update({ where: { id: row.id }, data: { status: "REJECTED", decidedAt: new Date(), decidedBy: input.operator, decisionNote: input.reason } });
  await recordAuditEvent({ caseId: row.caseId, action: "v2.agent.rejected", actor: input.operator, detail: { proposalId: row.id, kind: row.kind, reason: input.reason } });
  return updated;
}

export async function executeProposal(input: { ctx: ScopeContext; caseId: string; proposalId: string; operator: string; log?: FastifyBaseLogger }) {
  const { ctx, operator } = input;
  const row = await load(ctx, input.proposalId);
  if (row.status === "EXECUTED") throw new HttpError(409, "already-executed", `Proposal ${row.id} was executed at ${row.executedAt?.toISOString() ?? "?"}. An approval is used once; propose again for another run.`);
  if (row.status === "REJECTED" || row.status === "REFUSED") throw new HttpError(409, "proposal-closed", `Proposal ${row.id} is ${row.status.toLowerCase()}.`);
  const tier = fromDbTier(row.tier);
  const kind = row.kind as ActionKind;
  const now = new Date();
  const latest = row.approvals[0] ?? null;
  const approval = latest === null ? null : { proposalId: latest.proposalId, approvedBy: latest.approvedBy, approvedAt: latest.approvedAt, expiresAt: latest.expiresAt, usedAt: latest.usedAt };

  // The gate. Consequential goes through the scope package's guard, which
  // is the prohibition; a prepare act above the autonomous tier needs the
  // same kind of approval and is refused the same way, without being
  // called a prohibition.
  if (needsApproval(tier)) {
    try {
      refuseAutonomousConsequential({ proposalId: row.id, tier: "consequential", approval }, now);
    } catch (caught) {
      if (!(caught instanceof ProhibitionError)) throw caught;
      if (tier === "consequential") throw caught;
      throw new HttpError(403, "approval-required", caught.message.replace("is consequential and ", `is a ${tier} act above AGENT_MAX_AUTONOMOUS_TIER and `));
    }
  }

  const params = (row.params ?? {}) as Record<string, unknown>;
  const action = { ctx, caseId: row.caseId, operator, proposalId: row.id, params, ...(input.log === undefined ? {} : { log: input.log }) };
  // Preconditions first: a refused act leaves the approval unused.
  await precheck(kind, action);

  if (latest !== null && needsApproval(tier)) {
    await prisma.agentApproval.update({ where: { id: latest.id }, data: { usedAt: now } });
  }
  let result: Record<string, unknown>;
  try {
    result = await perform(kind, action);
  } catch (caught) {
    await prisma.agentProposal.update({ where: { id: row.id }, data: { status: "REFUSED", decidedAt: now, decidedBy: operator, decisionNote: caught instanceof Error ? caught.message : String(caught) } });
    await recordAuditEvent({ caseId: row.caseId, action: "v2.agent.executed", actor: operator, detail: { proposalId: row.id, kind, tier, outcome: "failed", approvalId: latest?.id ?? null, message: caught instanceof Error ? caught.message : String(caught) } });
    throw caught;
  }
  const updated = await prisma.agentProposal.update({ where: { id: row.id }, data: { status: "EXECUTED", executedAt: new Date(), result: result as never } });
  await recordAuditEvent({ caseId: row.caseId, action: "v2.agent.executed", actor: operator, detail: { proposalId: row.id, kind, tier, outcome: "ok", approvalId: needsApproval(tier) ? latest?.id ?? null : null, approvedBy: needsApproval(tier) ? latest?.approvedBy ?? null : null, external: result["external"] ?? false } });
  return updated;
}
