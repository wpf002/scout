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

/**
 * True when the row held at `asOf` and was known to Scout by `knownAs`.
 *
 * The two default to the same instant, which is the strict "exactly as it
 * was known at T". Passing `knownAs = now` with an earlier `asOf` asks the
 * other useful question: given everything known today, what held at T. A
 * co-location learned after it ended is invisible under the first reading at
 * every T, and visible under the second at the T it happened; the console
 * scrubber asks the second, the audit trail the first.
 */
export function knownAt(row: TemporalRow, asOf: Date, knownAs: Date = asOf): boolean {
  const held =
    row.validFrom <= asOf && (row.validUntil === null || row.validUntil > asOf);
  const known =
    row.createdAt <= knownAs && (row.supersededAt === null || row.supersededAt > knownAs);
  return held && known;
}

/**
 * The same predicate as SQL, for raw queries. `asOf` and `knownAs` are the
 * positional placeholders holding the two instants (e.g. `$1`, `$2`); pass
 * `asOf: null` to apply the knowledge clock only.
 */
export function asOfSql(alias: string, asOf: string | null, knownAs: string = asOf ?? "$1"): string {
  const held =
    asOf === null
      ? "TRUE"
      : `${alias}."validFrom" <= ${asOf} AND (${alias}."validUntil" IS NULL OR ${alias}."validUntil" > ${asOf})`;
  const known = `${alias}."createdAt" <= ${knownAs} AND (${alias}."supersededAt" IS NULL OR ${alias}."supersededAt" > ${knownAs})`;
  return `${held} AND ${known}`;
}
