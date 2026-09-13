/**
 * The temporal graph, without a graph database.
 *
 * Apache AGE was the spec's projection layer. It is not used: Railway's
 * managed Postgres cannot load the extension, and nothing in the reasoning
 * layer needs openCypher, because the planner selects from a fixed set of
 * typed operations rather than emitting query text. Edges and memberships
 * live in ordinary tables and every query carries an `asOf` predicate.
 *
 * Two clocks, both required for "exactly the graph as it was known at T":
 *
 *   valid time     — validFrom / validUntil: when the relationship held.
 *   knowledge time — createdAt / supersededAt: when Scout knew about it.
 *
 * An edge learned yesterday about last month is visible at asOf = last month
 * only if you ask "what held then", and visible at asOf = today only if you
 * ask "what did we know then". The console's scrubber asks the second
 * question, so both predicates apply.
 */

export interface TemporalRow {
  validFrom: Date;
  validUntil: Date | null;
  createdAt: Date;
  supersededAt: Date | null;
}

/** True when the row both held at `asOf` and was known to Scout by `asOf`. */
export function knownAt(row: TemporalRow, asOf: Date): boolean {
  const held =
    row.validFrom <= asOf && (row.validUntil === null || row.validUntil > asOf);
  const known =
    row.createdAt <= asOf && (row.supersededAt === null || row.supersededAt > asOf);
  return held && known;
}

/**
 * The same predicate as SQL, for raw queries. `param` is the positional
 * placeholder holding `asOf` (e.g. `$1`), and `alias` the table alias.
 */
export function asOfSql(alias: string, param: string): string {
  return (
    `${alias}."validFrom" <= ${param} AND (${alias}."validUntil" IS NULL OR ${alias}."validUntil" > ${param})` +
    ` AND ${alias}."createdAt" <= ${param} AND (${alias}."supersededAt" IS NULL OR ${alias}."supersededAt" > ${param})`
  );
}
