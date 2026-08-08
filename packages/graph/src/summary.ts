import type { EntityGraph, FindingInput, ResolvedEntity } from "./types.js";

/**
 * Case summarization.
 *
 * The roadmap allows a drafted case summary under three conditions: summaries
 * are drafts, never findings, and never invent provenance. Those conditions
 * shape this module entirely.
 *
 * Two pieces:
 *
 *   1. A deterministic summary, built by counting the graph. It is the default
 *      and needs nothing configured, because every sentence is a fact about
 *      rows that exist — there is no mechanism here by which it could invent
 *      something.
 *   2. A `Summarizer` extension point, for wiring in a different implementation
 *      later. No implementation ships, and the interesting part is not the
 *      interface but the guard around it.
 *
 * Whatever produces it, a summary is a `draft` and is stored apart from
 * findings. A finding is something a source reported; a summary is something
 * someone wrote about them.
 */

export interface CaseSummary {
  /** Always true. A summary is never promoted to a finding. */
  draft: true;
  /** Which summarizer produced this. `deterministic` unless one is wired in. */
  producedBy: string;
  generatedAt: string;
  headline: string;
  paragraphs: string[];
  /**
   * Findings the summary is derived from. Any summarizer must cite from this
   * set and nothing else — it is what "never invent provenance" reduces to
   * mechanically.
   */
  citedFindingIds: string[];
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

function describeEntity(entity: ResolvedEntity): string {
  const name = entity.label ?? entity.value;
  return `${name} (${entity.kind}, seen by ${entity.sourceIds.sort().join(", ")})`;
}

/**
 * Builds a summary by counting. Nothing to configure, and nothing that could
 * invent a claim.
 *
 * This is the default because a summary that is merely accurate is more useful
 * than one that is fluent and occasionally wrong about a person.
 */
export function summarizeDeterministically(
  graph: EntityGraph,
  findings: readonly FindingInput[],
  options: { generatedAt?: string } = {},
): CaseSummary {
  const sources = [...new Set(findings.map((f) => f.sourceId))].sort();
  const byKind = new Map<string, number>();
  for (const entity of graph.entities) {
    byKind.set(entity.kind, (byKind.get(entity.kind) ?? 0) + 1);
  }

  const corroborated = graph.entities
    .filter((entity) => entity.sourceIds.length > 1)
    .sort((a, b) => b.sourceIds.length - a.sourceIds.length);

  const paragraphs: string[] = [];

  paragraphs.push(
    `The case holds ${plural(findings.length, "saved finding")} from ` +
      `${plural(sources.length, "source")} (${sources.join(", ")}), resolving to ` +
      `${plural(graph.entities.length, "entity", "entities")} and ` +
      `${plural(graph.links.length, "relationship")}.`,
  );

  const kindBreakdown = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  if (kindBreakdown.length > 0) {
    paragraphs.push(`Entities by kind: ${kindBreakdown}.`);
  }

  if (corroborated.length === 0) {
    paragraphs.push(
      "No entity was reported by more than one source, so nothing here is " +
        "corroborated. Treat every entity as a single-source observation.",
    );
  } else {
    const top = corroborated.slice(0, 5).map(describeEntity).join("; ");
    paragraphs.push(
      `${plural(corroborated.length, "entity", "entities")} ${
        corroborated.length === 1 ? "was" : "were"
      } reported by more than one source: ${top}${
        corroborated.length > 5 ? "; and others" : ""
      }.`,
    );
  }

  const singleSource = graph.entities.length - corroborated.length;
  if (singleSource > 0 && corroborated.length > 0) {
    paragraphs.push(
      `The remaining ${plural(singleSource, "entity", "entities")} ` +
        `${singleSource === 1 ? "rests" : "rest"} on a single source.`,
    );
  }

  return {
    draft: true,
    producedBy: "deterministic",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    headline:
      corroborated.length > 0
        ? `${plural(graph.entities.length, "entity", "entities")}, ${corroborated.length} corroborated across sources`
        : `${plural(graph.entities.length, "entity", "entities")}, none corroborated`,
    paragraphs,
    citedFindingIds: findings.map((f) => f.id),
  };
}

/**
 * An alternative summarizer.
 *
 * An implementation receives the graph and the findings it may cite, and must
 * return a summary whose `citedFindingIds` is a subset of what it was given.
 * `assertNoInventedProvenance` enforces that on the way out, so a summarizer
 * that cites a finding which does not exist fails loudly rather than producing
 * a plausible document.
 */
export interface Summarizer {
  name: string;
  summarize(input: {
    graph: EntityGraph;
    findings: readonly FindingInput[];
  }): Promise<CaseSummary>;
}

/**
 * Throws if a summary cites a finding it was not given.
 *
 * This is what makes "never invent provenance" a property rather than an
 * intention. Any summarizer wired in later is checked by it on the way out.
 */
export function assertNoInventedProvenance(
  summary: CaseSummary,
  findings: readonly FindingInput[],
): CaseSummary {
  const available = new Set(findings.map((f) => f.id));
  const invented = summary.citedFindingIds.filter((id) => !available.has(id));
  if (invented.length > 0) {
    throw new Error(
      `Summary cited ${invented.length} finding(s) that do not exist on this case: ${invented.join(", ")}`,
    );
  }
  if (summary.draft !== true) {
    throw new Error("A summary must be marked as a draft.");
  }
  return summary;
}

/**
 * Runs a configured summarizer, falling back to the deterministic one.
 *
 * No summarizer configured is not an error and does not produce a blank — it
 * produces the counted summary, which is a complete answer on its own.
 */
export async function summarizeCase(
  graph: EntityGraph,
  findings: readonly FindingInput[],
  summarizer: Summarizer | null = null,
): Promise<CaseSummary> {
  if (summarizer === null) {
    return summarizeDeterministically(graph, findings);
  }
  const summary = await summarizer.summarize({ graph, findings });
  return assertNoInventedProvenance(summary, findings);
}
