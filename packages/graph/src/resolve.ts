import type {
  EntityGraph,
  EntityKind,
  ExtractionResult,
  MergeSuggestion,
  ResolvedEntity,
  ResolvedLink,
} from "./types.js";
import { entityKey } from "./types.js";

/**
 * Builds the graph from extracted mentions and links.
 *
 * Merging here is exact-identity only, after normalization. That is the whole
 * automatic behaviour, and it is deliberately unambitious: two sources
 * reporting the same normalized hostname are reporting the same host, and no
 * tuning against real data is needed to be sure of it. Anything requiring
 * judgement goes to `suggestMerges` instead.
 *
 * Attribution is a union throughout. An entity seen by crt.sh and Shodan names
 * both; a link evidenced by two findings keeps both. Collapsing to a single
 * "best" source would destroy the corroboration the graph exists to show.
 */
export function buildGraph(extraction: ExtractionResult): EntityGraph {
  const entities = new Map<string, ResolvedEntity>();

  for (const mention of extraction.mentions) {
    const key = entityKey(mention.entity);
    const existing = entities.get(key);

    if (existing === undefined) {
      entities.set(key, {
        key,
        kind: mention.entity.kind,
        value: mention.entity.value,
        label: mention.entity.label ?? null,
        sourceIds: [mention.sourceId],
        findingIds: [mention.findingId],
        firstSeen: mention.observedAt,
        lastSeen: mention.observedAt,
      });
      continue;
    }

    if (!existing.sourceIds.includes(mention.sourceId)) {
      existing.sourceIds.push(mention.sourceId);
    }
    if (!existing.findingIds.includes(mention.findingId)) {
      existing.findingIds.push(mention.findingId);
    }
    if (mention.observedAt < existing.firstSeen) {
      existing.firstSeen = mention.observedAt;
    }
    if (mention.observedAt > existing.lastSeen) {
      existing.lastSeen = mention.observedAt;
    }
    // Prefer a human-readable label if one turns up later.
    if (existing.label === null && mention.entity.label !== undefined) {
      existing.label = mention.entity.label;
    }
  }

  const links = new Map<string, ResolvedLink>();
  for (const link of extraction.links) {
    const from = entityKey(link.from);
    const to = entityKey(link.to);
    // A link to an entity no mention created would be an edge to nowhere.
    if (!entities.has(from) || !entities.has(to)) continue;

    const key = `${from}|${link.relation}|${to}`;
    const existing = links.get(key);
    if (existing === undefined) {
      links.set(key, {
        from,
        to,
        relation: link.relation,
        findingIds: [link.findingId],
        sourceIds: [link.sourceId],
      });
      continue;
    }
    if (!existing.findingIds.includes(link.findingId)) {
      existing.findingIds.push(link.findingId);
    }
    if (!existing.sourceIds.includes(link.sourceId)) {
      existing.sourceIds.push(link.sourceId);
    }
  }

  const resolved = [...entities.values()].sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  return {
    entities: resolved,
    links: [...links.values()].sort((a, b) =>
      `${a.from}${a.relation}${a.to}`.localeCompare(`${b.from}${b.relation}${b.to}`),
    ),
    // The exit gate's number: entities more than one source agreed on.
    corroborated: resolved.filter((entity) => entity.sourceIds.length > 1)
      .length,
  };
}

/** Kinds where a near-match is worth surfacing at all. */
const FUZZY_KINDS: readonly EntityKind[] = ["person", "company"];

/** Casefold, strip punctuation and common company suffixes, collapse space. */
function nameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,'"()]/g, " ")
    .replace(
      /\b(ltd|limited|llc|inc|incorporated|corp|corporation|gmbh|sa|sas|bv|plc|co)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(nameKey(value).split(" ").filter((t) => t.length > 1));
}

/**
 * Proposes merges an operator must confirm.
 *
 * This is where the missing defer criterion bites, so it is kept deliberately
 * timid. It proposes only two things:
 *
 *   - names identical once casing, punctuation and company suffixes are
 *     removed ("Acme Ltd." vs "ACME LIMITED");
 *   - one name's tokens being a strict subset of another's ("Jane Designated"
 *     vs "Jane Designated Jr").
 *
 * It does not do edit distance, phonetics or nicknames. Those are exactly the
 * heuristics that need real overlapping cases to calibrate, and an
 * uncalibrated one produces confident nonsense about real people.
 *
 * Nothing here merges anything. The output is a queue of questions.
 */
export function suggestMerges(graph: EntityGraph): MergeSuggestion[] {
  const suggestions: MergeSuggestion[] = [];

  for (const kind of FUZZY_KINDS) {
    const candidates = graph.entities.filter((entity) => entity.kind === kind);

    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const left = candidates[i];
        const right = candidates[j];
        if (left === undefined || right === undefined) continue;

        const leftName = left.label ?? left.value;
        const rightName = right.label ?? right.value;
        const leftKey = nameKey(leftName);
        const rightKey = nameKey(rightName);
        if (leftKey.length === 0 || rightKey.length === 0) continue;

        if (leftKey === rightKey) {
          suggestions.push({
            id: `${left.key}::${right.key}`,
            kind,
            left: left.key,
            right: right.key,
            reason:
              "Identical once casing, punctuation and company suffixes are ignored.",
            confidence: 0.9,
          });
          continue;
        }

        const leftTokens = tokens(leftName);
        const rightTokens = tokens(rightName);
        if (leftTokens.size === 0 || rightTokens.size === 0) continue;

        const smaller = leftTokens.size <= rightTokens.size ? leftTokens : rightTokens;
        const larger = smaller === leftTokens ? rightTokens : leftTokens;
        const contained = [...smaller].every((token) => larger.has(token));

        if (contained && smaller.size >= 2) {
          suggestions.push({
            id: `${left.key}::${right.key}`,
            kind,
            left: left.key,
            right: right.key,
            reason: `Every word of "${smaller === leftTokens ? leftName : rightName}" appears in the other name.`,
            confidence: 0.6,
          });
        }
      }
    }
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Applies confirmed merges to a graph.
 *
 * `merges` maps a losing entity key to the key it was merged into — decisions
 * an operator already made and that are stored, so a rebuild does not ask
 * again. Evidence is unioned rather than discarded: a merged entity keeps
 * every source and finding from both sides, because the point of merging is
 * to gather evidence, not to lose half of it.
 */
export function applyMerges(
  graph: EntityGraph,
  merges: ReadonlyMap<string, string>,
): EntityGraph {
  if (merges.size === 0) return graph;

  const canonical = (key: string): string => {
    const seen = new Set<string>();
    let current = key;
    while (merges.has(current) && !seen.has(current)) {
      seen.add(current);
      current = merges.get(current) ?? current;
    }
    return current;
  };

  const merged = new Map<string, ResolvedEntity>();
  for (const entity of graph.entities) {
    const target = canonical(entity.key);
    const existing = merged.get(target);
    if (existing === undefined) {
      merged.set(target, { ...entity, key: target });
      continue;
    }
    existing.sourceIds = [
      ...new Set([...existing.sourceIds, ...entity.sourceIds]),
    ];
    existing.findingIds = [
      ...new Set([...existing.findingIds, ...entity.findingIds]),
    ];
    if (entity.firstSeen < existing.firstSeen) existing.firstSeen = entity.firstSeen;
    if (entity.lastSeen > existing.lastSeen) existing.lastSeen = entity.lastSeen;
    existing.label = existing.label ?? entity.label;
  }

  const links = new Map<string, ResolvedLink>();
  for (const link of graph.links) {
    const from = canonical(link.from);
    const to = canonical(link.to);
    // A merge can turn an edge into a self-loop; that says nothing.
    if (from === to) continue;
    if (!merged.has(from) || !merged.has(to)) continue;

    const key = `${from}|${link.relation}|${to}`;
    const existing = links.get(key);
    if (existing === undefined) {
      links.set(key, { ...link, from, to });
      continue;
    }
    existing.findingIds = [
      ...new Set([...existing.findingIds, ...link.findingIds]),
    ];
    existing.sourceIds = [...new Set([...existing.sourceIds, ...link.sourceIds])];
  }

  const entities = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    entities,
    links: [...links.values()],
    corroborated: entities.filter((e) => e.sourceIds.length > 1).length,
  };
}
