# Scout

Tiered OSINT investigation platform. Datasets and infrastructure recon at the
core, dark-web search as fallback, every person-facing lookup behind a hard
scope gate.

Scout is a **launcher, not an aggregator**. There is deliberately no box that
takes a name and returns an assembled dossier. It plans, it gates, it records —
and it makes you take each person-facing action on purpose.

**Status:** Phases 0–5 shipped — foundation, persistence + cases, web
dashboard, the infrastructure and datasets tiers, and the scope-gated
exposure/people tier. See [ROADMAP.md](./ROADMAP.md) for the locked build
order.

---

## The invariants

These hold across every phase. They are enforced in code and tested, not just
documented.

| # | Invariant | Where it lives |
|---|---|---|
| 1 | **The scope gate is absolute.** No `requiresScope` source executes for a subject outside the case's authorization scope. Scope is set on the case, never widenable by a request parameter. Empty scope means OFF, not open. | `packages/scope`, `apps/api/src/adapters/base.ts` |
| 2 | **No blind fan-out.** `/query` plans; it never executes. Scoped sources run one confirmed subject at a time. | `apps/api/src/routes/query.ts` |
| 3 | **Every scoped query is logged** — who, what, when, which source, under which case and authorization reference. Rows are immutable. | `QueryLog` + DB trigger |
| 4 | **Deeplink sources never transmit subject data through Scout.** Scout builds a URL; your browser opens it. | `Source.deeplink`, never fetched server-side |
| 5 | **Provenance on every finding.** Source, query, case, timestamp — all required columns. | `Finding` |
| 6 | **Sources are inert without keys, never guessed.** No key means `inert`. Scout never fabricates a result. | `hasKey()`, `SourceResult.status` |
| 7 | **Standard stack.** TypeScript, pnpm/Turborepo, Fastify, Prisma, Postgres. Zod at every boundary. BigInt for anything counted. | throughout |

The scope gate is the product. A leaky gate is worse than no scoped tier at all.

---

## Quickstart

Requires Node ≥ 20.11, pnpm 10, and Postgres.

```bash
./scripts/bootstrap.sh          # deps, .env, database, migrations, seed, build
pnpm --filter @scout/api dev    # API  → http://localhost:3001
pnpm --filter @scout/web dev    # web  → http://localhost:3000
```

`bootstrap.sh` starts a throwaway local Postgres via `scripts/dev-db.sh` if
`DATABASE_URL` isn't reachable. To do it by hand:

```bash
pnpm install
cp .env.example .env            # then set DATABASE_URL
export $(grep -v '^#' .env | xargs)
pnpm db:deploy && pnpm db:seed
pnpm build && pnpm test
```

### The loop, end to end

```bash
# 1. Create a case. The authorization reference is required.
curl -s localhost:3001/cases -H 'content-type: application/json' -d '{
  "name": "Engagement 14",
  "authorizationRef": "ENG-2026-014",
  "scope": [{"kind": "domain", "value": "example.com"}]
}'

# 2. Plan. Nothing executes; scoped sources report ready/inert/blocked.
curl -s localhost:3001/query -H 'content-type: application/json' -d '{
  "caseId": "<id>", "subject": {"kind": "email", "value": "bob@example.com"}
}'

# 3. Run one scoped source, explicitly, for one subject.
curl -s localhost:3001/exposure/hibp -H 'content-type: application/json' -d '{
  "caseId": "<id>", "confirm": true,
  "subject": {"kind": "email", "value": "bob@example.com"}
}'

# 4. Read the accountability trail.
curl -s localhost:3001/cases/<id>/audit
```

Step 3 with an out-of-scope address returns `403 scope-denied` **and still
writes an audit row**. That denial record is the point.

---

## Layout

```
apps/api            Fastify API — routes, adapters
apps/web            Next.js dashboard — the investigator surface
packages/sources    Tiered registry: 19 sources, 6 tiers, typed + inert-aware
packages/scope      The gate. Pure, dependency-free, heavily tested
packages/db         Prisma schema, client, audit helpers
```

**Tiers, in reach-for order:** `datasets → infra → exposure → people → onion →
utils`. Order is load-bearing — the dashboard renders it and investigators work
it top-down.

**Scoped sources** are exactly four, all person-facing: `hibp`, `dehashed`,
`hunter-io`, `whatsmyname`. The set is pinned by a test so a fifth cannot be
added without a deliberate change alongside an adapter that calls
`enforceScope()`.

### How the gate is enforced

`packages/scope` is pure — it takes a subject and a list of scope entries and
returns a decision. It knows nothing about cases, HTTP, or the database, which
is why swapping env-derived scope for case-derived scope in Phase 1 didn't touch
the matcher.

Enforcement lives in the **adapter**, not the route
(`apps/api/src/adapters/base.ts`). The ordering is deliberate:

1. Load the case. No case, no scoped execution.
2. Enforce scope — *before* the key check, so an out-of-scope attempt is
   recorded as denied whether or not the source could have run.
3. Write the denial, then rethrow.
4. Only then check the key, and only then make the network call.

Routes get refactored and new callers appear; putting the gate in the adapter
means the network call is unreachable for an out-of-scope subject regardless.

Matching is anchored on label boundaries and normalizes both sides through
WHATWG `URL`, so `notexample.com`, `example.com.evil.net`, IDN homographs, and
`alice@example.com@evil.net` all fail closed. Unparseable input is denied, never
treated as a wildcard.

### Why the audit log is a database trigger

"Immutable by convention" is worth very little — the next refactor or anyone
with the connection string can rewrite the record that makes this tool
defensible. `QueryLog` and `AuditEvent` reject `UPDATE` and `DELETE` at the
database level.

One accepted consequence: **a case with audit rows cannot be hard-deleted**,
because the cascade would have to delete them. There is no delete-case route for
exactly this reason. Retention and soft-delete are Phase 8, and will archive
rather than erase.

---

## API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Reports DB state and which sources are keyed. 503 if DB is down. |
| `GET` | `/sources` | Registry in tier order, with `keyed` / `hasAdapter`. |
| `POST` | `/query` | **Plans only.** Never executes. |
| `POST` | `/cases` | `authorizationRef` required. |
| `GET` | `/cases`, `/cases/:id` | |
| `PATCH` | `/cases/:id` | Name, notes, status. |
| `POST` | `/cases/:id/scope` | Requires `confirmAuthorized: true`; writes an audit event. |
| `DELETE` | `/cases/:id/scope/:entryId` | Audited. |
| `POST`/`GET` | `/cases/:id/subjects` | |
| `POST`/`GET` | `/cases/:id/findings` | Tier derived from the registry, not the request. |
| `GET` | `/cases/:id/audit` | Query log + scope changes. |
| `POST` | `/exposure/:sourceId` | Scoped. `hibp`, `dehashed`. Requires `caseId` + `confirm: true`. |
| `POST` | `/people/:sourceId` | Scoped. `hunter-io`, `whatsmyname`. Same requirements. |
| `GET` | `/scoped/adapters` | The person-facing sources that are built. |
| `POST` | `/infra/:sourceId` | One infrastructure source. Non-scoped. |
| `POST` | `/infra/sweep` | Several at once, merged. Ungated only, reports exclusions. |
| `GET` | `/infra/adapters` | Which infra adapters are built. |
| `POST` | `/datasets/:sourceId` | One dataset source. `confirm: true` when the kind is gated. |
| `POST` | `/datasets/sweep` | Batch the ungated dataset sources. Reports exclusions. |
| `GET` | `/datasets/adapters` | Which dataset adapters are built, and their `scopedKinds`. |

Subject terms travel in POST bodies, never URL params, and request bodies are
stripped from logs.

### Env scope fallback

`SCOUT_SCOPE_DOMAINS` / `SCOUT_SCOPE_IDENTIFIERS` provide scope for keyless
local use, but **only for planning previews**. Executing a scoped source always
requires a real case: an execution has to land in the audit log against an
authorization reference, and env vars carry neither.

---

## The dashboard

`apps/web` is where "launcher, not aggregator" becomes visible. It enforces
nothing itself — the API owns the gate and the audit log, so there is no second
enforcement point to keep in sync. What the UI does is make the posture legible:

- Tiers render in reach-for order, numbered, so you work top-down.
- Scoped sources carry a **SCOPED** badge everywhere they appear.
- A blocked source shows its deny reason inline and **has no Run button** —
  the control is absent, not disabled.
- Running a scoped source opens a confirmation naming the subject, the source,
  the matched scope entry, and the authorization reference.
- Deeplinks are ordinary anchors with `target="_blank"`. Your browser opens
  them; Scout never fetches them.
- There is no batch-run control, and there must never be one for a scoped
  source.
- Adding scope requires ticking an explicit authorization claim, which is
  written to the audit log.

## The infrastructure tier

The highest-value tier and the one that needs no scope gate: hosts,
certificates and DNS are infrastructure, not people.

Four adapters — **crt.sh** (free, keyless), **Shodan**, **SecurityTrails**,
**Censys** — normalize into three shapes (`SubdomainObservation`,
`HostObservation`, `CertObservation`) so they feed one board rather than four
source-shaped silos. Adding a source means writing a normalizer, not a view.

```bash
POST /infra/crtsh      # one source
POST /infra/sweep      # several at once, merged and deduped
GET  /infra/adapters   # what is actually built
```

**Dedupe unions attribution, never picks a winner.** If crt.sh, Shodan and
SecurityTrails all report `www.example.com`, the merged row credits all three.
Dropping two would lose provenance, and provenance is not optional.

**The sweep is the batch path invariant 2 permits** — and it is the only one.
It draws exclusively from the infra adapter registry, every member of which is
non-scoped; the route re-checks that before running anything, and
`executeUnscopedSource()` throws outright if handed a `requiresScope` source.
A person-facing source cannot reach this path.

Rate limiting is a per-source token bucket and caching is a 300s in-memory TTL.
Both are deliberately in-process: Redis and a job queue are a Phase 3 defer,
earned when a case regularly hits real rate limits, not before.

ViewDNS stays a deeplink — its API needs a paid key, and the link is the honest
integration until someone has one.

## The datasets tier

Leaks and pastes (**Intelligence X**), sanctions and PEP screening
(**OpenSanctions**). Aleph, ICIJ, OpenCorporates and Wikidata stay deeplinks —
none has a stable free API worth the coupling.

### Sweeps report what they refused to run

Both tiers have a sweep (`/infra/sweep`, `/datasets/sweep`), sharing one
implementation that filters on the effective per-subject-kind gate. A `person`
sweep runs OpenSanctions; an `email` sweep excludes Intelligence X, because for
that input it is a person-facing lookup.

Exclusions come back in the response and render in the UI. A sweep that quietly
omitted a gated source would read as "covered everything", and an investigator
would take the absence of a hit as evidence when it was really a refusal. When
nothing is left to sweep, the request fails with the reason rather than
returning an empty result set that looks like a clean negative.

### Per-subject-kind scoping

Some sources are only person-facing for some of their inputs. Intelligence X
searching a domain is dataset research; Intelligence X searching an email
address is a lookup about a person. Gating the whole source would block
legitimate infrastructure work; gating none of it would leave a person-facing
lookup ungated.

So the gate is decided per subject kind, via `requiresScopeFor(source, kind)`:

```
intelligence-x + domain  → runs freely
intelligence-x + email   → scope gate, confirmation, audit row
```

Every layer reads the same function — planner, dispatcher, adapter, and the
`requiresScope` column on the audit row, which records the gate that actually
applied rather than the source's blanket flag. Routes call `executeSource()`,
which picks the runner from the effective gate so no route can choose wrong.

### Five listings, five different claims

Sanctions data flattens badly, and flattening it makes false accusations about
real people. `classifyDesignation()` keeps them apart:

| Designation | What it actually claims |
|---|---|
| `sanctioned` | The entity itself is designated. |
| `linked-to-sanctioned` | Associated with a designated party — a subsidiary, a relative. **Not itself designated.** |
| `debarred` | Excluded from public procurement. Adverse, but not a sanction. |
| `pep` | Holds or held public office. Nothing adverse on its own. |
| `listed` | Present in a reference dataset with no adverse claim. |

`sanctioned` is true only for the first. The trap here is `sanction.linked`,
which *reads* like a sanction topic — treating it as one would designate
someone who has not been designated. Unrecognized topics fall through to
`listed` rather than having severity inferred from an unfamiliar string.

Absence of a match is likewise never rendered as "clear".

### Entity extraction

Dataset hits yield candidate entities as **suggestions**, never auto-links.
Structured provider fields are high confidence; patterns found in free text are
medium. Extraction is a pattern matcher, not entity recognition — guessing that
a capitalized phrase is someone's name is exactly the fabrication invariant 6
rules out.

## The scoped tier

The person-facing sources: **HIBP** and **DeHashed** (exposure), **Hunter.io**
and **WhatsMyName** (people). This is the tier the whole audit layer exists for.

**One handler, one gate.** All four run through a single route handler and a
single registry. Four bespoke routes would have been four chances to apply the
gate slightly differently, and the one that drifts is the one that leaks. A
test asserts the scoped registry and the registry's own scoped set are the same
four sources.

**Credential material is redacted by default.** DeHashed returns passwords.
Scout reports `hasPassword: true` and the breach name, and drops the value —
knowing a credential exists in a named breach is the finding, and a case
database should not become a credential store. `SCOUT_ALLOW_CREDENTIAL_MATERIAL=true`
opts in for engagements that genuinely need it (credential-stuffing
validation), and the response says which mode produced it so a redacted result
is never mistaken for an empty one.

**WhatsMyName is off until you turn it on.** It has no hosted API, so Scout
does the enumeration itself from the project's public site list — dozens of
outbound requests about one named person, the most invasive thing here. It is
capped at `WHATSMYNAME_SITE_LIMIT` sites, runs with bounded concurrency, and
stays `inert` until `WHATSMYNAME_ENABLED=true`. Detection requires both the
expected status *and* the expected marker string: status alone false-positives
on sites that return 200 for every URL, and a false positive asserts that a
named person holds an account they may not.

**The gate runs before the enable check.** An out-of-scope username reports
`blocked`, not `inert` — the refusal that matters is recorded first.

## Tests

```bash
pnpm test        # 211 tests
```

- `packages/scope` (22) — the gate, including lookalike domains, `@`-smuggling,
  IDN normalization, and fail-closed on unparseable input.
- `packages/sources` (31) — registry invariants (pins the scoped set) and
  observation dedupe/attribution.
- `packages/db` (8) — audit immutability against a live Postgres, key redaction,
  BigInt JSON safety.
- `apps/api` (150) — the Phase 1, 3 and 4 exit gates end to end, upstream
  normalizers against fixture payloads, cache and rate-limiter behaviour, plus
  a red-team block: scope-shaped fields smuggled into request bodies, lookalike
  domains, nonexistent cases, empty scope, sweeping a scoped source, and
  reaching a per-kind gated source through the ungated path.

`apps/api/src/invariants.test.ts` encodes the locked invariants as structural
tests — no database, no network, no keys. These fail a test run rather than a
code review, because "someone will notice in review" is how a safety property
erodes:

- No `mode: "deeplink"` source may have an execution route (invariant 4).
- No infra adapter may be `requiresScope` — what makes `/infra/sweep` safe.
- `executeUnscopedSource()` throws if handed a scoped source.
- Any `api` source accepting `email`/`username`/`person` must be gated for
  those kinds — wholesale or per kind — or sit on a pinned reviewed list.
  (`opensanctions` is the one entry, with the reasoning written down.)
- No batch-executable source may be gated for any kind it accepts, so a source
  free for domains and gated for email can never be swept with an email.
- `scopedKinds` must be a subset of `accepts` — gating a kind a source never
  receives is dead configuration that reads like protection.
- The scoped set, the keyless-api set, and the dual link+fetch set are all
  pinned.

The browser loops are checked with Playwright against a real Chromium — 23
checks for Phase 2, 14 for Phase 3, 19 for Phase 4, 9 for the designation
distinctions, and 17 for the scoped tier.

The DB-backed suites skip without `DATABASE_URL`. They don't clean up — audit
rows can't be deleted — so point them at a disposable database.

`HIBP_API_KEY` is unset during tests on purpose: an in-scope call lands on
`inert` rather than the network, so the gate is exercised end to end without
ever making a real request about a real person.

---

## What's next

Phase 2 (web dashboard) then Phase 3 (infrastructure adapters). The critical
path to a genuinely useful workstation is **1 → 2 → 3**; everything after is
depth. See [ROADMAP.md](./ROADMAP.md).
