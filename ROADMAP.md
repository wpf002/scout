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

## Phase 3 — Infrastructure adapters (highest-value tier) ← next

Wire the infra tier — the part of OSINT that does the most work and needs no
scope gate (it's infrastructure, not PII).

**Build (each as an adapter under `apps/api/src/adapters/`):**
- Shodan, Censys, SecurityTrails — `api`, key-gated.
- crt.sh, ViewDNS — already deeplink; add optional API/scrape normalization so
  their output lands in the common result shape.
- Common `HostResult` / `CertResult` / `SubdomainResult` normalized types in
  `@scout/sources` so every infra source feeds one board.
- Per-source rate limiting + short-TTL response cache (in-memory now; Redis
  deferred). Adapters degrade to `inert`, never throw the request.

**Entry gate:** Phase 2 exit.
**Exit gate:** a domain subject produces normalized subdomain/host/cert findings
from at least Shodan + crt.sh + SecurityTrails, deduped, saved with provenance.

**Defer:** Redis-backed cache + a job queue until a single case regularly issues
enough infra calls to hit rate limits. In-memory is fine below that.

---

## Phase 4 — Dataset adapters

Deepen the datasets tier beyond deeplinks where a real API exists.

**Build:**
- Intelligence X — `api`, key-gated, normalized into a `DatasetHit` shape.
- OpenSanctions — `api`, sanctions/PEP/watchlist matching with source
  provenance carried into `Finding`.
- Keep Aleph / ICIJ / OpenCorporates / Wikidata as deeplinks (no stable free
  API worth the coupling; the deeplink is the right integration).
- Entity extraction stub: pull candidate entities (names, orgs, domains) out of
  dataset hits into `Subject` suggestions for the case. No auto-linking yet.

**Entry gate:** Phase 3 exit.
**Exit gate:** a person/company subject returns normalized dataset hits from
IntelX + OpenSanctions with provenance; sanctioned-entity match is unmissable
in the UI.

---

## Phase 5 — Exposure + people (scoped tier)

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
3  Infra adapters            ← next (highest value; do before scoped tier)
4  Dataset adapters
5  Exposure + people         (scoped; hard gate + audit)
6  Correlation + graph       (defer until real multi-source case volume)
7  Reporting + export
8  Hardening + deploy        (defer infra cost until earned)
```

Critical path to a genuinely useful internal tool is **1 → 2 → 3**: cases,
a dashboard, and the infrastructure tier. That's a working OSINT workstation.
Everything after is depth. The scoped tier (5) is gated on the audit layer (1)
being airtight — that ordering is not negotiable.
