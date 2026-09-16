import type { EntityGraph, FindingInput } from "./types.js";

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

  // Counts, not a roll-call. The full source list ran to thirty names inline
  // and buried the one number that matters — how much is corroborated.
  const kindBreakdown = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  paragraphs.push(
    `${plural(findings.length, "finding")} · ${plural(sources.length, "source")} · ` +
      `${plural(graph.entities.length, "entity", "entities")} · ${plural(graph.links.length, "link")}` +
      (kindBreakdown.length > 0 ? ` (${kindBreakdown})` : ""),
  );

  if (corroborated.length === 0) {
    paragraphs.push("Nothing is corroborated — every entity rests on a single source.");
  } else {
    // Name and count, not the source list per entity.
    const top = corroborated
      .slice(0, 5)
      .map((entity) => `${entity.label ?? entity.value} ×${entity.sourceIds.length}`)
      .join(", ");
    paragraphs.push(
      `${corroborated.length} of ${graph.entities.length} corroborated by 2+ sources. Strongest: ${top}.`,
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
