# Scout

Tiered OSINT investigation platform. Datasets and infrastructure recon at the
core, dark-web search as fallback, every person-facing lookup behind a hard
scope gate.

Scout is a **launcher, not an aggregator**. There is deliberately no box that
takes a name and returns an assembled dossier. It plans, it gates, it records —
and it makes you take each person-facing action on purpose.

**Status:** Phases 0–7 shipped, plus the hardening half of 8, plus continuous
monitoring and the watch floor on top. Deployment is not built; the hardening it
depends on is. See [ROADMAP.md](./ROADMAP.md) for the locked build order.

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
pnpm start
```

That is the whole thing. It creates `.env` if missing, starts Postgres if it is
not up, applies migrations, seeds an empty database, runs the API and the
dashboard together, waits until both actually answer, and then prints:

```
  →  http://localhost:3000
```

**Open that URL, with the port.** The dashboard proxies the API itself at
`/api`, so it is the only address you need — there is no second port to get
right and no CORS allowlist involved. Ctrl-C stops both.

It says *verified, not assumed* because a port answering is not the same as
the app working. Three things are checked before that line prints: the API's
health endpoint, the dashboard serving its shell rather than a 200 from a
compile-error page, and the API reachable **through** the `/api` proxy — the
path the browser actually uses. If any of them fails the script tails the
relevant log, leaves nothing running, and exits non-zero.

It then **stays** started. Starting a dev server is not the same as keeping it
running: one can be killed out from under you — by an OOM reaper, a
process-group teardown, a supervisor that owns the terminal — and when it
happens there is no error anywhere. The log simply stops mid-request, and the
last thing on screen still says the app is up. A watchdog re-checks every 10s
(`SCOUT_WATCH_SECONDS`) and restarts only the half that is actually down. One
failed check is not an outage, so it takes two consecutive failures — a slow
compile should not trigger a restart.

It also repairs the things that used to make it fail:

| | |
|---|---|
| A stale server on either port | Killed, escalating to `SIGKILL`, and waited out until the port is genuinely free |
| A production `.next` | Cleared — `next dev` cannot run on one, and says so only via a wall of `ENOENT` |
| Anything else | One automatic retry with a cleared build cache before giving up |

Port detection combines `lsof`, `fuser`, `ss` and a `/proc` scan rather than
trusting the first tool installed. `lsof` exists in some containers and returns
nothing while exiting 0, which is indistinguishable from "the port is free" —
that silent empty answer let a stale server hold a port the script had just
reported clear.

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
packages/graph      Entity extraction, resolution, summaries. Pure
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
| `GET` | `/cases/:id/timeline` | Queries, findings and case events in one chronology, refusals included. |
| `POST`/`GET` | `/cases/:id/monitors` | Standing watches. **Refuses any source gated for the subject kind.** |
| `PATCH`/`DELETE` | `/cases/:id/monitors/:monitorId` | Pause, retime, rename, remove. |
| `POST` | `/cases/:id/monitors/:monitorId/run` | Run one now. First run is a baseline. |
| `POST` | `/monitors/run-due` | Runs every monitor whose interval elapsed. Safe to call from cron alongside the in-process ticker. |
| `GET` | `/alerts` | Unacknowledged changes across every case. `?caseId=`, `?includeAcknowledged=true`. |
| `POST` | `/alerts/acknowledge` | Records who cleared what. |
| `POST` | `/exposure/:sourceId` | Scoped. `hibp`, `dehashed`. Requires `caseId` + `confirm: true`. |
| `POST` | `/people/:sourceId` | Scoped. `hunter-io`, `whatsmyname`. Same requirements. |
| `GET` | `/scoped/adapters` | The person-facing sources that are built. |
| `GET` | `/cases/:id/report` | `format=html\|docx\|json`. Redacted, audited. |
| `GET` | `/cases/:id/audit/export` | The query log as CSV, for engagement records. |
| `POST` | `/cases/:id/archive`, `/restore` | Soft delete. Reversible, audited. |
| `POST` | `/cases/:id/purge` | Deletes findings + subjects. Keeps the audit trail. |
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

### Visual language

Dark, always — not "dark unless the OS says otherwise". The signal language is
calibrated against a near-black ground and half of it stops carrying meaning on
white, so following the system preference would mean maintaining a second
calibration that nobody tests.

One decision constrains the rest. Crimson is the brand accent, and red already
meant *refused* here. Hue alone can no longer carry that, so the two are
separated by **treatment**:

| | |
|---|---|
| **Brand** | Crimson as outline, glow, and thin rule. Never a filled block. |
| **Refusal** | Crimson **filled**, with the word. `.badge.deny`, `.entry.blocked`. |

A denial has to survive being scrolled past, and it now does so by being the
only solid red mass on the page rather than by being the only red thing. Links
are plain text with an underline for the same reason — a case name rendered in
the same red as a refusal reads like something went wrong with it. Not
incidentally, none of this depends on colour vision to tell a link from a
denial.

### The watch floor

`/` is a dashboard built around one question — *what changed since I last
looked* — because everything else in Scout is something you go and fetch. It
shows the alert feed, the active cases, and whether the API and its keys are
where you left them.

What it deliberately does not show is a case score, a risk ranking, or a
cross-engagement findings total. A number like that gets read as an
assessment, and Scout has no basis for one: a case with forty findings and a
case with two are not comparable, they are differently scoped.

### The case workspace is tabbed

Ten stacked cards pushed the scope panel — the one thing that governs whether
anything can run at all — off the top of the page. Scope and subjects now live
on the tab you land on:

`Overview` · `Collect` · `Findings` · `Graph` · `Watch` · `Timeline` ·
`Audit` · `Export`

The tab strip carries counts for findings, unread alerts, and **refusals**. A
denial is not a footnote to hunt for in the audit view.

### The graph reads left to right

Entities render as cards — kind, value, and how many sources corroborate them —
on a dark field with orthogonal connectors. Straight diagonals cross at every
angle and thirty of them is a haystack; elbows share vertical channels, so
density degrades into something still readable.

Columns are **(kind, depth)**, not kind alone. A case whose entities are all one
kind — five hostnames under one domain, the common shape — used to stack into a
single column with every connector routed straight through the cards. Depth is
distance along same-kind edges, computed by bounded relaxation rather than
recursion because the extractor makes no promise the edges are acyclic and a
cycle must not hang the page.

`subdomain-of` points child → parent, so laying it out in edge direction puts
the leaves on the left and the registrable domain on the right — backwards from
how anyone describes it. One `orient()` function decides which end goes left,
and both the layout and the drawing call it, because when they disagreed the
columns read correctly and every connector looped backwards around the cards.

### Pivots

Selecting an entity in the graph offers **Pivot to this** and **Watch it**.
Both hand a subject to the next form and stop there. A pivot that ran the next
query on click would be a fan-out wearing a click, and `cert` and `breach`
entities offer no pivot at all — a certificate serial is evidence about a host,
not somebody to look up.

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

## Auth and attribution

Off in development, **on by default in production** — an audit log whose every
row says `local` cannot answer the question it exists to answer, so this is not
opt-in.

```bash
pnpm db:operator add "alice"     # mints a token, shown once
pnpm db:operator list
pnpm db:operator disable "alice"
```

Requests carry `Authorization: Bearer <token>`. Every audit row and case event
is then attributed to that operator by name. `/health` stays public so a load
balancer can reach it.

Tokens are stored as SHA-256 digests. A slow KDF would be the wrong tool: these
are 256 bits of CSPRNG output, so there is no low-entropy guess to make
expensive, and bcrypt would add latency to every request for nothing.

The dashboard keeps its token in `sessionStorage`, never in a `NEXT_PUBLIC_`
variable — that would bake a credential into the client bundle and ship it to
everyone who loads the page.

## Retention

Phase 1 left a consequence: audit rows are immutable at the database level, so
a case cannot be deleted. That looked like a limitation. It is the right
retention model — data minimization should remove what was *collected about
people*, not the record of what was *done to them*.

```
archive  →  hides a finished case from the working list. Reversible.
purge    →  deletes findings and subjects. Irreversible. Requires a written
            reason. The case shell, its scope entries and every audit row stay.
```

A purge reports back what it retained, so nobody assumes it erased the trail. A
tool that could erase its own audit log on request would not be worth the
accountability claims made elsewhere in this codebase.

## The entity graph

Findings from different sources resolve into entities, and entities into
relationships. `www.example.com` reported by crt.sh, SecurityTrails, Shodan and
Censys is **one** node crediting all four — that corroboration is the thing the
graph exists to show.

```
GET  /cases/:id/graph                  entities, links, suggestions, summary
POST /cases/:id/graph/merge            confirm two entities are one
POST /cases/:id/graph/dismiss          stop offering a suggestion
```

**The graph is never stored.** It is recomputed from findings on every read, so
it cannot drift from the evidence. Only *decisions* persist — confirmed merges
and dismissed suggestions — because those are judgements that cannot be
re-derived.

### Automatic vs suggested

This phase was built with its own defer criterion unmet: there is no real
multi-source case volume to tune against. The hard part of entity resolution is
deciding which *near* matches are the same thing, and that judgement needs real
data. So the line is drawn hard:

| | |
|---|---|
| **Automatic** | Exact identity after normalization only. `WWW.Example.com` and `www.example.com` are the same host, and no tuning is needed to know that. |
| **Suggested** | Everything else. Near-matching names surface as a queue of questions, and nothing merges without an operator confirming it with a written reason. |

Suggestions cover two cases: names identical once casing, punctuation and
company suffixes are ignored (`Acme Ltd.` / `ACME LIMITED`), and one name's
tokens being a strict subset of another's. **No edit distance, no phonetics, no
nicknames** — those are precisely the heuristics that need calibration, and an
uncalibrated one produces confident nonsense about real people. A graph that
silently merged two similarly-named people would be worse than no graph,
because it would look like a finding.

Merging is audited: it asserts two records describe one person.

### Everything traces

Every entity names the findings that evidence it; every edge names the findings
and sources behind it. Selecting a node answers "how do you know that". A test
asserts no edge can cite a finding that does not exist on the case.

### Summaries are drafts

The summarizer **counts**. Every sentence is a fact about rows that exist, so
there is no mechanism by which it could invent something. A `Summarizer`
extension point exists for swapping in a different implementation later; none
ships.

A summary is marked `draft`, stored apart from findings, and validated by
`assertNoInventedProvenance()` — which throws if it cites a finding that does
not exist. That guard is the point: "never invent provenance" is otherwise a
promise nothing enforces.

## Monitoring

Scout was pull-only: you opened a case and went looking. A **monitor** is a
standing watch that re-runs a set of sources on an interval and raises an alert
when an observation appears or disappears.

```
POST /cases/:id/monitors                create a watch
POST /cases/:id/monitors/:id/run        run it now
POST /monitors/run-due                  run everything whose interval elapsed
GET  /alerts                            the feed, newest first
POST /alerts/acknowledge                how an alert stops being noise
```

### A monitor can never watch a person

This is the restriction the whole feature is built around: **a monitor may only
include sources that are ungated for its subject kind.** `assertMonitorable()`
checks the effective per-subject-kind gate, so Intelligence X can be watched
for a domain and never for an email selector, and HIBP, Dehashed, Hunter.io and
WhatsMyName can never be watched at all.

Watching a domain's infrastructure change is ordinary recon. Putting a person
under a recurring breach-exposure or identity-enumeration lookup is standing
surveillance, and "one confirmed action at a time" is exactly what a timer
removes. The check runs again on **every** run, not just at creation — the
registry can change under a stored monitor, and a source that becomes gated has
to stop being watched rather than keep running under an old decision.

OpenSanctions accepts a person and remains monitorable, which is not a hole in
the rule but the rule working: it screens a name against published designation
lists, and periodic re-screening is the ordinary use of one. The gate is the
line, and it was drawn source by source long before monitors existed.

### Baselines and outages

The first run is a **baseline**: it stores the snapshot and reports nothing.
Treating everything visible on day one as "newly appeared" would bury the first
real change under a hundred false ones, which is how a feed becomes something
people stop reading.

A run where every source failed carries the previous snapshot forward and
raises no removals. A run that reached nothing is not evidence that everything
is gone, and an outage that emptied the feed into alerts would do more damage
than the outage.

Monitored queries go through `executeUnscopedSource` like any other, so they
land in the audit log identically. A recurring lookup is not a lesser event
than a one-off.

### Scheduling: a timer, not a queue

Without something calling the sweep, a standing watch only runs when a human
presses a button, which makes "standing watch" a promise nothing keeps. There
are two ways to drive it, and they are interchangeable:

```bash
# in-process ticker — off unless you set it
SCOUT_MONITOR_TICK_SECONDS=300

# or point anything external at the same sweep
curl -XPOST $SCOUT_API/monitors/run-due
```

The ticker is a `setInterval`, and the README will not dress it up as more than
that: no retries, no backoff, no persistence across a restart, no distribution.
The Redis-and-a-job-queue defer criterion is **still unmet**, and building one
on speculation is the kind of infrastructure that exists to look finished.

What it does have are the two properties that make it safe to leave running:

- **Sweeps never overlap.** A tick arriving while the previous sweep is still
  going is skipped and counted, not queued behind it. A scheduler permanently
  behind shows up as `monitor.tick.skipped` rather than quietly compounding.
- **Every monitor is claimed before it runs.** The claim is a conditional
  update — `lastRunAt` is stamped only if it still holds the value that made
  the monitor due — so the ticker, an external cron, and a second API replica
  can all point at one database without double-running a monitor. Stamping
  before the work means a process that dies mid-run leaves the monitor waiting
  an interval rather than being picked up again immediately. A missed run is a
  delay; a double run is a duplicated upstream call and a second baseline.

Calling `/monitors/run-due` more often than the intervals is therefore
harmless, and so is enabling the ticker on more than one replica.

## Reporting

`GET /cases/:id/report` turns a case into a deliverable — findings grouped by
tier, each carrying the source and query that produced it, plus a timeline and
the full audit trail. Three formats share one already-redacted `CaseReport`, so
HTML, docx and JSON cannot disagree about what left the building.

The HTML is self-contained and prints to PDF; the docx is the editable version
a client can annotate. The audit trail also exports separately as CSV, because
retention rules for a query log and for an investigative deliverable are rarely
the same.

### Redaction is the other half of the gate

The scope gate governs what Scout *fetches*. Redaction governs what Scout
*emits*. Notes and finding summaries are typed by hand, and hand-typed text
picks up things the engagement was never authorized to collect — a bystander's
address pasted in while chasing a lead. Those are stripped before export, and
the report says how many identifiers it removed (kinds and field names only —
listing the values would defeat it).

It recognizes emails, hostnames and IPv4 addresses. A second pass strikes
credential material: if the case has stored a password (only possible under
`SCOUT_ALLOW_CREDENTIAL_MATERIAL`), that value is struck from every free-text
field, because scope-based redaction cannot catch a password — it is not an
identifier. `Finding.data` is never rendered into a report at all, so the
structured payload cannot ride along either.

Three deliberate boundaries:

- **The audit trail is never redacted.** A refused lookup's row must still name
  what was refused; that record is the evidence the gate held, and scrubbing it
  would destroy the thing the log exists for.
- **It is not a general PII scrubber** and does not claim to be. It removes
  identifiers it can positively recognize. Prose can hide anything, so this
  reduces leakage rather than guaranteeing its absence — which is why the
  report states plainly what it did.
- **A bare dotted quad is treated as an address**, not a version string. The
  two are genuinely ambiguous, and under-detecting an identifier is the worse
  failure when this feeds redaction.

Every export writes an audit event. A case should show that its contents left
the tool, and when.

## Tests

```bash
pnpm test        # 347 tests
```

- `packages/scope` (35) — the gate, including lookalike domains, `@`-smuggling,
  IDN normalization, and fail-closed on unparseable input.
- `packages/sources` (31) — registry invariants (pins the scoped set) and
  observation dedupe/attribution.
- `packages/db` (8) — audit immutability against a live Postgres, key redaction,
  BigInt JSON safety.
- `packages/graph` (29) — extraction, exact-identity resolution, the
  suggested/automatic boundary, and summary provenance validation.
- `apps/api` (244) — the Phase 1, 3 and 4 exit gates end to end, upstream
  normalizers against fixture payloads, cache and rate-limiter behaviour, plus
  a red-team block: scope-shaped fields smuggled into request bodies, lookalike
  domains, nonexistent cases, empty scope, sweeping a scoped source, and
  reaching a per-kind gated source through the ungated path.

`apps/api/src/monitors.test.ts` (30) carries the monitoring restriction as its
load-bearing assertion: a parameterized case refuses to create a monitor on
each of `hibp`, `dehashed`, `hunter-io` and `whatsmyname`, and a pair of cases
pins the per-kind boundary — Intelligence X accepted for a domain, refused for
an email selector. The rest cover baselines, change detection in both
directions, and the outage that must not read as everything disappearing.

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

### What the suite does not cover

Fixture tests pin the *shape* each provider returns. They cannot tell you
whether a provider still returns that shape today, or whether your key works.

```bash
pnpm build && node scripts/verify-live.mjs [domain]
```

calls each configured upstream for real and reports what came back. It is
deliberately outside `pnpm test`: it needs live keys, costs quota, and fails
during a third-party outage — none of which belong in a suite that gates
commits. Sources without a key report `skipped`, and the probes use a domain,
never a person.

### Known exceptions, on purpose

- **`opensanctions` is ungated for person names.** Sanctions and PEP screening
  runs against names you have no prior relationship with, and returns published
  designations rather than private facts. It is the only entry on the reviewed
  list in `invariants.test.ts`; adding a second requires writing down why.
- **ViewDNS stays a deeplink.** Its API needs a paid key, so a key-gated
  adapter would ship code no one here can exercise. The link is the honest
  integration until someone has one.
- **Redis and a job queue are not built.** The Phase 3 defer criterion —
  "until a case regularly hits real rate limits" — has not been met. In-memory
  caching and per-source token buckets are correct until it is.

The DB-backed suites skip without `DATABASE_URL`. They don't clean up — audit
rows can't be deleted — so point them at a disposable database.

`HIBP_API_KEY` is unset during tests on purpose: an in-scope call lands on
`inert` rather than the network, so the gate is exercised end to end without
ever making a real request about a real person.

---

## What's next

Phases 0–8 are shipped, plus monitoring and the watch floor on top. What is
still deliberately absent is written down rather than implied: no Railway
deploy, no Redis or job queue, no metrics or tracing — each gated on a defer
criterion that is still unmet, and `POST /monitors/run-due` is the seam that
lets scheduling happen without pretending a worker exists. See
[ROADMAP.md](./ROADMAP.md).
