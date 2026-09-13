# Scout v2 architecture

v2 adds collection with provenance, probabilistic entity resolution, a temporal
entity graph, gallery-restricted biometrics, a reasoning layer, an investigation
console, and a bounded agent. v1 stays as it is. Nothing here replaces the case
tiers, the scope gate, the audit log, or the live map.

## Layers

| Layer | Where | Language | State |
|---|---|---|---|
| Scope context and prohibitions | `packages/scope/src/context.ts`, `prohibitions.ts` | TS | Phase 2 |
| Observations, collectors, temporal predicate | `packages/fusion` | TS | Phase 2 |
| Schema | `packages/db/prisma/schema.prisma` (v2 section) | Prisma | Phase 2 |
| Collection routes and collectors | `apps/api/src/routes/v2.ts`, `apps/api/src/v2/` | TS | Built: ADS-B, SEC EDGAR |
| Resolution | `services/resolution` | Python | Phase 6 |
| Recognition | `services/recognition` | Python | Phase 10, flag off |
| Reasoning seam | `packages/reason` | TS | Phase 8 |
| Console | `apps/web/src/app/console/` | TS | Phase 9 |
| Agent | `apps/api/src/agent/` | TS | Phase 11 |

## Data flow

```
 upstream (OpenSky, AIS, imagery, records, first-party)
        │
        ▼
 collector.normalize()          packages/fusion — declares licence, class, rate limit
        │  ObservationInput[]   every one carries sourceId, authorizationId,
        ▼                        collectedAt, observedAt; missing = write refused
 POST /v2/observations          scope context required (COLLECT + source class)
        │
        ▼
 Observation + Identifier       Postgres. geom is PostGIS geography.
        │
        ▼
 services/resolution            normalize → block → Splink score → threshold
        │                        → cluster (transitivity guard) → persist
        ▼
 Entity, EntityMember,          MatchDecision for every pair, matches and not.
 MatchDecision, ResolutionRun   REVIEW rows queue for a human. Adjudication pins.
        │
        ▼
 EntityEdge (validFrom/Until,   the temporal graph. Every read carries asOf and
 createdAt/supersededAt)        is logged to AccessLog with ids, not payloads.
        │
        ▼
 console / reasoning / agent    all through the same scope-checked read path
```

## Two clocks

Every edge and membership has valid time (`validFrom`, `validUntil`) and
knowledge time (`createdAt`, `supersededAt`). A query at `asOf = T` returns
rows that held at T and were known by T. `packages/fusion/src/temporal.ts`
holds the predicate in one place, as a function and as SQL.

## No graph database

The spec named Apache AGE as a projection. It is not used. Railway's managed
Postgres cannot load the extension, and the reasoning layer never emits Cypher:
it chooses from typed operations (neighbors-of, path-between,
co-location-window, timeline-for-entity, sources-consulted), each a parameterised
SQL query with the `asOf` predicate and a scope check. Recursive CTEs cover the
multi-hop cases with a hop cap. If a real workload ever needs more, the
relational tables are the source of truth and a projection can be added then.

## Two connector systems, one wrapper

Scout already has `Source` (case tiers) and `LayerDef` (live map). Both stay.
A v2 `Collector` wraps either, adds the declarations the spec requires, and
produces provenanced observations. Neither existing interface changes.

## What did not change

- `checkScope()` and `enforceScope()` gate v1 exactly as before.
- `SCOUT_AUTHORIZE_ALL` applies to v1 tiers only. v2 never reads it.
- The v1 case graph (`packages/graph`) is still recomputed on read.
- `QueryLog` and `AuditEvent` keep their shape. v2 reads log to a new
  append-only `AccessLog` with the same immutability trigger.
