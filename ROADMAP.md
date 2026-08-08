# Scout — Build Roadmap

Tiered OSINT investigation platform. Datasets + infrastructure recon at the
core, dark-web search as fallback, every person-facing lookup behind a hard
scope gate.

This roadmap is the locked build order. Phases ship in sequence; each has an
entry gate (what must be true to start) and an exit gate (what must be true to
call it done). Defer criteria mark work that must NOT be built until a specific
condition earns it — the 24-month performance-gate philosophy applied to
features, not just infra.

---

## Locked invariants (non-negotiable across every phase)

1. **Scope gate is absolute.** No `requiresScope` source ever executes for an
   input outside the configured authorization scope. Scope is set at config /
   case creation time — never widenable by a request parameter. Empty scope
   means scoped tiers are OFF, not open.
   *Refined in Phase 4:* the gate is decided **per subject kind**, not per
   source, because a source can be person-facing for some of its inputs and
   not others. `requiresScopeFor(source, kind)` is the single answer every
   layer reads. Any `api` source accepting a person-identifying kind (`email`,
   `username`, `person`) must be gated for it — wholesale via `requiresScope`
   or per kind via `scopedKinds` — or sit on a pinned reviewed list, which
   currently holds only `opensanctions`. See `apps/api/src/invariants.test.ts`
   for the reasoning.
2. **No blind fan-out.** `/query` plans; it does not auto-execute a subject
   across every source. Non-scoped infra/dataset sources may be batch-executed
   on explicit action. Person-facing (scoped) sources are always one confirmed
   action at a time. There is never a single box that takes a name and returns
   an assembled dossier.
3. **Every scoped query is logged.** Who ran it, what term, when, against which
   source, under which case + authorization reference. Immutable audit rows.
   This is the accountability layer that makes the tool defensible.
4. **Deeplink sources never transmit subject data through Scout.** A deeplink is
   a URL the investigator opens; the subject term never touches a Scout-owned
   network call for those sources.
   *Clarified in Phase 3:* `mode` is the authority on where a request
   originates. A source whose only integration is a link is `deeplink` and
   carries this guarantee; a source Scout can fetch is `api` and does not,
   whatever links it also offers. Changing a source from `deeplink` to `api` is
   therefore the visible act of giving up this guarantee for it, and a test
   asserts no `deeplink` source has an execution route.
5. **Provenance on every finding.** Each stored result carries its source, the
   query that produced it, the case, and a timestamp. No orphan findings.
6. **Sources are inert without keys, never guessed.** A source with no key
   reports `inert`. Scout never fabricates or infers a result.
7. **Standard stack conventions.** TypeScript, pnpm/Turborepo, Fastify, Prisma,
   Postgres, Railway. Zod at every boundary. BigInt/integer for anything
   counted.

---

## Phase 0 — Foundation ✅ SHIPPED

- Turborepo monorepo, workspace + turbo + shared tsconfig.
- `@scout/sources` — tiered registry (19 sources, 6 tiers), typed with
  `mode` (deeplink | api) and `requiresScope`.
- `@scout/scope` — the gate: config-time scope, 403-with-reason on deny,
  empty = off.
- `@scout/api` — Fastify with `/health`, `/sources`, `/query` (plan-only),
  `/exposure/hibp` (worked scope-gated adapter).
- `.env.example`, bootstrap script, README.

**Exit gate:** ✅ builds clean, scope tests green, out-of-scope HIBP returns 403.

---

## Phase 1 — Persistence + cases ✅ SHIPPED

The tool became stateful. An investigation is a **case** — a container that
owns its scope, its subject(s), its findings, and its audit log. Scope moved
from global env to per-case, which is the correct model: authorization is
per-engagement, not per-instance.

**Built:**
- Prisma + Postgres. Models: `Case`, `ScopeEntry`, `Subject`, `Finding`,
  `QueryLog`, `CaseSource` (per-case enable flags), `AuditEvent`.
- `authorizationRef` required on every case at creation.
- Scope gate refactored to load a case's `ScopeEntry[]`. Env scope remains as a
  planning-only fallback for keyless local use — it cannot authorize an
  execution, because an execution must land in the audit log against a case.
- `QueryLog` write on every planned + executed scoped query, success or deny.
- Audit immutability enforced by a database trigger, not convention.
- `AuditEvent` for scope changes — changing scope is an authorization decision.
- Migrations + seed script committed.

**Exit gate:** ✅ case created with scope + auth ref; scoped query denied
without a case; every scoped attempt writes an immutable audit row; `checkScope`
reads case scope. Red-team block passes: scope-shaped request fields are
ignored, lookalike domains refused, empty scope treated as off.

**Deferred as planned:** no soft-delete / retention policy — Phase 8. Note the
consequence: cases with audit rows currently cannot be hard-deleted.

---

## Phase 2 — Web dashboard ✅ SHIPPED

The investigator-facing surface. Next.js app rendering the registry by tier and
driving the query planner. This is where the "launcher, not aggregator" design
became visible in the UX.

**Built:**
- `apps/web` — Next.js, reads `/sources`, renders tiers in reach-for order
  (datasets → infra → exposure → people → onion → utils).
- Case workspace: create/select a case, view its scope + auth ref, subject list.
- Query planner UI: enter term + kind → render the plan. Deeplink sources are
  one-click-open buttons; `api` sources show ready/inert; scoped-blocked sources
  show the deny reason inline.
- Findings board per case — manual "save finding" from any result, with
  provenance auto-attached.
- Scope editor: add/remove scope entries on a case (gated behind an explicit
  "I am authorized" confirmation that writes to the audit log).

Also built, ahead of its Phase 5 slot because it is the only safe way to expose
a Run button at all: the scoped-execution confirmation, naming the subject, the
source, the matched scope entry and the authorization reference.

The UI enforces nothing on its own — the API owns the gate and the audit log,
so there is no second enforcement point to drift. What the dashboard does is
make the posture legible: blocked sources have no Run control rather than a
disabled one, and there is no batch-run affordance anywhere.

**Entry gate:** Phase 1 exit. ✅
**Exit gate:** ✅ full loop verified in a real browser (Playwright, 23 checks):
create case, set scope, plan a query, deeplinks resolve to real anchors, save a
finding, see it on the board with provenance, scoped sources visibly blocked
out of scope with no run control, denial recorded in the audit trail.

**Deferred as planned:** no multi-user / collaboration. Single operator until
Phase 8 auth.

---

## Phase 3 — Infrastructure adapters (highest-value tier) ✅ SHIPPED

The infra tier — the part of OSINT that does the most work and needs no scope
gate (it's infrastructure, not PII).

**Built (adapters under `apps/api/src/adapters/infra/`):**
- Shodan, Censys, SecurityTrails — `api`, key-gated.
- crt.sh — moved from `deeplink` to `api` (free and keyless) with its
  convenience link retained. See the note below on why the mode had to change.
- Normalized `SubdomainObservation` / `HostObservation` / `CertObservation`
  types in `@scout/sources`, plus `mergeObservations()` — dedupe that unions
  attribution rather than picking a winner, so a hostname seen by three sources
  credits all three.
- Per-source token-bucket rate limiting + a 300s in-memory TTL cache. Adapters
  degrade to `inert` or a reported error, never throwing the request.
- `POST /infra/sweep` — the batch path invariant 2 permits for non-scoped
  sources, and the only one. It draws solely from the infra adapter registry,
  and `executeUnscopedSource()` throws outright if handed a `requiresScope`
  source, so the sweep cannot become a person-facing fan-out.
- Infrastructure board in the dashboard: one merged view with per-source
  attribution, kind filters, and save-to-findings.

**A note on crt.sh and locked invariant 4.** Giving crt.sh a Scout-side fetch is
incompatible with calling it a deeplink source, so its `mode` changed to `api`
rather than quietly eroding the invariant. Invariant 4 now holds exactly as
written for every `mode: "deeplink"` source, and a test asserts no deeplink
source has an execution route. crt.sh only accepts `domain` subjects, so no
personal identifier is transmitted.

**Entry gate:** Phase 2 exit. ✅
**Exit gate:** ✅ a domain subject produces normalized subdomain/host/cert
findings from crt.sh + Shodan + SecurityTrails (+ Censys), deduped with unioned
attribution and saved with provenance. Verified in a browser: 15 raw
observations merged to 10 across four sources, with a keyless source correctly
reporting `inert` rather than guessing.

**Deferred as planned:** Redis-backed cache and a job queue. In-memory is
correct until a single case regularly issues enough infra calls to hit real
rate limits. ViewDNS also stays a deeplink — its API needs a paid key, and the
link is the honest integration until someone has one.

---

## Phase 4 — Dataset adapters ✅ SHIPPED

Deepened the datasets tier beyond deeplinks where a real API exists.

**Built:**
- Intelligence X — `api`, key-gated, normalized into `DatasetHit`.
- OpenSanctions — `api`, sanctions/PEP/watchlist matching with the designating
  datasets carried through as the finding, not as metadata about it.
- Aleph / ICIJ / OpenCorporates / Wikidata stay deeplinks, as planned.
- Entity extraction: candidate entities become `Subject` **suggestions**, never
  auto-links. Structured provider fields are high confidence, free-text pattern
  matches medium. It is a pattern matcher rather than entity recognition —
  guessing that a capitalized phrase is a person's name is the fabrication
  locked invariant 6 rules out.
- Datasets board in the dashboard, with a designated entity rendered
  unmissably and a PEP listing deliberately not.

**Decision this phase made — per-subject-kind scoping.** Intelligence X accepts
an email selector, which is a person-facing lookup sitting in a non-scoped
tier. Gating the whole source would have blocked legitimate domain research;
gating none of it would have left a person lookup ungated. So the gate is now
decided per subject kind via `requiresScopeFor(source, kind)`: IntelX runs free
for a domain and gated for an email. Every layer reads that one function —
planner, dispatcher, adapter, and the audit row's `requiresScope` column, which
now records the gate that actually applied rather than the source's blanket
flag.

Sources run one at a time through `executeSource()`, which picks the runner
from the effective gate so no route can choose wrong. A `/datasets/sweep` was
added alongside it, sharing one implementation with the infra sweep that
filters on the same per-kind gate and **reports what it excluded** — a sweep
that silently omitted a gated source would read as "covered everything", and an
absence would be mistaken for a clean negative.

**Five listings, five different claims.** Sanctions data flattens badly, and
flattening it makes false accusations about real people. `sanctioned` is true
only when the entity itself is designated; `linked-to-sanctioned` (associated
with a designated party), `debarred` (procurement exclusion) and `pep` (holds
public office) are surfaced as the distinct claims they are. The trap is
`sanction.linked`, which reads like a sanction topic — treating it as one
designates someone who has not been designated. Unrecognized topics fall
through to `listed` rather than having severity guessed from an unfamiliar
string. Absence of a match is never rendered as "clear".

**Entry gate:** Phase 3 exit. ✅
**Exit gate:** ✅ a person subject returns normalized hits from IntelX +
OpenSanctions with dataset provenance; the sanctioned match raises an alert
that cannot be scrolled past while a PEP in the same result set does not.
Verified in a browser (19 checks), including that the gate flips on subject
kind for one source and that suggestions are not auto-linked.

---

## Phase 5 — Exposure + people (scoped tier) ✅ SHIPPED

The scope-gated adapters. This phase is where the audit log, per-case scope, and
`enforceScope()` template earn their existence. Gate hard; every adapter calls
`enforceScope()` before its network call — no exceptions.

The template already exists: `apps/api/src/adapters/base.ts`
(`executeScopedSource`). Each new scoped adapter is a `run` function passed to
it, and inherits the gate, the audit rows, and the inert/error degradation.

**Build:**
- DeHashed — `api`, `requiresScope`. Record-puller; only runs inside case scope,
  every call logged with auth ref.
- Hunter.io — `api`, `requiresScope`. Email pattern/verification for scoped
  domains only.
- WhatsMyName — `api`, `requiresScope`. Username enumeration, scoped to
  authorized targets.
- HIBP already wired and already on per-case scope (Phase 1).
- Confirmation step in the UI for every scoped execution: shows the subject,
  the source, the matched scope entry, and the auth ref before it runs. The API
  already requires `confirm: true`.

**Also decided this phase:**

- **One handler, one gate.** All four scoped sources went behind a single route
  handler and a single registry. HIBP's bespoke Phase 0 route was folded in.
  Four bespoke routes would have been four chances to apply the gate slightly
  differently, and the one that drifts is the one that leaks.
- **Credential material is redacted by default.** DeHashed returns passwords;
  Scout reports that one exists and drops the value. A case database should not
  become a credential store. `SCOUT_ALLOW_CREDENTIAL_MATERIAL=true` opts in for
  engagements that genuinely need it, and the response says which mode produced
  it so a redacted result is never read as an empty one.
- **WhatsMyName is off until switched on.** It has no hosted API, so Scout
  enumerates from the project's public site list itself — dozens of outbound
  requests about one named person. Capped, bounded-concurrency, and inert until
  `WHATSMYNAME_ENABLED=true`. Detection requires the expected status *and* the
  expected marker string, because a false positive here asserts that a named
  person holds an account they may not.

**Entry gate:** Phase 4 exit + audit log proven in Phase 1. ✅
**Exit gate:** ✅ each scoped adapter refuses out-of-scope input at the adapter
level, writes an audit row on every attempt, and requires an in-scope match +
confirmation to execute.

The red team is the real gate, and it is exhaustive: every scoped route × every
out-of-scope shape (lookalike domains, `@`-smuggling, another case's scope,
empty scope, no case, no confirmation, scope-shaped fields smuggled into the
body), plus every attempt to reach a scoped source through the infra route, the
dataset route, the infra sweep and the dataset sweep. Each asserts not just the
status code but that **the upstream stub was never called** — a test that only
checked the response could pass while the request still went out.

**Kill criterion for the tier:** if per-case scope + audit can't be made
airtight, these adapters do not ship. The gate is the product; a leaky gate is
worse than no scoped tier. It held.

---

## Phase 6 — Correlation + entity graph ✅ SHIPPED (criterion overridden)

Scout stops being a launcher and becomes an investigation tool: findings across
sources get resolved into entities and linked.

**Build:**
- Entity resolution: dedupe subjects/findings across sources (same domain,
  same email, same org from IntelX + OpenCorporates + crt.sh).
- Relationship edges with provenance (entity A appears in finding X from source
  S). Every edge traceable to a source.
- Case graph view in the web app.
- Optional summarization: draft a case summary from findings. Summaries are
  drafts, never findings, and never invent provenance.

**Entry gate:** Phases 3–5 producing normalized, provenance-carrying findings. ✅
**Exit gate:** ✅ verified on a case with 9 findings from 8 sources: 11 entities,
11 links, 5 corroborated. `www.example.com` folded from two spellings across
four sources into one node; the `resolves-to` edge to `203.0.113.10` carries two
findings. Every edge cites findings that exist on the case, asserted by test.
Three company near-matches surfaced as suggestions and stayed unmerged until
confirmed.

**Defer criterion:** do NOT build correlation until you have real cases where
multiple sources overlap on the same entities. Building the graph against
single-source cases is premature — it needs real multi-source data to be worth
anything. Gate this phase on actual case volume, not calendar.

**Status: still not met. Built anyway, on an explicit instruction to proceed.**

There is no real multi-source case volume; only demo and test cases. The
criterion was overridden deliberately, so the constraint it protects against
did not disappear — it shaped the design instead:

- **Automatic merging is exact-identity only**, after normalization. Two
  sources reporting the same normalized hostname are reporting the same host,
  and no calibration is needed to be sure of it.
- **Everything requiring judgement is a suggestion**, surfaced as a queue of
  questions and merged only when an operator confirms with a written reason.
  Suggestions cover identical-after-normalization names and strict token
  subsets. No edit distance, no phonetics, no nicknames — those are exactly the
  heuristics the missing data would have calibrated, and an uncalibrated one
  produces confident nonsense about real people.
- **The graph is never stored**, only recomputed from findings. Decisions
  persist; the derived graph does not, so it cannot drift from its evidence.

If the criterion is met later, the place to revisit is `suggestMerges()` — it
is deliberately timid and real overlapping cases would justify loosening it.

**Built:**
- `@scout/graph` — a pure package: extraction from every tier's normalized
  observations, exact-identity resolution with unioned attribution, the
  suggestion engine, and summarization.
- Entities and links persisted as *decisions* only (`EntityMerge`,
  `MergeDismissal`). Merges are audited: asserting two records describe one
  person is a judgement about a person.
- Case graph view in the dashboard — deterministic column layout rather than a
  force simulation, because the same case must draw the same picture every
  time. Selecting a node answers "how do you know that".
- Summarization: a deterministic counter, which is the default because every
  sentence it writes is a fact about rows that exist. A `Summarizer` extension
  point exists for swapping in a different implementation later; none ships.
  Summaries are drafts, stored apart from findings, and
  `assertNoInventedProvenance()` throws if one cites a finding that does not
  exist — that guard is the point, since "never invent provenance" is otherwise
  a promise nothing enforces.

---

## Phase 7 — Reporting + export ✅ SHIPPED

Turn a case into a deliverable.

**Built:**
- `GET /cases/:id/report` in three formats — self-contained print-ready HTML,
  a real `.docx` for a client to annotate, and JSON. All three consume the same
  already-redacted `CaseReport`, so a renderer cannot forget to redact.
- Findings grouped by tier in reach-for order, each carrying source, query term,
  query kind, observation time and whether it traces to a logged call.
- Investigation timeline merged from `QueryLog` and `Finding` timestamps.
- Audit export as CSV, separate from the report — retention rules for a query
  log and for an investigative deliverable are rarely the same.
- Redaction pass in `@scout/scope`, reusing the same `checkScope` the gate uses.

**Redaction is the other half of the gate.** The gate governs what Scout
fetches; this governs what Scout emits. Two boundaries drawn deliberately:

- The **audit trail is never redacted**. A refused lookup's row must still name
  what was refused — that record is the evidence the gate held, and scrubbing
  it would destroy the thing the log exists for.
- It is **not a general PII scrubber**. It removes identifiers it can
  positively recognize; prose can hide anything. The report states how many it
  removed (kinds and fields only) so a reviewer knows redaction ran rather than
  assuming it did.

Every export writes an audit event: a case should show that its contents left
the tool, and when.

**Entry gate:** Phase 5 exit, correlation deferred. ✅
**Exit gate:** ✅ one button produces a client-ready report with complete
provenance and the audit trail attached. Verified on a real case: notes and
summaries scrubbed of out-of-scope addresses, the refused lookup still named in
the audit table, and the `.docx` confirmed to contain neither redacted value.

---

## Phase 8 — Hardening ✅ SHIPPED · deploy not built

Production posture. Deferred deliberately to last per the performance-gate
philosophy — you don't pay for observability/queue/auth complexity until the
tool is doing real work that earns it.

**Built:**
- **Auth + per-operator attribution.** Bearer tokens, SHA-256 digests, an
  `Operator` model and a `pnpm db:operator` CLI. Required by default in
  production rather than opt-in: an audit log whose every row says `local`
  cannot answer the question it exists to answer. The `operator` column was
  already on every audit row, so this was the fill-in it was designed to be.
- **Retention.** The Phase 1 defer, and its shape was forced by the Phase 1
  decision that made it a defer. Audit rows are immutable, so a case cannot be
  deleted — which turns out to be the correct model. `archive` hides a finished
  case, reversibly. `purge` deletes findings and subjects irreversibly, requires
  a written reason, and keeps the case shell, its scope and every audit row. A
  purge reports what it retained so nobody assumes it erased the trail.
- **Observability.** Structured events with a stable `event` field —
  `scope.denied`, `upstream.failed`, `source.inert`, `sweep.excluded`,
  `case.exported`, `case.purged`, `auth.rejected` — routed through one helper,
  which is also the one place to check that no subject term or key is in the
  fields.
- **Secrets review, written as executable checks** rather than a paragraph
  claiming it was done. Tests read the source tree and fail if any log line
  mentions a key env or a built upstream URL (Hunter and Shodan carry the key
  in the query string), or if any route path takes a subject term.

**Deliberately not built:**
- **Railway deploy.** Requested scope was hardening only.
- **Redis + a job queue.** The Phase 3 defer criterion — "until a single case
  regularly issues enough infra calls to hit rate limits" — is still unmet.
  In-memory caching and per-source token buckets remain correct.
- **Metrics and tracing.** The roadmap gates these on traffic warranting them.
  It does not yet.

**Entry gate:** Phases 1–7 (the shipped subset) stable locally. ✅
**Exit gate (hardening portion):** ✅ authed with per-operator attribution
verified end to end in a browser, scoped-query audit intact across archive and
purge, secrets review passing as tests.

---

## Sequencing summary

```
0  Foundation                ✅ shipped
1  Persistence + cases       ✅ shipped
2  Web dashboard             ✅ shipped
3  Infra adapters            ✅ shipped
4  Dataset adapters          ✅ shipped
5  Exposure + people         ✅ shipped
6  Correlation + graph       ✅ shipped (defer criterion overridden on request)
7  Reporting + export        ✅ shipped
8  Hardening                 ✅ shipped
   Deploy                    not built (hardening-only scope)
   Redis / queue / metrics   deferred — criteria still unmet
```

Critical path to a genuinely useful internal tool is **1 → 2 → 3**: cases,
a dashboard, and the infrastructure tier. That's a working OSINT workstation.
Everything after is depth. The scoped tier (5) is gated on the audit layer (1)
being airtight — that ordering is not negotiable.
