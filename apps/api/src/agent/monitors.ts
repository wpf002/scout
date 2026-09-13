import { createHash } from "node:crypto";
import { z } from "zod";
import { edgesAsOf, prisma, recordAuditEvent } from "@scout/db";
import { ScopeContext, ScopeError, type ScopeContext as Ctx } from "@scout/scope";

import { HttpError, notFound } from "../errors.js";
import { visibleEntities } from "../v2/graph.js";

/**
 * Standing watches on the graph, inside one authorization. Observe tier:
 * they read, compare with what they saw last time, and write an alert with
 * the observations behind the change. They do not outlive their
 * authorization: the first sweep that cannot build the scope context
 * disables the monitor and says why.
 */

export const monitorSchema = z.object({
  caseId: z.string().min(1),
  kind: z.enum(["CO_LOCATION", "NEW_OBSERVATIONS", "MEMBERSHIP_CHANGE"]),
  name: z.string().trim().min(1).max(200),
  params: z.object({ entityId: z.string().min(1), otherEntityId: z.string().min(1).optional() }),
});

interface State {
  memberHash?: string;
  members?: number;
  latestObservedAt?: string | null;
  edgeIds?: string[];
}

async function stateOf(ctx: Ctx, kind: "CO_LOCATION" | "NEW_OBSERVATIONS" | "MEMBERSHIP_CHANGE", params: { entityId: string; otherEntityId?: string | undefined }, now: Date): Promise<{ state: State; observationIds: string[] }> {
  const members = await prisma.entityMember.findMany({
    where: { entityId: params.entityId, supersededAt: null },
    include: { observation: { select: { id: true, observedAt: true } } },
    orderBy: { observation: { observedAt: "desc" } },
  });
  const ids = members.map((m) => m.observationId).sort();
  if (kind === "NEW_OBSERVATIONS") {
    return { state: { members: ids.length, latestObservedAt: members[0]?.observation.observedAt.toISOString() ?? null, memberHash: createHash("sha256").update(ids.join(",")).digest("hex") }, observationIds: ids };
  }
  if (kind === "MEMBERSHIP_CHANGE") {
    return { state: { members: ids.length, memberHash: createHash("sha256").update(ids.join(",")).digest("hex") }, observationIds: ids };
  }
  const edges = (await edgesAsOf(null, { entityIds: [params.entityId], authorizationId: ctx.authorizationId, knownAs: now }))
    .filter((e) => e.relation === "CO_LOCATED")
    .filter((e) => params.otherEntityId === undefined || e.fromEntityId === params.otherEntityId || e.toEntityId === params.otherEntityId);
  return { state: { edgeIds: edges.map((e) => e.id).sort() }, observationIds: [...new Set(edges.flatMap((e) => e.evidenceObservationIds))] };
}

export async function createMonitor(input: { ctx: Ctx; caseId: string; operator: string; kind: z.infer<typeof monitorSchema>["kind"]; name: string; params: z.infer<typeof monitorSchema>["params"] }) {
  const { ctx, caseId, operator, kind, params } = input;
  if (kind === "CO_LOCATION" && params.otherEntityId === undefined) throw new HttpError(400, "other-entity-required", "A co-location monitor names the other entity.");
  const now = new Date();
  const wanted = [params.entityId, ...(params.otherEntityId === undefined ? [] : [params.otherEntityId])];
  const visible = await visibleEntities(ctx, now, wanted);
  for (const id of wanted) if (!visible.has(id)) throw notFound(`Entity ${id} is not known under authorization ${ctx.reference}.`);
  const baseline = await stateOf(ctx, kind, params, now);
  const row = await prisma.graphMonitor.create({
    data: { caseId, authorizationId: ctx.authorizationId, kind, name: input.name, params: params as never, createdBy: operator, lastEvaluatedAt: now, lastState: baseline.state as never },
  });
  await recordAuditEvent({ caseId, action: "v2.agent.monitor.created", actor: operator, detail: { monitorId: row.id, kind, name: input.name, params } });
  return row;
}

export async function disableMonitor(input: { ctx: Ctx; monitorId: string; operator: string; reason: string }) {
  const row = await prisma.graphMonitor.findFirst({ where: { id: input.monitorId, authorizationId: input.ctx.authorizationId } });
  if (row === null) throw notFound(`Monitor ${input.monitorId} is not under this authorization.`);
  if (row.disabledAt !== null) return row;
  const updated = await prisma.graphMonitor.update({ where: { id: row.id }, data: { disabledAt: new Date(), disabledReason: input.reason } });
  await recordAuditEvent({ caseId: row.caseId, action: "v2.agent.monitor.disabled", actor: input.operator, detail: { monitorId: row.id, reason: input.reason } });
  return updated;
}

export interface SweepResult {
  checked: number;
  alerted: number;
  disabled: number;
  alerts: Array<{ id: string; caseId: string; monitorId: string; observationIds: string[] }>;
}

/**
 * One pass over every enabled monitor. A monitor whose authorization no
 * longer holds is disabled with the scope reason and evaluated no further.
 */
export async function evaluateMonitors(operator: string, now: Date = new Date()): Promise<SweepResult> {
  const monitors = await prisma.graphMonitor.findMany({ where: { disabledAt: null }, orderBy: { createdAt: "asc" } });
  const result: SweepResult = { checked: 0, alerted: 0, disabled: 0, alerts: [] };
  const contexts = new Map<string, Ctx | ScopeError>();
  for (const monitor of monitors) {
    result.checked += 1;
    let ctx = contexts.get(monitor.authorizationId);
    if (ctx === undefined) {
      const auth = await prisma.authorization.findUnique({ where: { id: monitor.authorizationId } });
      try {
        if (auth === null) throw new ScopeError("authorization-missing", "The authorization no longer exists.");
        ctx = ScopeContext.build({ authorization: auth, operator, now });
      } catch (caught) {
        ctx = caught instanceof ScopeError ? caught : new ScopeError("authorization-missing", caught instanceof Error ? caught.message : String(caught));
      }
      contexts.set(monitor.authorizationId, ctx);
    }
    if (ctx instanceof ScopeError) {
      await prisma.graphMonitor.update({ where: { id: monitor.id }, data: { disabledAt: now, disabledReason: `${ctx.reason}: ${ctx.message}` } });
      await recordAuditEvent({ caseId: monitor.caseId, action: "v2.agent.monitor.disabled", actor: operator, detail: { monitorId: monitor.id, reason: ctx.reason, automatic: true } });
      result.disabled += 1;
      continue;
    }
    const params = monitor.params as { entityId: string; otherEntityId?: string };
    const previous = (monitor.lastState ?? {}) as State;
    const current = await stateOf(ctx, monitor.kind, params, now);
    let summary: string | null = null;
    let evidence: string[] = [];
    if (monitor.kind === "NEW_OBSERVATIONS" && current.state.memberHash !== previous.memberHash) {
      const before = new Set((previous as { ids?: string[] }).ids ?? []);
      const added = current.observationIds.filter((id) => !before.has(id));
      summary =
        (current.state.members ?? 0) === 0
          ? `${monitor.name}: the watched entity was superseded by a resolution run (merged or split); watch its successor`
          : `${monitor.name}: ${added.length > 0 ? `${added.length} new observation${added.length === 1 ? "" : "s"}` : "membership changed"} (${current.state.members ?? 0} now, latest ${current.state.latestObservedAt ?? "—"})`;
      evidence = (added.length > 0 ? added : current.observationIds).slice(0, 50);
    } else if (monitor.kind === "MEMBERSHIP_CHANGE" && current.state.memberHash !== previous.memberHash) {
      summary =
        (current.state.members ?? 0) === 0
          ? `${monitor.name}: the watched entity was superseded by a resolution run (merged or split)`
          : `${monitor.name}: membership changed from ${previous.members ?? 0} to ${current.state.members ?? 0} observations after a resolution run`;
      evidence = current.observationIds.slice(0, 50);
    } else if (monitor.kind === "CO_LOCATION") {
      const before = new Set(previous.edgeIds ?? []);
      const fresh = (current.state.edgeIds ?? []).filter((id) => !before.has(id));
      if (fresh.length > 0) {
        summary = `${monitor.name}: ${fresh.length} new co-location ${fresh.length === 1 ? "window" : "windows"}${params.otherEntityId === undefined ? "" : " with the watched entity"}`;
        evidence = current.observationIds.slice(0, 50);
      }
    }
    const nextState = { ...current.state, ids: monitor.kind === "NEW_OBSERVATIONS" ? current.observationIds : undefined };
    await prisma.graphMonitor.update({ where: { id: monitor.id }, data: { lastEvaluatedAt: now, lastState: nextState as never } });
    if (summary !== null) {
      const alert = await prisma.graphAlert.create({
        data: { monitorId: monitor.id, caseId: monitor.caseId, authorizationId: monitor.authorizationId, at: now, summary, detail: { kind: monitor.kind, before: previous, after: current.state } as never, observationIds: evidence },
      });
      await recordAuditEvent({ caseId: monitor.caseId, action: "v2.agent.alert", actor: operator, detail: { monitorId: monitor.id, alertId: alert.id, kind: monitor.kind, summary, evidence: evidence.length } });
      result.alerted += 1;
      result.alerts.push({ id: alert.id, caseId: monitor.caseId, monitorId: monitor.id, observationIds: evidence });
    }
  }
  return result;
}
