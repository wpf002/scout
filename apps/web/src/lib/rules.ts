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

/**
 * Hostname markers for environments not usually meant to be found.
 *
 * Deliberately unanchored. The word-boundary version matched `staging` and
 * missed `hubstg`, `hubdev` and `training1` on the same domain — real
 * non-production hosts, and exactly the ones an operator would want flagged.
 * `qa` and `uat` keep their boundaries because unanchored they would match
 * inside ordinary words.
 */
const NON_PROD =
  /(dev|test|stag|uat\b|\bqa\b|preprod|sandbox|internal|admin|vpn|jenkins|gitlab|jira|grafana|kibana|demo|beta)/;

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
  const expiredBy = new Map<string, number>();
  const soonBy = new Map<string, number>();

  for (const row of by("Certificates")) {
    for (const observation of observationsOf(row)) {
      const notAfter = observation["notAfter"];
      if (typeof notAfter !== "string") continue;
      const at = Date.parse(notAfter);
      if (Number.isNaN(at)) continue;

      // Keyed by host, not by issuance. A host with three certificates in the
      // logs is one certificate problem, and counting issuances turned "one
      // host expiring" into "three certificates expiring".
      const days = Math.round((at - now) / 86_400_000);
      if (days < 0) {
        const seen = expiredBy.get(row.value);
        if (seen === undefined || days < seen) expiredBy.set(row.value, days);
      } else if (days <= 30) {
        const seen = soonBy.get(row.value);
        if (seen === undefined || days < seen) soonBy.set(row.value, days);
      }
    }
  }

  const expired = [...expiredBy.entries()].map(
    ([host, days]) => `${host} (${Math.abs(days)}d ago)`,
  );
  const expiringSoon = [...soonBy.entries()].map(
    ([host, days]) => `${host} (${days}d)`,
  );

  if (expired.length > 0) {
    insights.push({
      id: "expired-certs",
      severity: "medium",
      title: `${expired.length} host${expired.length === 1 ? "" : "s"} with an expired certificate`,
      detail:
        "Certificate Transparency shows these past their validity. A log entry " +
        "is not proof the certificate is still being served.",
      evidence: expired.slice(0, 8),
    });
  }
  if (expiringSoon.length > 0) {
    insights.push({
      id: "expiring-certs",
      severity: "low",
      title: `${expiringSoon.length} host${expiringSoon.length === 1 ? "" : "s"} with a certificate expiring within 30 days`,
      detail: "Renewal due, or already renewed and not yet reflected in the logs.",
      evidence: expiringSoon.slice(0, 8),
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

  // ── Email authentication ─────────────────────────────────────────────────
  //
  // The most checkable finding on this page, and the one most often missing.
  // SPF and DMARC are published in DNS, so a domain either has them or does
  // not — no inference, no false positive.
  const txt = by("DNS Records")
    .filter((row) => row.value.startsWith("TXT"))
    .map((row) => row.value.replace(/^TXT\s+/, "").trim());

  const hasDns = by("DNS Records").length > 0;
  const spf = txt.find((record) => /^v=spf1/i.test(record));
  const dmarc = txt.find((record) => /^v=DMARC1/i.test(record));

  if (hasDns && spf === undefined) {
    insights.push({
      id: "no-spf",
      severity: "medium",
      title: "No SPF record",
      detail:
        "Nothing published saying which servers may send mail as this domain, " +
        "so a receiving server has no sender policy to check against.",
      evidence: [subject],
    });
  }

  if (hasDns && dmarc === undefined) {
    insights.push({
      id: "no-dmarc",
      severity: "medium",
      title: "No DMARC record",
      detail:
        "No published policy for what to do with mail that fails authentication, " +
        "and no reporting address to learn that it is happening.",
      evidence: [subject],
    });
  }

  if (dmarc !== undefined && /p\s*=\s*none/i.test(dmarc)) {
    insights.push({
      id: "dmarc-none",
      severity: "medium",
      title: "DMARC is set to monitor only",
      detail:
        "The policy is `p=none`, so failing mail is still delivered. That is the " +
        "correct first step of a rollout and a common place to stall — it only " +
        "matters if it was meant to have moved on.",
      evidence: [dmarc.slice(0, 120)],
    });
  }

  if (spf !== undefined && /~all/.test(spf)) {
    insights.push({
      id: "spf-softfail",
      severity: "low",
      title: "SPF ends in softfail",
      detail:
        "`~all` asks receivers to accept unauthorised mail and mark it. `-all` " +
        "asks them to reject it. Often deliberate during a migration.",
      evidence: [spf.slice(0, 120)],
    });
  }

  // ── Registration expiry ──────────────────────────────────────────────────
  for (const row of by("Registration")) {
    for (const observation of observationsOf(row)) {
      const expires = observation["expires"];
      if (typeof expires !== "string") continue;
      const at = Date.parse(expires);
      if (Number.isNaN(at)) continue;

      const days = Math.round((at - now) / 86_400_000);
      if (days > 60) continue;

      insights.push({
        id: "domain-expiring",
        severity: days < 0 ? "high" : "medium",
        title:
          days < 0
            ? `Domain registration expired ${Math.abs(days)} days ago`
            : `Domain registration expires in ${days} days`,
        detail:
          days < 0
            ? "An expired registration can be re-registered by anyone, which hands " +
              "over the mail and the certificates with it."
            : "Renewal window. Worth confirming auto-renew is on.",
        evidence: [`${row.value} — ${expires.slice(0, 10)}`],
      });
    }
  }

  // ── Credential-bearing leaks ─────────────────────────────────────────────
  //
  // Infostealer logs have a recognisable shape: an archive containing
  // Passwords.txt, a browser profile directory, autofill or cookie dumps. A
  // generic "49 dataset hits" note buried this behind volume, when it is the
  // single most consequential thing a run can surface — malware on somebody's
  // machine harvested credentials and the archive index references this domain.
  const STEALER =
    /(passwords?\.txt|\/Passwords|autofill|cookies?\.txt|Chrome\/Profile|Opera_|Login Data|credentials?\.txt)/i;

  const stealerHits = by("Dataset Hits").filter((row) => STEALER.test(row.value));

  if (stealerHits.length > 0) {
    insights.push({
      id: "stealer-logs",
      severity: "high",
      title: `${stealerHits.length} hit${stealerHits.length === 1 ? "" : "s"} in credential-dump archives`,
      detail:
        "These filenames are the signature of infostealer output — browser " +
        "password stores, autofill and cookie dumps. An index entry naming this " +
        "domain is not proof its credentials are inside; it is the strongest " +
        "reason on this page to go and look.",
      evidence: stealerHits.slice(0, 6).map((row) => row.value),
    });
  }

  // ── Dataset and leak exposure ────────────────────────────────────────────
  const datasetHits = by("Dataset Hits").filter(
    (row) => !STEALER.test(row.value),
  );
  if (datasetHits.length >= 10) {
    insights.push({
      id: "dataset-volume",
      severity: "medium",
      title: `${datasetHits.length} dataset and leak hits`,
      detail:
        "Appears across archived pastes, leaks and dumps. Volume alone is not a " +
        "breach — much of this is ordinary web content the archive happened to " +
        "keep — but it is where a leak would show up.",
      evidence: datasetHits.slice(0, 5).map((row) => row.value),
    });
  }

  // ── People ───────────────────────────────────────────────────────────
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
