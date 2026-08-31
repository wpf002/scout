# Scout Roadmap

One indicator in, every applicable tool runs, one consolidated result.

This replaces the previous roadmap, which built Scout as a launcher that
deliberately refused to assemble results. That was the wrong product. Scout is
an aggregator: you paste an indicator, it works out what kind of thing it is,
runs every tool that applies, and gives you a single set of results.

## What Changed

The old roadmap's invariant 2 read: "There is never a single box that takes a
name and returns an assembled dossier." That box is now the product. The rest
of the invariants stand, because none of them cost anything at the surface:

1. **Scope is backend configuration.** Person-facing sources still check a
   configured authorization scope. It lives in `.env` and on the case record,
   never in the UI, and a blocked source appears in the results as a row with a
   reason rather than being hidden or refusing the whole run.
2. **Every query is logged.** Who, what, when, which source, which case. The
   audit table costs one row per call and is what makes the person-facing
   sources defensible.
3. **Deeplink sources never transmit the subject through Scout.**
4. **Provenance on every result.** Source, query, case, timestamp.
5. **Sources are inert without their dependency, never guessed.** No key, or no
   binary on PATH, means `inert`. Scout never fabricates or infers a result.
6. **No secrets in the UI.** Keys and tokens are set in `.env` only. There is no
   token-entry screen and there will not be one.

## Target Coverage

| Tool | Kind | State |
|---|---|---|
| Shodan | API | Built, needs `SHODAN_API_KEY` |
| Censys | API | Built, needs `CENSYS_API_KEY` |
| SecurityTrails | API | Built, needs `SECURITYTRAILS_API_KEY` |
| crt.sh | API | Built, keyless |
| Intelligence X | API | Built, needs `INTELX_API_KEY` |
| OpenSanctions | API | Built, needs `OPENSANCTIONS_API_KEY` |
| HIBP | API | Built, needs `HIBP_API_KEY` |
| Hunter.io | API | Built, needs `HUNTER_API_KEY` |
| WhatsMyName | API | Built, needs `WHATSMYNAME_ENABLED` |
| theHarvester | CLI | Built and verified against a live run |
| Sherlock | CLI | Built, needs the tool installed |
| Maigret | CLI | Built, needs the tool installed |
| Recon-ng | CLI | Not built |
| SpiderFoot | API (self-hosted) | Not built |
| Epieos | API | Not built — access model unverified |
| Maltego | — | Graph view substitutes; no integration planned |

## The Surface

Scout is a live map with the indicator search inside it.

Phase C put the whole application on one page — an indicator field, a run
button, and a table. That page still exists, unchanged in behaviour, but it is
now a panel on a full-screen world view rather than the whole screen. The
reason is that most of what an investigation needs is already geographic: a
host has a location, an incident has a location, and a page that shows a table
next to a map an operator has to imagine is doing half the work.

Nothing about invariants 1 to 6 changes. The map does not touch the scope gate,
the audit log, or where keys live. Located hosts from a run are plotted as one
more layer, and every other layer is a public feed.

## Phases

### Phase G — The Map Surface ✅ Shipped

- Full-screen MapLibre globe on Esri raster imagery, proxied server-side
  through a host allowlist. The proxy is an allowlist, not an open relay.
- Live layers, all keyless: earthquakes (USGS), natural events (NASA EONET),
  air traffic (OpenSky), vessel traffic (Digitraffic, Baltic), geocoded news
  (GDELT), submarine cables, traffic cameras (NYC, London), aurora forecast
  (NOAA OVATION), and a solar terminator computed in the browser.
- Every feed is normalised to GeoJSON server-side, cached with a TTL matched to
  how fast the thing actually moves, and a dead upstream reports empty with a
  reason rather than taking the map down.
- The URL is the source of truth for which layers are on, so a view is a link.
- Search takes a place, a coordinate pair, or an indicator. An indicator opens
  the OSINT panel seeded with it; the split happens in the browser so a
  coordinate never leaves the machine to be told it is a coordinate.
- Alerts across feeds, with severity derived from what each feed measures
  rather than asserted.
- Measurement: radius, box and path, computed on the sphere.

**Done when:** the map draws every layer live, the OSINT run still works
unchanged inside it, and a link restores a view. ✅



### Phase A — Subprocess Seam ✅ Shipped

Five of the target tools are local programs, not services. Scout's adapter model
was HTTP-and-a-key only, so there was no way to reach them.

- `apps/api/src/adapters/cli/run.ts` — `execFile` with an argv array and no
  shell, PATH resolution, timeouts, output caps, and a typed distinction between
  "not installed" and "ran and failed".
- `mode: "cli"` and `binary` on `Source`; a missing binary reports `inert` with
  reason `missing-binary`, matching how a missing key behaves.
- theHarvester (infra, ungated), Sherlock and Maigret (people, gated).
- Parser tests that run without any of the tools installed.

**Done when:** the three CLI sources appear in the registry, report `inert`
cleanly on a machine that lacks them, and the parsers are covered. ✅

### Phase B — Run Everything ✅ Shipped

The endpoint behind the single box.

- Indicator type detection: domain, IP, email, username, hash, company, person.
- `POST /run` — takes an indicator, resolves its kind, runs every applicable
  source, returns one consolidated result set with per-source status.
- Sources run concurrently with a bounded pool, and one slow or failing tool
  never holds or sinks the run.
- Every source that did not run appears with a reason: no key, not installed,
  out of scope, wrong subject kind.

**Done when:** one call against a domain returns normalized results from every
keyed and installed source, plus an honest account of everything that did not
run. ✅

`POST /run` and `GET /run/detect` in `apps/api/src/routes/run.ts`, detection in
`packages/sources/src/detect.ts`. A scope denial comes back as a `blocked` row
with its reason and the run continues — a 403 for the whole request would throw
away every other source's results.

### Phase C — The Single Surface ✅ Shipped

One page. Indicator field, run, results.

- Results as one dense table: source, type, value, first seen, provenance.
  Grouped by result type, not by which tool produced it.
- Per-source status strip showing what ran, what was inert, what was blocked.
- Deeplink sources render as links to open, since they never run server-side.
- Delete the watch floor, cases index, and sources pages. Case selection becomes
  a control in the header.
- Remove the operator token component. Keys are backend-only.
- Copy pass: labels not sentences, correct title case, no editorial voice.

**Done when:** paste an indicator, press one button, read one table. No other
page is needed to run an investigation. ✅

One route (`apps/web/src/app/page.tsx`), a source rail, and a results table
grouped by observation type in `apps/web/src/lib/flatten.ts`. The cases,
sources, and watch-floor pages are gone, along with the token component.

### Phase D — Recon-ng and SpiderFoot

The two largest remaining coverage gains, and the two most involved.

- Recon-ng runs modules against a workspace database rather than printing
  results, so the adapter drives a workspace and reads it back.
- SpiderFoot runs as its own service with a REST API — an HTTP adapter, not a
  CLI one. Its integration surface needs verifying before wiring.

**Done when:** both contribute to the consolidated run for a domain subject.

### Phase E — Consolidation

With more sources, the same host and email arrive from several tools.

- Entity resolution across sources so one host appears once, carrying every
  source that saw it.
- The existing `packages/graph` becomes the second view of the same result set.
- Export: the consolidated result as a report, with provenance intact.

**Done when:** a domain with hits from five sources reads as one deduplicated
result set, and each row names every tool that found it.

### Phase F — Epieos and Person Assembly

Held to last on purpose. Epieos and person-subject assembly are the most
sensitive part of the tool, and they should land on a consolidation layer that
already works rather than driving its design.

- Verify Epieos access model before committing to it.
- Person and email subjects assemble across the exposure and people tiers.

## Deferred

Unchanged from before, and still unearned:

- Redis cache and a job queue. In-memory is fine until a single run regularly
  hits rate limits.
- Metrics and tracing.
- Multi-operator auth. Single operator until there is a second one.
- Deployment. Local until the tool is worth deploying.
