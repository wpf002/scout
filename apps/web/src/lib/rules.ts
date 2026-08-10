import type { ResultRow } from "./flatten";

/**
 * Correlation rules — the layer between volume and findings.
 *
 * A run produces 800 observations. Reading all of them is not analysis, it is
 * data entry, and the things that matter are exactly the things easiest to
 * miss in a long table: the certificate that expired last month, the host in a
 * threat report, the admin panel answering on a public address.
 *
 * Every rule states what it saw and why it matters, and points at the rows it
 * fired on. None of them assert impact — "an expired certificate" is a fact,
 * "you are vulnerable" is a conclusion belonging to whoever is running the
 * engagement and knows the context.
 */

export type Severity = "high" | "medium" | "low";

export interface Insight {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Values the rule fired on, so it can be checked rather than trusted. */
  evidence: string[];
}

/** Ports that should raise an eyebrow when they answer on a public address. */
const SENSITIVE_PORTS = new Map<number, string>([
  [21, "FTP"],
  [22, "SSH"],
  [23, "Telnet"],
  [445, "SMB"],
  [1433, "MSSQL"],
  [2375, "Docker API"],
  [3306, "MySQL"],
  [3389, "RDP"],
  [5432, "Postgres"],
  [5900, "VNC"],
  [6379, "Redis"],
  [9200, "Elasticsearch"],
  [27017, "MongoDB"],
]);

/** Hostname markers for environments not usually meant to be found. */
const NON_PROD = /\b(dev|test|stag|staging|uat|qa|preprod|sandbox|internal|admin|vpn|jenkins|gitlab|jira|grafana|kibana)\b/;

const observationsOf = (row: ResultRow): Record<string, unknown>[] =>
  row.evidence
    .map((item) => item.observation)
    .filter(
      (observation): observation is Record<string, unknown> =>
        typeof observation === "object" && observation !== null,
    );

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function analyze(rows: ResultRow[], subject: string): Insight[] {
  const insights: Insight[] = [];
  const by = (type: string) => rows.filter((row) => row.type === type);

  // ── Threat associations ──────────────────────────────────────────────────
  const threats = by("Threat Intel");
  if (threats.length > 0) {
    insights.push({
      id: "threat-intel",
      severity: "high",
      title: `Named in ${threats.length} threat report${threats.length === 1 ? "" : "s"}`,
      detail:
        "This indicator appears in threat intelligence. That is a claim by the " +
        "report's author, not a verdict — read the reports before acting on them.",
      evidence: threats.map((row) => row.value).slice(0, 8),
    });
  }

  // ── Reputation ───────────────────────────────────────────────────────────
  const reputation = by("Reputation");
  const flagged: string[] = [];
  const scanners: string[] = [];

  for (const row of reputation) {
    for (const observation of observationsOf(row)) {
      const verdict = String(observation["verdict"] ?? "");
      if (observation["benign"] === true) continue;
      if (observation["noise"] === true) {
        scanners.push(`${row.value} — ${verdict}`);
        continue;
      }
      if (/command-and-control|malicious/i.test(verdict)) {
        flagged.push(`${row.value} — ${verdict}`);
      }
    }
  }

  if (flagged.length > 0) {
    insights.push({
      id: "bad-reputation",
      severity: "high",
      title: `${new Set(flagged).size} address${new Set(flagged).size === 1 ? "" : "es"} flagged by a reputation service`,
      detail:
        "Listed as hostile by a third party. On shared hosting this can describe " +
        "a neighbour rather than the target — check what else resolves to the " +
        "address before drawing a conclusion.",
      evidence: [...new Set(flagged)].slice(0, 8),
    });
  }

  if (scanners.length > 0) {
    insights.push({
      id: "scanner-noise",
      severity: "low",
      title: `${new Set(scanners).size} address${new Set(scanners).size === 1 ? "" : "es"} are internet-wide scanners`,
      detail:
        "Indiscriminate scanning, not activity aimed at this target. Noted so " +
        "it can be set aside rather than investigated.",
      evidence: [...new Set(scanners)].slice(0, 6),
    });
  }

  // ── Known vulnerabilities ────────────────────────────────────────────────
  const vulnerable: string[] = [];
  for (const row of by("Hosts")) {
    for (const observation of observationsOf(row)) {
      for (const cve of strings(observation["vulns"])) {
        vulnerable.push(`${row.value} — ${cve}`);
      }
    }
  }
  if (vulnerable.length > 0) {
    insights.push({
      id: "cves",
      severity: "high",
      title: `${vulnerable.length} CVE match${vulnerable.length === 1 ? "" : "es"} on reachable hosts`,
      detail:
        "A scanner matched these hosts to known CVEs from banner data. Banner " +
        "matching produces false positives; confirm before reporting.",
      evidence: [...new Set(vulnerable)].slice(0, 10),
    });
  }

  // ── Sensitive services ───────────────────────────────────────────────────
  const exposed: string[] = [];
  for (const row of by("Hosts")) {
    for (const observation of observationsOf(row)) {
      for (const port of numbers(observation["ports"])) {
        const name = SENSITIVE_PORTS.get(port);
        if (name !== undefined) exposed.push(`${row.value}:${port} (${name})`);
      }
    }
  }
  if (exposed.length > 0) {
    insights.push({
      id: "sensitive-ports",
      severity: "high",
      title: `${new Set(exposed).size} sensitive service${new Set(exposed).size === 1 ? "" : "s"} reachable`,
      detail:
        "Databases, remote access and management services answering on a public " +
        "address. Some are deliberate and fronted by controls a port scan cannot see.",
      evidence: [...new Set(exposed)].slice(0, 10),
    });
  }

  // ── Expired certificates ─────────────────────────────────────────────────
  const now = Date.now();
  const expired: string[] = [];
  const expiringSoon: string[] = [];

  for (const row of by("Certificates")) {
    for (const observation of observationsOf(row)) {
      const notAfter = observation["notAfter"];
      if (typeof notAfter !== "string") continue;
      const at = Date.parse(notAfter);
      if (Number.isNaN(at)) continue;

      const days = Math.round((at - now) / 86_400_000);
      if (days < 0) expired.push(`${row.value} (${Math.abs(days)}d ago)`);
      else if (days <= 30) expiringSoon.push(`${row.value} (${days}d)`);
    }
  }

  if (expired.length > 0) {
    insights.push({
      id: "expired-certs",
      severity: "medium",
      title: `${new Set(expired).size} expired certificate${new Set(expired).size === 1 ? "" : "s"}`,
      detail:
        "Certificate Transparency shows these past their validity. A log entry " +
        "is not proof the certificate is still being served.",
      evidence: [...new Set(expired)].slice(0, 8),
    });
  }
  if (expiringSoon.length > 0) {
    insights.push({
      id: "expiring-certs",
      severity: "low",
      title: `${new Set(expiringSoon).size} certificate${new Set(expiringSoon).size === 1 ? "" : "s"} expiring within 30 days`,
      detail: "Renewal due, or already renewed and not yet reflected in the logs.",
      evidence: [...new Set(expiringSoon)].slice(0, 8),
    });
  }

  // ── Non-production surface ───────────────────────────────────────────────
  const nonProd = by("Subdomains")
    .map((row) => row.value)
    .filter((value) => NON_PROD.test(value));

  if (nonProd.length > 0) {
    insights.push({
      id: "non-prod",
      severity: "medium",
      title: `${nonProd.length} non-production host${nonProd.length === 1 ? "" : "s"} discoverable`,
      detail:
        "Staging, admin and internal-looking names are publicly enumerable. They " +
        "are often less hardened than production and rarely meant to be found.",
      evidence: nonProd.slice(0, 10),
    });
  }

  // ── People ───────────────────────────────────────────────────────────────
  const named = by("Emails").filter((row) => /·/.test(row.detail) && !/Unattributed|Shared/.test(row.detail));
  if (named.length > 0) {
    insights.push({
      id: "named-people",
      severity: "medium",
      title: `${named.length} named individual${named.length === 1 ? "" : "s"} with addresses`,
      detail:
        "Names, roles and working addresses — the raw material for a phishing " +
        "pretext. Worth knowing what is public before someone else uses it.",
      evidence: named.map((row) => `${row.value} — ${row.detail}`).slice(0, 8),
    });
  }

  // ── Breach exposure ──────────────────────────────────────────────────────
  const breaches = by("Breaches");
  if (breaches.length > 0) {
    insights.push({
      id: "breaches",
      severity: "high",
      title: `Appears in ${breaches.length} breach${breaches.length === 1 ? "" : "es"}`,
      detail: "Credentials associated with this subject have been exposed publicly.",
      evidence: breaches.map((row) => row.value).slice(0, 8),
    });
  }

  // ── Domain age ───────────────────────────────────────────────────────────
  for (const row of by("Web Scans")) {
    for (const observation of observationsOf(row)) {
      const age = observation["domainAgeDays"];
      if (typeof age !== "number" || age >= 90) continue;
      insights.push({
        id: "young-domain",
        severity: "medium",
        title: `Domain registered ${age} days ago`,
        detail:
          "Recently registered domains are disproportionately used for phishing " +
          "and fraud. Ordinary for a new business, notable for anything else.",
        evidence: [subject],
      });
      break;
    }
    break;
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return insights.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
