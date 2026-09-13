# Entity resolution

## Model choice

| | Splink | Zingg | Senzing |
|---|---|---|---|
| Licence | MIT | AGPL-3.0 | Proprietary |
| Runtime | DuckDB locally, Spark if needed | Spark | Native library, closed |
| Scoring | Fellegi–Sunter, m and u probabilities per comparison level, inspectable | Learned model, less inspectable | Closed scoring |
| Fit | An investigative product where a defence lawyer may examine the score | Batch-first, heavy | Fast, but a black box |

Splink. The score for any pair decomposes into per-field match weights that
can be printed, explained and challenged. A pair is never "0.93 because the
model said so".

## Pipeline

1. **Normalize.** Per identifier kind, versioned. Phone to E.164
   (`phonenumbers`). Email lowercased; plus-addressing and Gmail dot rules
   handled. Names transliterated (`unidecode`), nickname map applied. Addresses
   parsed; libpostal when its system library is present, a simpler tokenizer
   otherwise, with the version recorded either way. `normalizationVersion` is
   stored on every `Identifier`, so a normalizer change re-resolves only what
   it touched.
2. **Block.** Never all pairs. Keys: exact identifier, Double Metaphone of
   name plus locality, geohash prefix plus time bucket, device id, n-gram LSH
   for fuzzy strings. The key that produced each candidate pair is stored on
   the `MatchDecision`.
3. **Score.** Fellegi–Sunter via Splink. Comparison levels per field: exact,
   near (Jaro-Winkler bands, Levenshtein), array intersection, date proximity,
   geospatial proximity. m and u trained by EM on unlabelled data, then
   calibrated on the fixture set. Output is integer basis points, 0–10000.
4. **Threshold.** Two, per deployment and per entity kind.
   At or above `RESOLUTION_MATCH_THRESHOLD`: MATCH. Below
   `RESOLUTION_REVIEW_THRESHOLD`: NON_MATCH. Between: REVIEW. A score with no
   basis: INDETERMINATE. `refuseForcedResolution()` rejects a configuration
   where match ≤ review, on both the TypeScript and Python sides.
5. **Cluster.** Connected components over MATCH edges, with the transitivity
   guard: A–B and B–C matched but A–C is NON_MATCH means the cluster is
   `DISPUTED` and goes to review. It is not merged.
6. **Persist.** `Entity`, `EntityMember`, one `MatchDecision` per pair
   evaluated including non-matches, and a `ResolutionRun` tying them together
   with model and normalizer versions.

## Reversibility

`EntityMember` rows are superseded, never deleted. A split creates a new entity
and an audit event; the observations keep their whole membership history.
Human adjudications live in their own table, keyed by the unordered pair, and
the resolver reads them before scoring: a pinned decision outranks the model
on every re-run.

## Adjudicating a pair

The review queue shows the two records side by side, each field marked agree,
near or differ, the per-field match weights in plain words ("email matched
exactly: strong evidence for; names differ after normalization: moderate
evidence against"), and three buttons: match, non-match, indeterminate. The
choice, who made it and a note are recorded. Indeterminate is a real answer
and stays in the queue as such.

## Where it lives

| Step | File |
|---|---|
| Normalizers, version `norm-1` | `services/resolution/resolution/normalize.py` |
| Blocking keys (exact ids, metaphone+city, geohash5+day, trigram MinHash band) | `blocking.py`, `records.py` |
| Splink settings per kind, EM training, prediction with per-field levels and Bayes factors | `model.py`, models in `services/resolution/models/*.json` |
| Thresholds, pins, connected components, transitivity guard | `cluster.py` |
| `POST /resolve` | `main.py` |
| Persistence: `ResolutionRun`, `MatchDecision`, `Entity`, `EntityMember` | `apps/api/src/v2/resolution.ts`, `POST /v2/resolve` |
| Review queue and pins | `GET /v2/review`, `POST /v2/adjudicate` |

Metaphone rather than Double Metaphone: `jellyfish` ships the former. Address
parsing is the simple expander unless libpostal is present; the version says
which ran.

## Evaluation

`services/resolution/eval/evaluate.py` resolves the synthetic fixture from the
file alone and reports, per kind: blocking recall (were the true pairs even
compared), pair precision/recall/F1 on MATCH decisions, cluster-level
precision/recall on what was actually merged, review-band load, and disputed
clusters. `--train` fits the models; `--write-baseline` records the numbers;
`--check` fails when recall drops more than 0.005 below the baseline unless
`--override "reason"` is given. `pnpm eval:resolution` runs the check. There
is no CI in this repository yet; the gate is a command until there is.
