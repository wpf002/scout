import { ScopeError, type ScopeContext } from "@scout/scope";
import { edgesAsOf, prisma, type EdgeAsOf } from "@scout/db";
import { notFound } from "../errors.js";

/**
 * The fixed set of graph operations.
 *
 * These are what the reasoning layer will later choose between and what the
 * console's scrubber drives. Every one takes a scope context and an `asOf`,
 * and answers with the graph as it was known at that instant: entities whose
 * memberships were on record by then, edges that held then and were known
 * then. Every hop of a traversal is checked against the boundary on its own;
 * an entity reachable in the graph is not automatically readable.
 */

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  status: string;
  hop?: number;
}

export const MAX_HOPS = 3;
export const MAX_PATH_HOPS = 6;
export const NODE_CAP = 500;

/**
 * Entities of this authorization known by `knownAs`, limited to permitted
 * kinds. Entities have only a knowledge clock: a record of a person does not
 * start or stop holding, it is learned and, when superseded, unlearned.
 */
export async function visibleEntities(ctx: ScopeContext, knownAs: Date, ids?: readonly string[]): Promise<Map<string, GraphNode>> {
  const rows = await prisma.entity.findMany({
    where: {
      ...(ids === undefined ? {} : { id: { in: [...ids] } }),
      resolutionRun: { authorizationId: ctx.authorizationId },
      createdAt: { lte: knownAs },
      members: { some: { addedAt: { lte: knownAs }, OR: [{ supersededAt: null }, { supersededAt: { gt: knownAs } }] } },
    },
    select: { id: true, kind: true, canonicalLabel: true, status: true },
  });
  const out = new Map<string, GraphNode>();
  for (const r of rows) {
    if (!ctx.permitsEntityKind(r.kind)) continue;
    out.set(r.id, { id: r.id, kind: r.kind, label: r.canonicalLabel, status: r.status });
  }
  return out;
}

async function requireVisible(ctx: ScopeContext, entityId: string, knownAs: Date): Promise<GraphNode> {
  const exists = await prisma.entity.findFirst({
    where: { id: entityId, resolutionRun: { authorizationId: ctx.authorizationId } },
    select: { kind: true },
  });
  if (exists === null) throw notFound(`Entity ${entityId} is not on this case's graph.`);
  if (!ctx.permitsEntityKind(exists.kind)) {
    throw new ScopeError("out-of-scope", `Authorization ${ctx.reference} does not cover ${exists.kind} entities.`);
  }
  const visible = await visibleEntities(ctx, knownAs, [entityId]);
  const node = visible.get(entityId);
  if (node === undefined) throw notFound(`Entity ${entityId} was not known at ${knownAs.toISOString()}.`);
  return node;
}

/** The two instants every operation takes. Both default to now. */
export interface Clocks {
  /** Valid time: what held then. */
  asOf: Date;
  /** Knowledge time: what Scout knew by then. Defaults to now, which asks
   * "given everything known today, what held at asOf". Pass the same instant
   * as asOf for the strict "exactly as it was known at T". */
  knownAs: Date;
}

export interface Neighborhood {
  asOf: Date;
  knownAs: Date;
  root: GraphNode;
  nodes: GraphNode[];
  edges: EdgeAsOf[];
  truncated: boolean;
}

export async function neighbors(input: { ctx: ScopeContext; entityId: string; hops: number } & Clocks): Promise<Neighborhood> {
  const { ctx, entityId, asOf, knownAs } = input;
  const hops = Math.max(1, Math.min(MAX_HOPS, input.hops));
  const root = await requireVisible(ctx, entityId, knownAs);

  const nodes = new Map<string, GraphNode>([[root.id, { ...root, hop: 0 }]]);
  const edges = new Map<string, EdgeAsOf>();
  let frontier = [root.id];
  let truncated = false;

  for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
    const found = await edgesAsOf(asOf, { entityIds: frontier, authorizationId: ctx.authorizationId, knownAs });
    const candidates = new Set<string>();
    for (const e of found) {
      edges.set(e.id, e);
      for (const id of [e.fromEntityId, e.toEntityId]) if (!nodes.has(id)) candidates.add(id);
    }
    // The per-hop scope check: only entities known and permitted become
    // nodes, and only they are expanded further.
    const visible = await visibleEntities(ctx, knownAs, [...candidates]);
    const next: string[] = [];
    for (const [id, node] of visible) {
      if (nodes.size >= NODE_CAP) { truncated = true; break; }
      nodes.set(id, { ...node, hop });
      next.push(id);
    }
    frontier = next;
  }

  // Edges to entities that did not pass the check are not shown either: an
  // edge names its other end, which is a read of that entity.
  const shown = [...edges.values()].filter((e) => nodes.has(e.fromEntityId) && nodes.has(e.toEntityId));
  return { asOf, knownAs, root, nodes: [...nodes.values()], edges: shown, truncated };
}

export interface PathResult {
  asOf: Date;
  knownAs: Date;
  found: boolean;
  hops: number | null;
  nodes: GraphNode[];
  edges: EdgeAsOf[];
}

export async function pathBetween(input: { ctx: ScopeContext; from: string; to: string; maxHops: number } & Clocks): Promise<PathResult> {
  const { ctx, asOf, knownAs } = input;
  const maxHops = Math.max(1, Math.min(MAX_PATH_HOPS, input.maxHops));
  const start = await requireVisible(ctx, input.from, knownAs);
  const goal = await requireVisible(ctx, input.to, knownAs);
  if (start.id === goal.id) return { asOf, knownAs, found: true, hops: 0, nodes: [start], edges: [] };

  const parent = new Map<string, { node: string; edge: EdgeAsOf }>();
  const seen = new Map<string, GraphNode>([[start.id, start]]);
  let frontier = [start.id];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
    const found = await edgesAsOf(asOf, { entityIds: frontier, authorizationId: ctx.authorizationId, knownAs });
    const candidates = new Map<string, { node: string; edge: EdgeAsOf }>();
    for (const e of found) {
      const here = frontier.includes(e.fromEntityId) ? e.fromEntityId : frontier.includes(e.toEntityId) ? e.toEntityId : null;
      if (here === null) continue;
      const other = here === e.fromEntityId ? e.toEntityId : e.fromEntityId;
      if (!seen.has(other) && !candidates.has(other)) candidates.set(other, { node: here, edge: e });
    }
    const visible = await visibleEntities(ctx, knownAs, [...candidates.keys()]);
    const next: string[] = [];
    for (const [id, node] of visible) {
      const via = candidates.get(id);
      if (via === undefined) continue;
      seen.set(id, node);
      parent.set(id, via);
      next.push(id);
      if (id === goal.id) {
        const nodes: GraphNode[] = [];
        const edges: EdgeAsOf[] = [];
        let cursor: string | undefined = id;
        while (cursor !== undefined) {
          nodes.unshift(seen.get(cursor) as GraphNode);
          const p = parent.get(cursor);
          if (p === undefined) break;
          edges.unshift(p.edge);
          cursor = p.node;
        }
        return { asOf, knownAs, found: true, hops: edges.length, nodes, edges };
      }
    }
    frontier = next;
  }
  return { asOf, knownAs, found: false, hops: null, nodes: [], edges: [] };
}

export interface TimelineEvent {
  at: Date;
  kind: "observation" | "membership" | "edge-start" | "edge-end";
  observationId?: string;
  sourceId?: string;
  edgeId?: string;
  relation?: string;
  otherEntityId?: string;
  detail: string;
}

export async function timelineForEntity(input: { ctx: ScopeContext; entityId: string } & Clocks): Promise<{ asOf: Date; knownAs: Date; entity: GraphNode; events: TimelineEvent[] }> {
  const { ctx, entityId, asOf, knownAs } = input;
  const entity = await requireVisible(ctx, entityId, knownAs);

  const members = await prisma.entityMember.findMany({
    where: { entityId, addedAt: { lte: knownAs }, OR: [{ supersededAt: null }, { supersededAt: { gt: knownAs } }] },
    include: { observation: { select: { id: true, sourceId: true, observedAt: true } } },
  });
  const events: TimelineEvent[] = [];
  for (const m of members) {
    if (m.observation.observedAt <= asOf) {
      events.push({ at: m.observation.observedAt, kind: "observation", observationId: m.observationId, sourceId: m.observation.sourceId, detail: `observed by ${m.observation.sourceId}` });
    }
    if (m.addedAt <= asOf) {
      events.push({ at: m.addedAt, kind: "membership", observationId: m.observationId, detail: `${m.addedBy === "ANALYST" ? "analyst" : "resolution"} added observation (${m.method}, ${m.scoreBp} bp)` });
    }
  }
  // Everything known by knownAs that had begun by asOf: a timeline is the
  // history up to a moment, not only what still holds at it.
  const edges = (await edgesAsOf(null, { entityIds: [entityId], authorizationId: ctx.authorizationId, knownAs })).filter((e) => e.validFrom <= asOf);
  const others = await visibleEntities(ctx, knownAs, edges.map((e) => (e.fromEntityId === entityId ? e.toEntityId : e.fromEntityId)));
  for (const e of edges) {
    const other = e.fromEntityId === entityId ? e.toEntityId : e.fromEntityId;
    if (!others.has(other)) continue;
    events.push({ at: e.validFrom, kind: "edge-start", edgeId: e.id, relation: e.relation, otherEntityId: other, detail: `${e.relation} with ${others.get(other)?.label ?? other} began` });
    if (e.validUntil !== null && e.validUntil <= asOf) {
      events.push({ at: e.validUntil, kind: "edge-end", edgeId: e.id, relation: e.relation, otherEntityId: other, detail: `${e.relation} with ${others.get(other)?.label ?? other} ended` });
    }
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { asOf, knownAs, entity, events };
}

export async function coLocationWindow(input: { ctx: ScopeContext; entityId: string; from: Date; to: Date }): Promise<{ entity: GraphNode; edges: EdgeAsOf[]; others: GraphNode[] }> {
  const { ctx, entityId, from, to } = input;
  const now = new Date();
  const entity = await requireVisible(ctx, entityId, now);
  const all = await edgesAsOf(null, { entityIds: [entityId], authorizationId: ctx.authorizationId, knownAs: now });
  const inWindow = all.filter((e) => e.relation === "CO_LOCATED" && e.validFrom < to && (e.validUntil === null || e.validUntil > from));
  const others = await visibleEntities(ctx, now, inWindow.map((e) => (e.fromEntityId === entityId ? e.toEntityId : e.fromEntityId)));
  return { entity, edges: inWindow.filter((e) => others.has(e.fromEntityId === entityId ? e.toEntityId : e.fromEntityId)), others: [...others.values()] };
}
