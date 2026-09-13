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
| Collection routes and collectors | `apps/api/src/routes/v2.ts`, `apps/api/src/v2/collectors/` | TS | Built: ADS-B, AIS, SEC EDGAR, open web, first-party telemetry, Sentinel-2, Planet and Maxar catalogues, broker interface |
| Resolution | `services/resolution`, `apps/api/src/v2/resolution.ts` | Python + TS | Built: PERSON, VESSEL, AIRCRAFT, ORG |
| Recognition | `services/recognition`, `apps/api/src/v2/recognition.ts` | Python + TS | Stage 10, flag off by default |
| Reasoning | `packages/reason`, `apps/api/src/v2/reason.ts` | TS | Stage 8 |
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

## Review queue

The queue is a tab in the case file (`apps/web/src/components/ReviewQueue.tsx`),
beside Graph, because it is about one case and it writes. `GET /v2/review`
lists the pairs the latest completed run per kind scored inside the review
band, minus the ones with an adjudication, and per kind says how many
adjudications have been recorded since that run started
(`adjudicatedSinceRun`). Each pair carries the model's own evidence: the
comparison level per column and the Bayes factor it contributed, shown
largest movement first, in numbers next to words.

An adjudication needs a note and is written once (`POST /v2/adjudicate`,
audited as `v2.adjudicated`, immutable). It changes nothing by itself. The
panel counts the pins waiting and offers the run that applies them
(`POST /v2/resolve` for that kind); the run supersedes memberships rather
than deleting them, so the history of a pair is the sequence of
`MatchDecision` rows across runs plus the adjudication that pinned it. An
authorization without `RESOLVE` can read the queue and not record on it.

## Reasoning

`packages/reason` answers a plain-language question from the graph and
nothing else. Four parts, in order:

1. **Plan.** A `QueryPlan` is a typed list of at most six steps, each one
   of `find-entity`, `neighbors-of`, `path-between`, `co-location-window`,
   `timeline-for-entity`, `sources-consulted`, with parameters. There is no
   step that takes query text. `validatePlan` checks the schema, that every
   `{ref}` points at an earlier find, hop caps (3 for neighbours, 6 for a
   path), and a cost budget of 12 (neighbours cost 1+hops, a path costs
   maxHops, a window 2, the rest 1).
2. **Planner.** Rules first: a handful of question shapes ("who is connected
   to X", "path between X and Y", "who was near X on 2026-08-16", "timeline
   of X", "what do we know about X", "which sources were consulted") become
   plans with no model in the loop. Anything else goes to the planner model
   if `REASON_PROVIDER` names one; its reply must validate as a plan or the
   question is refused with `invalid-plan`. With no model, the refusal
   names the shapes Scout can answer.
3. **Execute.** The host (`apps/api/src/v2/reason.ts`) supplies the
   operations, which are the same functions the graph routes run, with the
   same per-hop scope checks. The executor refuses before running anything
   when `READ_GRAPH` is missing or the plan is over budget, re-checks every
   returned entity's kind against the authorization, and refuses a find
   that matched nothing with what would be needed: `Collection on "X"
   under an authorization that covers it`. It collects every observation
   id any step produced; that set is what an answer may cite.
4. **Synthesise.** The rules write one claim per fact with its observation
   ids. A synthesis model, when configured, rewrites the claims and can
   only cite from the evidence set: `enforceCitations` drops citations the
   graph never produced and claims left with none. No claim left means the
   answer is `insufficient-evidence`, with the subject and the
   authorization named, rather than prose. A claim about which sources
   returned nothing cites the collection log (source ids) rather than
   observations, because there is no observation to cite for an absence.

The model seam (`packages/reason/src/model.ts`) is Scout's own: plain HTTPS
to Anthropic, an OpenAI-compatible endpoint, or Ollama, selected by
`REASON_PROVIDER`; no vendor SDK is installed. The model's output is
parsed and validated, never executed.

`POST /v2/ask {caseId, question}` runs the four steps and writes one
`AccessLog` row with the question and the cited observation ids. The console
has the Ask box under the coverage bands; citations are buttons that select
the entity holding the observation.

## Imagery

`apps/api/src/v2/collectors/imagery.ts` is the pipeline every satellite
connector shares: a box (at most half a degree a side), a window, a cloud
limit, and `storeScene()`. The index (`ImageryTile`, one row per source ×
scene × box, with a PostGIS polygon) is checked first, then the bucket by
HEAD, and only a scene missing from both is rendered and written: the
GeoTIFF as the provider returned it and a PNG preview beside it. The
observation the collector writes is the scene over the box (where, when,
cloud cover, which tile) so it sits in the same graph as everything else.

`GET /v2/imagery/tiles` lists a case's tiles (scope-checked, logged);
`GET /v2/imagery/preview/:tileId` serves the stored PNG from the bucket
after the same check. The console loads the previews as object URLs and
draws them as image sources under the observation layer, filtered by the
scrubber's `asOf` like everything else on the map.

Object storage is reached through `storage.ts`, a hand-signed SigV4 client
for PUT, GET and HEAD: MinIO locally, any S3-compatible store in production,
selected by `S3_ENDPOINT`.

## Recognition

Off unless `RECOGNITION_ENABLED=true`, and gallery-restricted by
construction: both service routes (`/embed`, `/compare`) require a gallery
id in their schema, and the API's one comparison route requires one too.
There is no probe-only path.

The service (`services/recognition`) is stateless: media in, a unit vector
out (ArcFace via InsightFace for faces, ECAPA-TDNN via SpeechBrain for
voices, installed only with `uv sync --extra models`; without them a
request is answered 503, never with an invented vector), and cosine
ranking of a probe against the candidates it is handed, in integer basis
points. MATCH needs the best candidate inside the threshold *and* clear of
the runner-up by the margin; a close call is INDETERMINATE; no candidates
is INDETERMINATE.

The API is the custodian (`apps/api/src/v2/recognition.ts`). A gallery
carries a lawful basis, its document reference and a review date, and is
created only with `confirmLawfulBasis: true`. An enrollment names its
media's origin and document reference; scraped or open-web origins are
refused by the scope package's guard, audited. The media is embedded and
discarded; the template is sealed with AES-256-GCM under
`RECOGNITION_TEMPLATE_KEY` into `BiometricTemplate`, and the audit event
keeps the media's hash. A comparison passes the three-part gate (a gallery,
a lawful basis on record, an authorization permitting
`BIOMETRIC_COMPARE`), is refused while the gallery's review is overdue,
decrypts only the active (unrevoked, unexpired) templates of the modality
for that one call, and is written to `BiometricComparison` (immutable)
before the answer returns, matched or not.

A voice probe with several speakers (`diarize: true`) is split first
(pyannote.audio's speaker-diarization pipeline, gated: `models` extra plus
`RECOGNITION_HF_TOKEN`; the deterministic test path splits on `|`), and
each speaker's audio is embedded and compared on its own: one
`BiometricComparison` row and one audit event per speaker, each with its
own probe hash. The response carries `speakers[]`; the top-level decision
follows the speaker whose best candidate is nearest and says so. Nothing
is averaged across speakers. Diarisation on a face probe is a 400.

The case file's Recognition tab (`RecognitionPanel.tsx`) is the custodian's
screen: galleries (created with the lawful-basis confirmation, document and
review date), enrollments (entity from the case, media origin limited to
consented, court-ordered or employment-record, document, expiry; revoke
with a recorded reason), a comparison form, the result with its candidates
and distances, and the permanent comparison log. Media is read in the
browser and sent once. With the flag off the tab shows why enrollment and
comparison are refused; galleries can still be prepared.

## Tests (Phase 11)

| Requirement | Where |
|---|---|
| Unit: normalisers, blocking, scoring, thresholds, temporal windows | `services/resolution/tests`, `packages/fusion`, `packages/scope`, `packages/db` |
| Resolution accuracy with a regression gate | `services/resolution/eval/evaluate.py` (`--check` against `baseline.json`) |
| Authorization matrix: every case-taking route × missing / not started / expired / revoked / other subject / action class | `apps/api/src/v2-authz.test.ts` |
| The five prohibitions, attempted, with audit events | `apps/api/src/v2-prohibitions.test.ts` |
| Temporal: edges with windows read at several `asOf` values | `apps/api/src/v2.test.ts` (links and the temporal graph) |
| Reversibility: pin, re-run, memberships superseded, history intact | `apps/api/src/v2.test.ts` (resolution) |
| Recognition gates, arithmetic, diarisation | `services/recognition/tests`, `apps/api/src/v2.test.ts` (stage 10) |
| Console E2E (Playwright): load, scrub, open an entity, adjudicate, confirm the audit trail | `apps/web/e2e/console.spec.ts` (`pnpm --filter @scout/web run test:e2e` against a running app with the synthetic case seeded) |
| Load: 1M observations, 100k entities | not yet built |

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
