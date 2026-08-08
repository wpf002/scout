# Scout

Tiered OSINT investigation platform. Datasets and infrastructure recon at the
core, dark-web search as fallback, every person-facing lookup behind a hard
scope gate.

Scout is a **launcher, not an aggregator**. There is deliberately no box that
takes a name and returns an assembled dossier. It plans, it gates, it records —
and it makes you take each person-facing action on purpose.

**Status:** Phase 0 (foundation) and Phase 1 (persistence + cases) shipped.
See [ROADMAP.md](./ROADMAP.md) for the locked build order.

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
pnpm --filter @scout/api dev    # http://localhost:3001
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
| `POST` | `/exposure/hibp` | Scoped. Requires `caseId` and `confirm: true`. |

Subject terms travel in POST bodies, never URL params, and request bodies are
stripped from logs.

### Env scope fallback

`SCOUT_SCOPE_DOMAINS` / `SCOUT_SCOPE_IDENTIFIERS` provide scope for keyless
local use, but **only for planning previews**. Executing a scoped source always
requires a real case: an execution has to land in the audit log against an
authorization reference, and env vars carry neither.

---

## Tests

```bash
pnpm test        # 65 tests
```

- `packages/scope` (22) — the gate, including lookalike domains, `@`-smuggling,
  IDN normalization, and fail-closed on unparseable input.
- `packages/sources` (13) — registry invariants; pins the scoped set.
- `packages/db` (8) — audit immutability against a live Postgres, key redaction,
  BigInt JSON safety.
- `apps/api` (22) — the Phase 1 exit gate end to end, plus a red-team block:
  scope-shaped fields smuggled into request bodies, lookalike domains,
  nonexistent cases, empty scope.

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
