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
   counted. Flint is the seam if/when an AI layer is added.

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

## Phase 5 — Exposure + people (scoped tier) ← next

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

**Entry gate:** Phase 4 exit + audit log proven in Phase 1. ✅
**Exit gate:** each scoped adapter refuses out-of-scope input at the adapter
level (not just the route), writes an audit row on every attempt, and requires
an in-scope match + confirmation to execute. Red-team test: no path executes a
scoped source for an out-of-scope subject.

**Kill criterion for the tier:** if per-case scope + audit can't be made
airtight, these adapters do not ship. The gate is the product; a leaky gate is
worse than no scoped tier.

---

## Phase 6 — Correlation + entity graph

Scout stops being a launcher and becomes an investigation tool: findings across
sources get resolved into entities and linked.

**Build:**
- Entity resolution: dedupe subjects/findings across sources (same domain,
  same email, same org from IntelX + OpenCorporates + crt.sh).
- Relationship edges with provenance (entity A appears in finding X from source
  S). Every edge traceable to a source.
- Case graph view in the web app.
- Optional Flint-mediated summarization: draft a case summary from findings.
  Model tiering — Haiku for mechanical dedupe/labeling, Sonnet for structural
  summary. Prompt caching on. Summaries are drafts, never findings, and never
  invent provenance.

**Entry gate:** Phases 3–5 producing normalized, provenance-carrying findings.
**Exit gate:** a case with hits from 3+ sources renders a deduped entity graph
with traceable edges.

**Defer criterion:** do NOT build correlation until you have real cases where
multiple sources overlap on the same entities. Building the graph against
single-source cases is premature — it needs real multi-source data to be worth
anything. Gate this phase on actual case volume, not calendar.

---

## Phase 7 — Reporting + export

Turn a case into a deliverable.

**Build:**
- Case report generation — styled export (docx/pdf) with findings grouped by
  tier, every finding showing source + timestamp + query provenance.
- Investigation timeline from `QueryLog` + `Finding` timestamps.
- Audit export: the full scoped-query log for a case, for engagement records.
- Redaction pass before export (strip anything outside scope that leaked into
  notes).

**Entry gate:** Phase 6 exit (or Phase 5 exit if correlation deferred).
**Exit gate:** one command/button produces a client-ready case report with
complete provenance and an attached audit trail.

---

## Phase 8 — Hardening + deploy

Production posture. Deferred deliberately to last per the performance-gate
philosophy — you don't pay for observability/queue/auth complexity until the
tool is doing real work that earns it.

**Build:**
- Auth + multi-operator (per-operator audit attribution). The `operator` column
  is already on every audit row, so this is a fill-in, not a backfill.
- Railway deploy: API + web + Postgres, env-scoped secrets.
- Rate limiting + Redis cache promoted from in-memory (only if Phase 3/5 traffic
  justified it).
- Retention + soft-delete policy on case data (the Phase 1 defer). Must archive
  rather than erase — the audit trigger blocks deletion by design.
- Observability: structured logs on scoped-query denials + upstream failures.
  Metrics/tracing only if traffic warrants.
- Secrets handling review — no key ever logged, no subject term in a URL param.
  Partly done: `redactSecrets()` scrubs configured keys out of audit rows, and
  request bodies are stripped from logs.

**Entry gate:** Phases 1–7 (or the shipped subset) stable in local/staging.
**Exit gate:** deployed, authed, scoped-query audit intact in production,
secrets clean, rollback documented.

---

## Sequencing summary

```
0  Foundation                ✅ shipped
1  Persistence + cases       ✅ shipped
2  Web dashboard             ✅ shipped
3  Infra adapters            ✅ shipped
4  Dataset adapters          ✅ shipped
5  Exposure + people         ← next (scoped; hard gate + audit)
6  Correlation + graph       (defer until real multi-source case volume)
7  Reporting + export
8  Hardening + deploy        (defer infra cost until earned)
```

Critical path to a genuinely useful internal tool is **1 → 2 → 3**: cases,
a dashboard, and the infrastructure tier. That's a working OSINT workstation.
Everything after is depth. The scoped tier (5) is gated on the audit layer (1)
being airtight — that ordering is not negotiable.
