import { createHash } from "node:crypto";
import type { ScopeContext } from "@scout/scope";
import { coLocatedObservations, prisma, recordAuditEvent } from "@scout/db";

/**
 * Deriving edges between entities from what was observed.
 *
 * Three rules, each deterministic, each writing the observations that
 * evidence it onto the edge. Nothing here infers a relationship the data does
 * not show: OWNS, OPERATES, MEMBER_OF and the rest wait for a source that
 * asserts them.
 *
 *   shared:DEVICE_ID   two entities whose observations carry the same device
 *                      → SAME_DEVICE
 *   shared:<kind>      the same phone, email, handle or address on two
 *                      entities → ASSOCIATED_WITH, confidence by kind
 *   co-location        positioned observations of two entities within a
 *                      radius and a time window → CO_LOCATED, one edge per
 *                      merged window, confidence by closest approach
 *
 * Re-running derives the same edges with the same fingerprints and keeps
 * them; an edge no longer derivable is superseded, never deleted, so the
 * graph as it was known at any earlier moment still reads back.
 */

export interface DeriveOptions {
  /** Metres. Two observations closer than this are co-located. */
  radiusM: number;
  /** Minutes. Two observations further apart in time than this are not. */
  windowMinutes: number;
}

export const DEFAULT_DERIVE: DeriveOptions = { radiusM: 2_000, windowMinutes: 30 };

/** Beyond this many entities on one value it is a switchboard, not a link. */
const HUB_LIMIT = 20;
const EVIDENCE_CAP = 50;

const SHARED: Record<string, { relation: "SAME_DEVICE" | "ASSOCIATED_WITH"; confidenceBp: number }> = {
  DEVICE_ID: { relation: "SAME_DEVICE", confidenceBp: 9_000 },
  EMAIL: { relation: "ASSOCIATED_WITH", confidenceBp: 8_000 },
  PHONE: { relation: "ASSOCIATED_WITH", confidenceBp: 7_500 },
  HANDLE: { relation: "ASSOCIATED_WITH", confidenceBp: 7_000 },
  ADDRESS: { relation: "ASSOCIATED_WITH", confidenceBp: 5_500 },
};

interface Derived {
  fromEntityId: string;
  toEntityId: string;
  relation: "SAME_DEVICE" | "ASSOCIATED_WITH" | "CO_LOCATED";
  basis: string;
  confidenceBp: number;
  validFrom: Date;
  validUntil: Date | null;
  evidenceObservationIds: string[];
  fingerprint: string;
}

function fingerprint(d: Omit<Derived, "fingerprint">): string {
  return createHash("sha256")
    .update(
      [d.fromEntityId, d.toEntityId, d.relation, d.basis, d.validFrom.toISOString(), d.validUntil?.toISOString() ?? "", d.evidenceObservationIds.join(",")].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

function ordered(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export interface DeriveSummary {
  runId: string;
  options: DeriveOptions;
  entities: number;
  created: number;
  kept: number;
  superseded: number;
  skippedHubs: number;
  byBasis: Record<string, number>;
  edges: { id: string; fromEntityId: string; toEntityId: string; relation: string; basis: string; confidenceBp: number; validFrom: Date; validUntil: Date | null; evidenceObservationIds: string[] }[];
}

export async function deriveLinks(input: {
  ctx: ScopeContext;
  caseId: string;
  operator: string;
  options?: Partial<DeriveOptions>;
}): Promise<DeriveSummary> {
  const { ctx, caseId, operator } = input;
  const options = { ...DEFAULT_DERIVE, ...input.options };
  ctx.assertAction("RESOLVE");

  const entities = await prisma.entity.findMany({
    where: {
      resolutionRun: { authorizationId: ctx.authorizationId },
      members: { some: { supersededAt: null } },
    },
    include: {
      members: {
        where: { supersededAt: null },
        include: { observation: { include: { identifiers: true } } },
      },
    },
  });
  const permitted = entities.filter((e) => ctx.permitsEntityKind(e.kind));

  const entityOf = new Map<string, string>();
  const observedAt = new Map<string, Date>();
  for (const e of permitted) {
    for (const m of e.members) {
      if (!entityOf.has(m.observationId)) entityOf.set(m.observationId, e.id);
      observedAt.set(m.observationId, m.observation.observedAt);
    }
  }

  const derived = new Map<string, Derived>();
  let skippedHubs = 0;
  const add = (d: Omit<Derived, "fingerprint">) => {
    const fp = fingerprint(d);
    if (!derived.has(fp)) derived.set(fp, { ...d, fingerprint: fp });
  };

  // ── shared identifiers ──
  const byValue = new Map<string, Map<string, string[]>>(); // kind:value → entity → observation ids
  for (const e of permitted) {
    for (const m of e.members) {
      for (const i of m.observation.identifiers) {
        if (!(i.kind in SHARED)) continue;
        const key = `${i.kind}:${i.normalizedValue}`;
        const perEntity = byValue.get(key) ?? new Map<string, string[]>();
        perEntity.set(e.id, [...(perEntity.get(e.id) ?? []), m.observationId]);
        byValue.set(key, perEntity);
      }
    }
  }
  for (const [key, perEntity] of byValue) {
    if (perEntity.size < 2) continue;
    if (perEntity.size > HUB_LIMIT) {
      skippedHubs += 1;
      continue;
    }
    const kind = key.slice(0, key.indexOf(":"));
    const rule = SHARED[kind];
    if (rule === undefined) continue;
    const ids = [...perEntity.keys()].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const [from, to] = ordered(ids[i] as string, ids[j] as string);
        const evidence = [...(perEntity.get(from) ?? []), ...(perEntity.get(to) ?? [])].sort().slice(0, EVIDENCE_CAP);
        const validFrom = new Date(Math.min(...evidence.map((id) => observedAt.get(id)?.getTime() ?? Date.now())));
        add({ fromEntityId: from, toEntityId: to, relation: rule.relation, basis: `shared:${kind}`, confidenceBp: rule.confidenceBp, validFrom, validUntil: null, evidenceObservationIds: evidence });
      }
    }
  }

  // ── co-location ──
  const windowMs = options.windowMinutes * 60_000;
  const pairs = await coLocatedObservations(ctx.authorizationId, options.radiusM, options.windowMinutes * 60);
  interface Interval { start: number; end: number; minMeters: number; evidence: Set<string> }
  const byPair = new Map<string, Interval[]>();
  for (const p of pairs) {
    const ea = entityOf.get(p.leftObservationId);
    const eb = entityOf.get(p.rightObservationId);
    if (ea === undefined || eb === undefined || ea === eb) continue;
    const [from, to] = ordered(ea, eb);
    const key = `${from}|${to}`;
    const start = Math.min(p.leftObservedAt.getTime(), p.rightObservedAt.getTime());
    const end = Math.max(p.leftObservedAt.getTime(), p.rightObservedAt.getTime()) + windowMs;
    byPair.set(key, [...(byPair.get(key) ?? []), { start, end, minMeters: p.meters, evidence: new Set([p.leftObservationId, p.rightObservationId]) }]);
  }
  const basis = `co-location:${options.radiusM}m/${options.windowMinutes}min`;
  for (const [key, intervals] of byPair) {
    intervals.sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last !== undefined && iv.start <= last.end) {
        last.end = Math.max(last.end, iv.end);
        last.minMeters = Math.min(last.minMeters, iv.minMeters);
        for (const id of iv.evidence) last.evidence.add(id);
      } else {
        merged.push({ ...iv, evidence: new Set(iv.evidence) });
      }
    }
    const [from, to] = key.split("|") as [string, string];
    for (const iv of merged) {
      add({
        fromEntityId: from, toEntityId: to, relation: "CO_LOCATED", basis,
        confidenceBp: Math.round(6_000 + 3_000 * (1 - Math.min(1, iv.minMeters / options.radiusM))),
        validFrom: new Date(iv.start), validUntil: new Date(iv.end),
        evidenceObservationIds: [...iv.evidence].sort().slice(0, EVIDENCE_CAP),
      });
    }
  }

  // ── reconcile with what is already on the graph ──
  const event = await recordAuditEvent({
    caseId, action: "v2.links.derived", actor: operator,
    detail: { authorizationId: ctx.authorizationId, options, entities: permitted.length, candidate: derived.size, skippedHubs },
  });
  const runId = event.id;

  const existing = await prisma.entityEdge.findMany({
    where: { authorizationId: ctx.authorizationId, supersededAt: null, basis: { not: "asserted" } },
    select: { id: true, fingerprint: true },
  });
  const existingByFp = new Map(existing.filter((e) => e.fingerprint !== null).map((e) => [e.fingerprint as string, e.id]));
  const toCreate = [...derived.values()].filter((d) => !existingByFp.has(d.fingerprint));
  const kept = [...derived.values()].filter((d) => existingByFp.has(d.fingerprint)).length;
  const stale = existing.filter((e) => e.fingerprint === null || !derived.has(e.fingerprint)).map((e) => e.id);

  ctx.assertLive();
  if (stale.length > 0) {
    await prisma.entityEdge.updateMany({ where: { id: { in: stale } }, data: { supersededAt: new Date(), supersededBy: runId } });
  }
  if (toCreate.length > 0) {
    await prisma.entityEdge.createMany({
      data: toCreate.map((d) => ({ ...d, authorizationId: ctx.authorizationId, createdBy: operator })),
    });
  }

  const edges = await prisma.entityEdge.findMany({
    where: { authorizationId: ctx.authorizationId, supersededAt: null, basis: { not: "asserted" } },
    orderBy: [{ validFrom: "asc" }, { id: "asc" }],
  });
  const byBasis: Record<string, number> = {};
  for (const e of edges) byBasis[e.basis] = (byBasis[e.basis] ?? 0) + 1;

  return {
    runId, options, entities: permitted.length,
    created: toCreate.length, kept, superseded: stale.length, skippedHubs, byBasis,
    edges: edges.map((e) => ({
      id: e.id, fromEntityId: e.fromEntityId, toEntityId: e.toEntityId, relation: e.relation, basis: e.basis,
      confidenceBp: e.confidenceBp, validFrom: e.validFrom, validUntil: e.validUntil, evidenceObservationIds: e.evidenceObservationIds,
    })),
  };
}
