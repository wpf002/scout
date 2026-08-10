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
  /**
   * viewBox fitted to where the nodes actually landed, plus room for labels.
   *
   * A fixed viewBox clipped every label on the outer edge, because a label is
   * drawn beyond the node it belongs to and nothing accounted for its width.
   */
  viewBox: string;
}

/**
 * Types worth drawing, in the order their clusters are placed.
 *
 * Clusters rather than rings. A ring layout put every node on a circle around
 * the subject, which meant a hundred spokes crossing each other and no visible
 * structure — the picture said "many things were found" and nothing else.
 * Grouping by type means the shape itself carries information: a wide email
 * cluster and a thin host cluster is a readable fact about the target.
 */
const CLUSTER_ORDER = [
  "Threat Intel",
  "Organization",
  "Emails",
  "Hosts",
  "Web Scans",
  "Subdomains",
  "Profiles",
  "Certificates",
  "Dataset Hits",
];

/**
 * Total nodes drawn.
 *
 * Held low deliberately. The previous cap allowed roughly 110 and produced an
 * unreadable hairball; the graph is for seeing structure, and the table is
 * where completeness lives. Anything not drawn is stated on screen.
 */
const MAX_NODES = 54;

/** Nodes from any one type, so a 400-subdomain domain cannot crowd out the rest. */
const MAX_PER_TYPE = 14;

const WIDTH = 1000;
const HEIGHT = 640;

export interface GraphResult extends Graph {
  /** Nodes omitted to keep the picture legible, by type. */
  omitted: { type: string; count: number }[];
}

/** Enough to read, short enough not to collide with its neighbour. */
function shorten(label: string): string {
  if (label.length <= 22) return label;
  return `${label.slice(0, 21)}…`;
}

export function buildGraph(rows: ResultRow[], subject: string): GraphResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const omitted: { type: string; count: number }[] = [];

  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;

  nodes.push({
    id: "subject",
    label: shorten(subject),
    type: "Subject",
    weight: 1,
    x: cx,
    y: cy,
    radius: 10,
    row: null,
  });

  const byType = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byType.get(row.type);
    if (list === undefined) byType.set(row.type, [row]);
    else list.push(row);
  }

  // Decide what is drawn before deciding where, so the layout can size each
  // cluster's sector to what it actually holds.
  const clusters: { type: string; rows: ResultRow[] }[] = [];
  let budget = MAX_NODES;

  for (const type of CLUSTER_ORDER) {
    const all = byType.get(type);
    if (all === undefined || all.length === 0) continue;

    // Most corroborated first: a value three sources agree on is the one worth
    // the space.
    const sorted = [...all].sort((a, b) => b.sources.length - a.sources.length);
    const take = Math.max(0, Math.min(MAX_PER_TYPE, budget));
    const kept = sorted.slice(0, take);
    budget -= kept.length;

    if (sorted.length > kept.length) {
      omitted.push({ type, count: sorted.length - kept.length });
    }
    if (kept.length > 0) clusters.push({ type, rows: kept });
  }

  const drawn = clusters.reduce((total, c) => total + c.rows.length, 0);
  let placed = 0;

  for (const cluster of clusters) {
    // Each cluster gets a slice of the circle proportional to its size, so a
    // large group spreads rather than stacking.
    const share = cluster.rows.length / Math.max(1, drawn);
    const start = (placed / Math.max(1, drawn)) * Math.PI * 2 - Math.PI / 2;
    const span = share * Math.PI * 2;
    placed += cluster.rows.length;

    cluster.rows.forEach((row, index) => {
      // Two arcs per cluster: a compact group reads as one thing, where a
      // single long arc reads as more spokes.
      const lane = index % 2;
      const withinLane = Math.floor(index / 2);
      const perLane = Math.ceil(cluster.rows.length / 2);
      const t = perLane <= 1 ? 0.5 : withinLane / (perLane - 1);

      const angle = start + span * (0.12 + t * 0.76);
      const radius = 150 + lane * 78;
      const id = `${cluster.type}:${row.value}`;

      nodes.push({
        id,
        label: shorten(row.value),
        type: cluster.type,
        weight: row.sources.length,
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius * 0.82,
        radius: Math.min(9, 4 + row.sources.length),
        row,
      });

      edges.push({
        from: "subject",
        to: id,
        reason: `${row.sources.join(", ")} reported this ${cluster.type.toLowerCase().replace(/s$/, "")}`,
      });
    });
  }

  // Host-to-name edges: the relationship the table cannot express. A host row
  // names the hostnames seen on it, so where both are drawn they get joined.
  const byLabel = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.row !== null) byLabel.set(node.row.value.toLowerCase(), node);
  }

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

  // Fit the frame to the drawing rather than the other way round. Labels sit
  // above and either side of their node, so the padding is asymmetric — wider
  // horizontally, where a truncated hostname still runs ~90px.
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs) - 95;
  const maxX = Math.max(...xs) + 95;
  const minY = Math.min(...ys) - 26;
  const maxY = Math.max(...ys) + 18;

  return {
    nodes,
    edges,
    width: WIDTH,
    height: HEIGHT,
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    omitted,
  };
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
