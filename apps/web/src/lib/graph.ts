import type { ResultRow } from "./flatten";

/**
 * The result set as an entity graph.
 *
 * The table answers "what was found". It cannot answer "what is connected to
 * what" — that a host carries four subdomains, that two subdomains share an
 * address, that a certificate covers both. Those relationships are already in
 * the data; the table just has no way to draw them.
 *
 * Layout is deterministic rather than a physics simulation. A force layout
 * looks impressive and settles somewhere different on every run, which means
 * an investigator cannot return to a graph they were reading five minutes ago
 * and find it. Nodes are placed on rings by type, ordered within the ring, so
 * the same result set always draws the same picture.
 */

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  /** How many sources reported it — drives node size. */
  weight: number;
  x: number;
  y: number;
  radius: number;
  row: ResultRow | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Why these two are connected, shown on hover. */
  reason: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

/** Types worth drawing, in ring order outward from the subject. */
const RINGS = [
  ["Threat Intel", "Organization"],
  ["Hosts", "Emails"],
  ["Subdomains", "Web Scans"],
  ["Certificates", "Dataset Hits", "Profiles"],
];

/**
 * Nodes per ring.
 *
 * A domain routinely has 400 subdomains and drawing all of them produces a
 * black disc, not a graph. The most-corroborated are kept — a value several
 * sources agree on is the one worth looking at first — and the count of what
 * was dropped is reported rather than hidden.
 */
const PER_RING = 28;

const WIDTH = 900;
const HEIGHT = 620;

export interface GraphResult extends Graph {
  /** Nodes omitted to keep the picture legible, by type. */
  omitted: { type: string; count: number }[];
}

export function buildGraph(rows: ResultRow[], subject: string): GraphResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const omitted: { type: string; count: number }[] = [];

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;

  nodes.push({
    id: "subject",
    label: subject,
    type: "Subject",
    weight: 1,
    x: cx,
    y: cy,
    radius: 9,
    row: null,
  });

  const byType = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byType.get(row.type);
    if (list === undefined) byType.set(row.type, [row]);
    else list.push(row);
  }

  RINGS.forEach((types, ringIndex) => {
    const present = types.filter((type) => (byType.get(type)?.length ?? 0) > 0);
    if (present.length === 0) return;

    const inRing: { row: ResultRow; type: string }[] = [];
    for (const type of present) {
      const all = byType.get(type) ?? [];
      // Most corroborated first: a value three sources agree on outranks one
      // only a single source saw.
      const sorted = [...all].sort(
        (a, b) => b.sources.length - a.sources.length,
      );
      const kept = sorted.slice(0, PER_RING);
      if (sorted.length > kept.length) {
        omitted.push({ type, count: sorted.length - kept.length });
      }
      for (const row of kept) inRing.push({ row, type });
    }

    const radius = 90 + ringIndex * 78;
    inRing.forEach((entry, index) => {
      // Half-step offset per ring so nodes do not line up radially and
      // overlap their neighbours on the ring outside them.
      const angle =
        (index / inRing.length) * Math.PI * 2 + ringIndex * 0.35 - Math.PI / 2;
      const id = `${entry.type}:${entry.row.value}`;

      nodes.push({
        id,
        label: entry.row.value,
        type: entry.type,
        weight: entry.row.sources.length,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
        radius: Math.min(8, 3.5 + entry.row.sources.length),
        row: entry.row,
      });

      edges.push({
        from: "subject",
        to: id,
        reason: `${entry.row.sources.join(", ")} reported this ${entry.type.toLowerCase().replace(/s$/, "")}`,
      });
    });
  });

  // Host-to-name edges: the relationship the table cannot express. A host row
  // names the hostnames seen on it, so where both are drawn they get joined.
  const byLabel = new Map(nodes.map((node) => [node.label.toLowerCase(), node]));
  for (const node of nodes) {
    if (node.type !== "Hosts" || node.row === null) continue;

    for (const item of node.row.evidence) {
      const observation = item.observation as { hostnames?: unknown };
      if (observation === null || typeof observation !== "object") continue;
      const hostnames = Array.isArray(observation.hostnames)
        ? observation.hostnames
        : [];

      for (const raw of hostnames) {
        if (typeof raw !== "string") continue;
        const target = byLabel.get(raw.toLowerCase());
        if (target === undefined || target.id === node.id) continue;
        edges.push({
          from: node.id,
          to: target.id,
          reason: `${raw} resolves to ${node.label}`,
        });
      }
    }
  }

  return { nodes, edges, width: WIDTH, height: HEIGHT, omitted };
}

/** Colour per type, matching the rest of the surface. */
export const TYPE_COLOR: Record<string, string> = {
  Subject: "var(--brand)",
  "Threat Intel": "var(--deny)",
  Organization: "var(--warn)",
  Hosts: "var(--ok)",
  Emails: "var(--scoped)",
  Subdomains: "var(--text-dim)",
  "Web Scans": "var(--warn)",
  Certificates: "var(--text-faint)",
  "Dataset Hits": "var(--text-faint)",
  Profiles: "var(--scoped)",
};
