import { prisma, recordAuditEvent } from "@scout/db";
import { ScopeContext } from "@scout/scope";

import { evaluateMonitors } from "./monitors.js";
import { propose } from "./proposals.js";

export { proposalSchema, propose, approveProposal, rejectProposal, executeProposal } from "./proposals.js";
export { monitorSchema, createMonitor, disableMonitor, evaluateMonitors } from "./monitors.js";
export { ACTION_KINDS, ACTION_KIND_NAMES, tierOf, needsApproval, maxAutonomousTier } from "./tiers.js";

/**
 * The observe pass: what the agent does on its own. It evaluates the
 * monitors, and for every case where a monitor alerted since the last pass
 * it proposes (never performs) assembling an evidence package, citing the
 * observations the alerts named. That is the whole of its autonomy; every
 * step up from there is a proposal a human decides.
 */
export async function agentTick(operator: string, nowMs: number): Promise<{ checked: number; ran: number; alerted: number; disabled: number; proposed: number }> {
  const now = new Date(nowMs);
  const sweep = await evaluateMonitors(operator, now);
  let proposed = 0;
  const byCase = new Map<string, string[]>();
  for (const a of sweep.alerts) byCase.set(a.caseId, [...(byCase.get(a.caseId) ?? []), ...a.observationIds]);
  for (const [caseId, observationIds] of byCase) {
    const record = await prisma.case.findUnique({ where: { id: caseId }, include: { authorization: true } });
    if (record?.authorization == null) continue;
    let ctx: ScopeContext;
    try {
      ctx = ScopeContext.build({ authorization: record.authorization, operator, now });
    } catch {
      continue;
    }
    const citations = [...new Set(observationIds)].slice(0, 50);
    if (citations.length === 0) continue;
    // One open package proposal per case at a time; more alerts fold into the next.
    const open = await prisma.agentProposal.findFirst({ where: { caseId, kind: "assemble-package", status: "PROPOSED", proposedBy: "agent" } });
    if (open !== null) continue;
    await propose({
      ctx, caseId, operator, proposedBy: "agent", kind: "assemble-package",
      title: `Assemble the evidence behind ${byCase.get(caseId)?.length ?? 0} monitor alert${(byCase.get(caseId)?.length ?? 0) === 1 ? "" : "s"}`,
      rationale: `Monitors on this case alerted during the sweep at ${now.toISOString()}. The package gathers what the case holds so a person can read it in one place. Nothing leaves Scout.`,
      citations, requiresScope: { actionClasses: ["READ_GRAPH"] }, affects: { external: false }, params: {},
    });
    proposed += 1;
  }
  if (sweep.alerted > 0 || sweep.disabled > 0 || proposed > 0) {
    await recordAuditEvent({ action: "v2.agent.tick", actor: operator, detail: { checked: sweep.checked, alerted: sweep.alerted, disabled: sweep.disabled, proposed } });
  }
  return { checked: sweep.checked, ran: sweep.alerted + proposed, alerted: sweep.alerted, disabled: sweep.disabled, proposed };
}
