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

Twenty-four live layers in ten categories, every one of them keyless.

| Category | Layers |
|---|---|
| Aviation | Commercial, Private, Private Jets, Military |
| Maritime | Vessels, ports, chokepoints |
| Space | All satellites, Comms, Military, Navigation, Earth observation, Stations |
| Surveillance | CCTV cameras, live previews, live news |
| Natural hazards | Earthquakes, active fires, severe weather |
| Threats | Nuclear facilities, global incidents, GDELT events |
| Network intel | Live malware, attack infrastructure |
| Cloudflare Radar | Internet outages, attack origins (needs a token) |
| Space weather | Planetary K-index, aurora forecast |
| Infrastructure, display | Submarine cables, day/night, 3D terrain |

Plus: search that takes a place, a coordinate or an indicator; route planning
with turn-by-turn steps; radius, box and path measurement on the sphere;
alerts aggregated across active layers; a wire-headline intel feed; a markets
crawl; a minimap; view export; and keyboard shortcuts.

**Done when:** every layer draws live, the OSINT run still works unchanged
inside it, and a link restores a view. ✅

Things that are true about this and worth not forgetting:

- Satellite positions are *propagated* from CelesTrak orbital elements with
  SGP4. They are computed, not observed. CelesTrak refuses a refetch inside
  its two-hour window and firewalls an address that accumulates fifty HTTP
  errors in one, so elements are cached to disk and the whole catalogue is one
  request rather than twenty.
- Threat-feed positions are IP geolocation. A dot is where an address is
  registered, not where a machine stands.
- The attack layer draws command-and-control servers and payload hosts of the
  same family, both currently observed. It is infrastructure, not observed
  attacks — there is no keyless feed of those with both endpoints, and drawing
  one would mean inventing the coordinates.
- Live AIS is regional. No keyless global feed exists; the layer names the
  authority that saw each vessel, and always carries the ports and chokepoints,
  which are the globally meaningful part.
- CCTV is agency-published only. Nothing here comes from scanning for exposed
  devices.
- Cloudflare Radar is the only source needing a key, and its layers are hidden
  rather than shown permanently failing.

### Phase H — Global AIS and FIRMS at full resolution

The two places where a free key would buy real coverage, both deferred until
someone decides the key is worth having.

- `aisstream.io` gives global live AIS. The key is free and self-serve, but it
  is still a key, and the layer is honest about its regional coverage without
  one.
- `FIRMS_MAP_KEY` is not needed — the keyless CSV archive carries the same
  detections — but the API would allow bbox queries instead of a Range read.

**Done when:** either is configurable and the layer says which mode it is in.

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
