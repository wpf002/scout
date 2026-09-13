import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { subjectSchema } from "@scout/sources";
import { prisma, recordAuditEvent } from "@scout/db";
import type { ScopeContext } from "@scout/scope";

import { HttpError, notFound } from "../errors.js";
import { buildCaseReport } from "../report/build.js";
import { renderReportHtml } from "../report/html.js";
import { runCollection } from "../v2/collect.js";
import { getRunnable } from "../v2/collectors/index.js";
import { objectStore } from "../v2/storage.js";
import { notify } from "./webhook.js";
import type { ActionKind } from "./tiers.js";

/**
 * What each act does when it runs. Prepare acts produce something to
 * review and touch nothing outside Scout; consequential acts are the only
 * ones with external effect, and they arrive here only through an approval.
 * A precondition an act cannot meet is refused before the approval is
 * consumed, so a refused act leaves the approval unused.
 */

export const paramsSchemas = {
  "draft-report": z.object({}).default({}),
  "stage-collection": z.object({ collectorId: z.string().min(1), subject: subjectSchema.optional(), params: z.record(z.string(), z.unknown()).optional() }),
  "assemble-package": z.object({}).default({}),
  "dispatch-collection": z.object({ collectorId: z.string().min(1), subject: subjectSchema.optional(), params: z.record(z.string(), z.unknown()).optional() }),
  "send-report": z.object({ recipient: z.string().trim().min(1).max(300) }),
  "write-external": z.object({ system: z.string().trim().min(1).max(200), payload: z.record(z.string(), z.unknown()).default({}) }),
  "request-scope-expansion": z.object({ requested: z.object({ scope: z.array(z.object({ kind: z.string(), value: z.string() })).default([]), entityKinds: z.array(z.string()).default([]), sourceClasses: z.array(z.string()).default([]), actionClasses: z.array(z.string()).default([]) }), justification: z.string().trim().min(1).max(2000) }),
} as const;

export interface ActionContext {
  ctx: ScopeContext;
  caseId: string;
  operator: string;
  proposalId: string;
  params: Record<string, unknown>;
  log?: FastifyBaseLogger;
}

const MEDIA_BUCKET = (): string => process.env["S3_BUCKET_MEDIA"]?.trim() || "scout-media";

async function storeReport(caseId: string, proposalId: string): Promise<{ bytes: number; objectKey: string | null }> {
  const report = await buildCaseReport(caseId);
  const html = renderReportHtml(report);
  const bytes = Buffer.byteLength(html, "utf8");
  const store = objectStore();
  // Without object storage the draft is built and measured, not kept; the
  // result says so rather than pretending a file exists.
  if (store === null) return { bytes, objectKey: null };
  const objectKey = `agent/reports/${caseId}/${proposalId}.html`;
  await store.put(MEDIA_BUCKET(), objectKey, new TextEncoder().encode(html), "text/html; charset=utf-8");
  return { bytes, objectKey };
}

/** Checks an act can run at all, before any approval is spent. Throws HttpError. */
export async function precheck(kind: ActionKind, action: ActionContext): Promise<void> {
  const { ctx, params } = action;
  if (kind === "dispatch-collection" || kind === "stage-collection") {
    const p = paramsSchemas[kind].parse(params);
    const collector = getRunnable(p.collectorId);
    if (collector === undefined) throw notFound(`Collector "${p.collectorId}" is not registered.`);
    // The same gate the route applies, run now so an approval is never
    // spent on a collection the authorization would refuse.
    ctx.assertAction("COLLECT");
    ctx.assertSourceClass(collector.sourceClass as never);
    if (collector.subjectRequired && p.subject !== undefined) ctx.assertCovers(p.subject);
  }
  if (kind === "send-report" && (process.env["AGENT_DELIVERY_WEBHOOK"]?.trim() ?? "") === "") {
    throw new HttpError(409, "no-delivery-target", "AGENT_DELIVERY_WEBHOOK is not set, so a report has nowhere to go. The approval was not used.");
  }
  if (kind === "write-external") {
    throw new HttpError(501, "no-external-writer", "No external writer is registered. Writing to an external system is an adapter interface with no implementation; the approval was not used.");
  }
}

export async function perform(kind: ActionKind, action: ActionContext): Promise<Record<string, unknown>> {
  const { ctx, caseId, operator, proposalId, params } = action;
  switch (kind) {
    case "draft-report": {
      const stored = await storeReport(caseId, proposalId);
      return { ...stored, reviewable: true, external: false };
    }
    case "stage-collection": {
      const p = paramsSchemas[kind].parse(params);
      const collector = getRunnable(p.collectorId);
      return { staged: true, collectorId: p.collectorId, collectorName: collector?.name ?? null, subject: p.subject ?? null, params: p.params ?? null, external: false, note: "Staged, not run. Dispatching it is a consequential proposal." };
    }
    case "assemble-package": {
      const [entities, observations, openReview, alerts] = await Promise.all([
        prisma.entity.count({ where: { resolutionRun: { authorizationId: ctx.authorizationId }, members: { some: { supersededAt: null } } } }),
        prisma.observation.count({ where: { authorizationId: ctx.authorizationId, caseId } }),
        prisma.matchDecision.count({ where: { decision: "REVIEW", run: { authorizationId: ctx.authorizationId } } }),
        prisma.graphAlert.count({ where: { caseId, authorizationId: ctx.authorizationId, acknowledgedAt: null } }),
      ]);
      const sources = await prisma.observation.groupBy({ by: ["sourceId"], where: { authorizationId: ctx.authorizationId, caseId }, _count: { _all: true } });
      return { manifest: { entities, observations, openReviewPairs: openReview, unacknowledgedAlerts: alerts, sources: sources.map((s) => ({ sourceId: s.sourceId, observations: s._count._all })) }, external: false };
    }
    case "dispatch-collection": {
      const p = paramsSchemas[kind].parse(params);
      const outcome = await runCollection({ ctx, caseId, operator: `${operator} (approved agent proposal ${proposalId})`, collectorId: p.collectorId, subject: p.subject, params: p.params, log: action.log });
      return { ...outcome, external: true };
    }
    case "send-report": {
      const p = paramsSchemas[kind].parse(params);
      const stored = await storeReport(caseId, proposalId);
      const delivered = await notify("delivery", { caseId, proposalId, recipient: p.recipient, objectKey: stored.objectKey, bytes: stored.bytes }, "AGENT_DELIVERY_WEBHOOK");
      if (!delivered.sent) throw new HttpError(502, "delivery-failed", `The delivery webhook did not accept the report${delivered.status === null ? "" : ` (${delivered.status})`}.`);
      return { ...stored, recipient: p.recipient, delivered: true, external: true };
    }
    case "request-scope-expansion": {
      const p = paramsSchemas[kind].parse(params);
      await recordAuditEvent({ caseId, action: "v2.agent.scope-expansion.requested", actor: operator, detail: { proposalId, authorizationId: ctx.authorizationId, reference: ctx.reference, requested: p.requested, justification: p.justification } });
      const sent = await notify("scope-expansion", { caseId, proposalId, authorization: ctx.reference, requested: p.requested, justification: p.justification });
      return { recorded: true, notified: sent.sent, authorizationChanged: false, external: true, note: "The request is on the record for the issuer. Nothing about the authorization changed." };
    }
    case "write-external":
      throw new HttpError(501, "no-external-writer", "No external writer is registered.");
  }
}
