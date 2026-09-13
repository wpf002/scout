# Scout v2 architecture

v2 adds collection with provenance, probabilistic entity resolution, a temporal
entity graph, gallery-restricted biometrics, a reasoning layer, an investigation
console, and a bounded agent. v1 stays as it is. Nothing here replaces the case
tiers, the scope gate, the audit log, or the live map.

## Layers

| Layer | Where | Language | State |
|---|---|---|---|
| Scope context and prohibitions | `packages/scope/src/context.ts`, `prohibitions.ts` | TS | Phase 2 |
| Observations, collectors, temporal predicate | `packages/fusion` | TS | Built |
| Schema | `packages/db/prisma/schema.prisma` (v2 section) | Prisma | Phase 2 |
| Collection routes and collectors | `apps/api/src/routes/v2.ts`, `apps/api/src/v2/` | TS | Built: ADS-B, SEC EDGAR |
| Resolution | `services/resolution`, `apps/api/src/v2/resolution.ts` | Python + TS | Built: PERSON, VESSEL, AIRCRAFT, ORG |
| Recognition | `services/recognition` | Python | Phase 10, flag off |
| Reasoning seam | `packages/reason` | TS | Phase 8 |
| Console | `apps/web/src/components/Investigation.tsx` | TS | Stage 6 |
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

## Derived edges

Three rules, in `apps/api/src/v2/links.ts`, each writing the observations that
evidence it onto the edge:

| Basis | Relation | Confidence |
|---|---|---|
| `shared:DEVICE_ID` | SAME_DEVICE | 9000 bp |
| `shared:EMAIL` / `PHONE` / `HANDLE` / `ADDRESS` | ASSOCIATED_WITH | 8000 / 7500 / 7000 / 5500 bp |
| `co-location:<radius>m/<window>min` | CO_LOCATED, one edge per merged window | 6000–9000 bp by closest approach |

A value shared by more than twenty entities is a switchboard, not a link, and
is skipped and counted. OWNS, OPERATES, MEMBER_OF, TRANSACTED_WITH and
COMMUNICATED_WITH wait for a source that asserts them; nothing infers them.

Re-running keeps edges whose fingerprint (ends, relation, basis, window,
evidence) is unchanged and supersedes the rest. Nothing is deleted, so the
graph as it was known at an earlier moment still reads back.

## Graph operations

`apps/api/src/v2/graph.ts`, all taking a scope context and `asOf`:
neighbors (≤3 hops), path-between (≤6 hops), timeline-for-entity,
co-location-window, edges. Each hop checks the boundary on its own; an
entity reachable in the graph is not automatically readable. Every read
writes an AccessLog row with the ids returned and the query text.

The consistency job: `pnpm graph:check` (exits non-zero when the graph
disagrees with itself) and `POST /v2/graph/consistency` scoped to one
authorization.

## Two clocks

Every edge and membership has valid time (`validFrom`, `validUntil`) and
knowledge time (`createdAt`, `supersededAt`). Every graph read takes both:

| Parameter | Question | Default |
|---|---|---|
| `asOf` | What held at this instant? | now |
| `knownAs` | What had Scout learned by this instant? | now |

`asOf` alone asks "given everything known today, what held then", which is
what the console's scrubber asks. `asOf` and `knownAs` set to the same
instant ask "exactly as it was known then", which is what an audit asks. A
co-location learned after it ended is visible at the moment it happened
under the first reading and at no moment under the second, and both answers
are right. `packages/fusion/src/temporal.ts` holds the predicate in one place,
as a function and as SQL.

## Console

The investigation console is a tool on the map's rail, next to the case
file, in the same panel chrome. It is read-only by construction: the
component imports `v2.entities`, `v2.observations`, `v2.edges`,
`v2.neighbors` and `v2.timeline` and nothing that writes. Every one of those
reads is written to `AccessLog` by the route, and the panel's last line says
so.

What it shows, for one case at one moment:

- **The scrubber** sets `asOf`, the valid-time clock. Observations are loaded
  once (up to 2 000), so the map, the entity list and the entity view answer
  a scrub on the client; the graph reads (links, timeline) follow 200 ms
  later from the server, where the two-clock predicate lives. "Only what was
  known then" pins `knownAs` to the same instant, the audit reading; an
  entity that wasn't known yet comes back 404 and is shown as "Not known at
  T", which is an answer.
- **Coverage bands**, one per source consulted under the authorization,
  bucketed across the range. A gap is a gap in the source. Buckets after
  `asOf` are greyed.
- **The map** draws every positioned observation seen by `asOf`, coloured by
  the kind of the entity it resolved into (grey when unresolved), one trace
  per entity through its positions in time order, and the edges that held at
  `asOf` as dashed lines between the entities' last positions. An edge whose
  end has no position is in the panel and not on the map.
- **The entity view**: position by then, links with confidence and the
  basis that produced it (never the number alone), identifiers among the
  observations seen by then, members with the ones observed later dimmed,
  the timeline, and **sources consulted**: every source under the
  authorization, with "Nothing" printed for the ones that had nothing on
  this entity.

Flying the camera to an entity offsets the target into the strip of map the
panel leaves visible (`besidePanel()`), since the panel is `min(62vw,
980px)` wide and a target at the centre would land under it.

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
