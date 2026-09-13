# Load test

Phase 11 asked for one million observations and one hundred thousand
entities, with resolution wall time, graph query p95 and map frame rate
reported. This is what was measured, how, and where the design stops.

Harness: `apps/api/src/load/` (generation, graph timings, resolution
subset, `run.ts`) and `apps/web/e2e/load.spec.ts` (frame rate).

```bash
pnpm --filter @scout/api exec tsx src/load/run.ts --observations 1000000 --entities 100000 --edges 150000 --resolve 0
pnpm --filter @scout/api exec tsx src/load/run.ts --resolve-only --resolve 20000
SCOUT_LOAD=1 pnpm --filter @scout/web run test:e2e -- load.spec.ts
pnpm --filter @scout/api exec tsx src/load/run.ts --clean
```

Machine: Apple Silicon laptop, 10 cores, 24 GB, Postgres 16 + PostGIS in
Docker, Node 24, the resolution service under uv on the same machine.
Every row is synthetic and sits under one authorization (`LOAD-TEST-0001`)
so `--clean` removes all of it.

## Resolution wall time

Measured through `POST /v2/resolve` and the real service (Splink 4 on
DuckDB, the committed PERSON model), on a separate case with five
observations per true person carrying the variation the resolver is for
(initials, dropped letters, plus-tagged emails, missing fields).

| Observations | True people | Wall time | Entities | Pairs scored |
|---|---|---|---|---|
| 2 000 | 400 | 2.7 s | 288 | 28 327 |
| 20 000 | 4 000 | 87.1 s | 3 082 | 1 401 771 |
| 30 000 | 6 000 | failed | — | — |

The 30 000 run failed in the API, not the service: the service's JSON
response (every scored pair) outgrew the largest string Node can hold
(`0x1fffffe8` bytes), even after per-column evidence was trimmed from
NON_MATCH decisions. Pairs grow faster than observations because the
day-bucket blocking rule pairs everything observed on the same day. The
ceiling of the current design is therefore about 20 000 observations per
kind per run on this data, set by the single-request contract between the
API and the service, not by the model. Lifting it means streaming
decisions (NDJSON) and persisting them as they arrive, or writing
NON_MATCH decisions on the service side; that is listed as remaining work.

Three defects surfaced on the way and are fixed (`8e095ee`): an all-null
text column broke Splink's comparison; the run's persistence exceeded
Postgres's 32 767-bind limit at 20 000 observations; the response carried
per-column evidence for every rejected pair.

## Generation

1 000 000 observations (1 600 505 identifiers) in 98.7 s, 100 000 entities
with 1 000 000 memberships in 33.6 s, 150 000 edges in 7.9 s, written
directly in chunks. Database size afterwards: 2.3 GB.

## Graph query latency

Through the same functions the routes call, with the load authorization's
scope context, 200 iterations each on random entities after 10 warm-ups,
against 100 000 entities and 150 000 edges (mean degree 3). Milliseconds.

| Query | p50 | p95 | max |
|---|---|---|---|
| neighbors, 1 hop | 20.5 | 23.0 | 25.3 |
| neighbors, 2 hops | 2.1 | 47.8 | 76.6 |
| path, up to 4 hops (random pair, usually not found) | 4.1 | 7.0 | 11.1 |
| timeline of an entity | 1.7 | 4.1 | 6.6 |
| edges as of a random moment, three entities | 0.2 | 0.2 | 0.5 |

The one-hop p50 above the two-hop p50 is the order the measurements ran
in: one-hop went first over cold buffers, two-hop found them warm. Every
figure is below the 100 ms an interactive console notices, at this scale,
on one laptop, with no tuning beyond the indexes the schema declares.

## Map frame rate

`apps/web/e2e/load.spec.ts` opens the console on the load case, flies to
an entity, and counts `requestAnimationFrame` calls for five seconds while
dragging the map back and forth. Chromium, 1440×900.

| Browser | Frames per second | What was drawn |
|---|---|---|
| Headed (GPU) | 57.4 | 2 000 observations, 500 entities' traces, their links, one imagery toggle |
| Headless (SwiftShader, software WebGL) | 9.3 | the same |

The headed number is the one a user sees; the headless one is what CI
would see and is not a statement about the map. What the console draws is
bounded by its own reads: at most 2 000 observations and 500 entities per
case (`v2.observations`, `v2.entities` limits), so a case with a million
observations shows the most recent two thousand of them. Aggregation for
larger cases (heat and density views, clustering) is listed as remaining
work; the frame rate above is for the picture the console currently draws.

## What the scale showed

- Graph reads stay under 50 ms at p95 with a hundred thousand entities on
  one laptop; the schema's indexes are enough at this size.
- Resolution's contract, one request and one JSON response per run, caps a
  run near 20 000 observations per kind. The model is not the limit.
- The console's fixed caps make it a window onto a large case, not a view of
  it. That is the next thing to build after the agentic layer.
- Generation is fast enough (a million observations in under two minutes)
  that the harness can be run before any change to the read path.
