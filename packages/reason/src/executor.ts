import type { ScopeContext } from "@scout/scope";

import { MAX_COST, planCost, refsOf, type EntityRef, type QueryPlan, type Step } from "./plan.js";
import { refuse } from "./refusal.js";

/**
 * The executor runs a validated plan through a fixed set of operations
 * that the host supplies. The operations are the only way to the graph;
 * each one is already scope-checked in the host (packages/db, apps/api),
 * and the executor checks again on the way out: every entity a step
 * returns is tested against the authorization's entity kinds, and a step
 * that names an entity the caller can't see is refused with the reason.
 *
 * The budget is enforced here too, before any step runs. Reachability is
 * not readability: a plan that would walk further than the budget allows
 * doesn't start.
 */

export interface Node {
  id: string;
  kind: string;
  label: string;
  status: string;
}

export interface Edge {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  validFrom: Date;
  validUntil: Date | null;
  confidenceBp: number;
  basis: string | null;
  evidenceObservationIds: string[];
}

export interface Event {
  at: Date;
  kind: "observation" | "membership" | "edge-start" | "edge-end";
  detail: string;
  observationId?: string;
  sourceId?: string;
  edgeId?: string;
  relation?: string;
  otherEntityId?: string;
  evidenceObservationIds?: string[];
}

export interface Coverage {
  sourceId: string;
  observations: number;
  lastObservedAt: Date | null;
}

export interface Operations {
  findEntities(input: { text: string; kind?: string; limit: number }): Promise<Node[]>;
  neighbors(input: { entityId: string; hops: number; asOf: Date }): Promise<{ root: Node; nodes: Node[]; edges: Edge[]; truncated: boolean }>;
  pathBetween(input: { from: string; to: string; maxHops: number; asOf: Date }): Promise<{ found: boolean; hops: number | null; nodes: Node[]; edges: Edge[] }>;
  coLocation(input: { entityId: string; from: Date; to: Date }): Promise<{ entity: Node; edges: Edge[]; others: Node[] }>;
  timeline(input: { entityId: string; asOf: Date }): Promise<{ entity: Node; events: Event[] }>;
  sourcesConsulted(): Promise<Coverage[]>;
}

export interface StepResult {
  id: string;
  op: Step["op"];
  /** The text a find step looked for, so a miss can be named in the answer. */
  lookedFor?: string;
  nodes: Node[];
  edges: Edge[];
  events: Event[];
  coverage: Coverage[];
  found?: boolean;
  truncated?: boolean;
  window?: { from: Date; to: Date };
  asOf?: Date;
}

export interface Execution {
  cost: number;
  results: StepResult[];
  /** Every observation id any step produced: the set an answer may cite. */
  evidence: Set<string>;
}

export async function executePlan(plan: QueryPlan, ops: Operations, ctx: ScopeContext, now: Date = new Date()): Promise<Execution> {
  const reference = ctx.reference;
  const cost = planCost(plan);
  if (cost > MAX_COST) {
    refuse({ reason: "budget-exceeded", message: `The plan would cost ${cost} against a budget of ${MAX_COST}.`, requires: "A narrower question: fewer hops or fewer steps.", authorizationReference: reference });
  }
  if (!ctx.permitsAction("READ_GRAPH")) {
    refuse({
      reason: "action-not-permitted",
      message: `Authorization #${reference} does not permit READ_GRAPH, so the entity graph cannot be read to answer this.`,
      requires: `READ_GRAPH in the action classes of authorization #${reference}.`,
      authorizationReference: reference,
    });
  }

  const results: StepResult[] = [];
  const byId = new Map<string, StepResult>();
  const evidence = new Set<string>();

  const resolveRef = (step: Step, ref: EntityRef): string => {
    if ("entityId" in ref) return ref.entityId;
    const source = byId.get(ref.ref);
    const hit = source?.nodes[ref.index];
    if (source === undefined || hit === undefined) {
      const looked = source?.lookedFor ?? ref.ref;
      refuse({
        reason: "unknown-entity",
        message: `No entity matching "${looked}" is known under authorization #${reference}, so step ${step.id} (${step.op}) has nothing to run on.`,
        requires: `Collection on "${looked}" under an authorization that covers it. If "${looked}" is outside the boundary of #${reference}, this authorization cannot be used for it.`,
        authorizationReference: reference,
      });
    }
    return hit.id;
  };

  const admit = (nodes: Node[]): Node[] => {
    // The host already filtered; this is the second lock on the same door.
    const kept = nodes.filter((n) => ctx.permitsEntityKind(n.kind));
    const dropped = nodes.filter((n) => !ctx.permitsEntityKind(n.kind));
    if (dropped.length > 0 && kept.length === 0) {
      const first = dropped[0] as Node;
      refuse({
        reason: "out-of-scope-subject",
        message: `Answering requires reading a ${first.kind.toLowerCase()} entity, and authorization #${reference} does not cover that kind.`,
        requires: `An authorization whose boundary includes entity kind ${first.kind}.`,
        authorizationReference: reference,
      });
    }
    return kept;
  };

  const cite = (edges: Edge[], events: Event[]) => {
    for (const e of edges) for (const id of e.evidenceObservationIds) evidence.add(id);
    for (const ev of events) {
      if (ev.observationId !== undefined) evidence.add(ev.observationId);
      for (const id of ev.evidenceObservationIds ?? []) evidence.add(id);
    }
  };

  for (const step of plan.steps) {
    for (const ref of refsOf(step)) resolveRef(step, ref);
    let result: StepResult;
    switch (step.op) {
      case "find-entity": {
        if (step.kind !== undefined && !ctx.permitsEntityKind(step.kind)) {
          refuse({
            reason: "out-of-scope-subject",
            message: `Looking for a ${step.kind.toLowerCase()} entity requires an authorization that covers that kind; #${reference} does not.`,
            requires: `An authorization whose boundary includes entity kind ${step.kind}.`,
            authorizationReference: reference,
          });
        }
        const nodes = admit(await ops.findEntities({ text: step.text, limit: step.limit, ...(step.kind === undefined ? {} : { kind: step.kind }) }));
        result = { id: step.id, op: step.op, lookedFor: step.text, nodes, edges: [], events: [], coverage: [] };
        break;
      }
      case "neighbors-of": {
        const asOf = step.asOf ?? now;
        const r = await ops.neighbors({ entityId: resolveRef(step, step.entity), hops: step.hops, asOf });
        const nodes = admit(r.nodes);
        result = { id: step.id, op: step.op, nodes, edges: r.edges, events: [], coverage: [], truncated: r.truncated, asOf };
        cite(r.edges, []);
        break;
      }
      case "path-between": {
        const asOf = step.asOf ?? now;
        const r = await ops.pathBetween({ from: resolveRef(step, step.from), to: resolveRef(step, step.to), maxHops: step.maxHops, asOf });
        result = { id: step.id, op: step.op, nodes: admit(r.nodes), edges: r.edges, events: [], coverage: [], found: r.found, asOf };
        cite(r.edges, []);
        break;
      }
      case "co-location-window": {
        const r = await ops.coLocation({ entityId: resolveRef(step, step.entity), from: step.from, to: step.to });
        result = { id: step.id, op: step.op, nodes: admit([r.entity, ...r.others]), edges: r.edges, events: [], coverage: [], window: { from: step.from, to: step.to } };
        cite(r.edges, []);
        break;
      }
      case "timeline-for-entity": {
        const asOf = step.asOf ?? now;
        const r = await ops.timeline({ entityId: resolveRef(step, step.entity), asOf });
        result = { id: step.id, op: step.op, nodes: admit([r.entity]), edges: [], events: r.events, coverage: [], asOf };
        cite([], r.events);
        break;
      }
      case "sources-consulted": {
        result = { id: step.id, op: step.op, nodes: [], edges: [], events: [], coverage: await ops.sourcesConsulted() };
        break;
      }
    }
    results.push(result);
    byId.set(step.id, result);
  }
  return { cost, results, evidence };
}
