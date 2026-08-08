import type { EntityGraph, FindingInput, ResolvedEntity } from "./types.js";

/**
 * Case summarization.
 *
 * The roadmap allows an AI-drafted summary, mediated by Flint, with three
 * conditions: summaries are drafts, never findings, and never invent
 * provenance. Those conditions shape this module more than the AI does.
 *
 * Two pieces:
 *
 *   1. A deterministic summary, built by counting the graph. It ships today,
 *      needs no model, and cannot invent anything — every sentence is a fact
 *      about rows that exist.
 *   2. A `Summarizer` seam for Flint. Left INERT rather than implemented
 *      against a guessed API: this codebase has a rule that a source with no
 *      key reports `inert` and never fabricates, and inventing an integration
 *      for a service whose contract I cannot see would break the same rule in
 *      spirit.
 *
 * Whatever produces it, a summary is a `draft` and is stored apart from
 * findings. A finding is something a source reported; a summary is something
 * someone wrote about them.
 */

export interface CaseSummary {
  /** Always true. A summary is never promoted to a finding. */
  draft: true;
  /** `deterministic` or the name of the model that drafted it. */
  producedBy: string;
  generatedAt: string;
  headline: string;
  paragraphs: string[];
  /**
   * Findings the summary is derived from. An AI-drafted summary must cite
   * from this set and nothing else — it is what "never invent provenance"
   * reduces to mechanically.
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
 * Builds a summary by counting. No model, no invention, no configuration.
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
 * The Flint seam.
 *
 * An implementation receives the graph and the findings it may cite, and must
 * return a summary whose `citedFindingIds` is a subset of what it was given —
 * `assertNoInventedProvenance` enforces that on the way out, so a model that
 * cites a finding that does not exist fails loudly rather than producing a
 * plausible document.
 *
 * Model tiering, when this is wired: the cheap tier for mechanical labelling
 * and the stronger one for structural prose, with prompt caching on the graph
 * payload since it is identical across a rebuild.
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
 * "Never invent provenance" is otherwise just an instruction in a prompt, and
 * instructions in prompts are not enforcement.
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
 * produces the counted summary, which is the honest answer to "what does this
 * case say" when no model is available.
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
