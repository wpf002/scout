import type { RunResultRow } from "./api";

/**
 * Turning every source's observations into one table.
 *
 * Each adapter returns its own shape — a certificate is not a breach is not a
 * username sighting — and the consolidated view has to show all of them
 * together without flattening away what makes them different. So every
 * observation becomes a value, a detail line, and the sources that found it,
 * grouped by what kind of thing it is rather than by which tool produced it.
 *
 * Then it deduplicates, which is the part that makes the table readable. A
 * domain with a renewed certificate produces one crt.sh row per issuance, so
 * `store.example.com` arrives twenty times and buries everything else. Those
 * are one host seen twenty times, not twenty findings. Merging them into a
 * single row that names every source and spans the full first/last-seen window
 * is what an investigator actually wants to read — and reconciling that by
 * hand is the work this tool exists to do.
 */

export interface ResultRow {
  /** Group heading. Title Case, plural. */
  type: string;
  value: string;
  detail: string;
  /** Every source that reported this value, deduplicated. */
  sources: string[];
  /** How many raw observations collapsed into this row. */
  occurrences: number;
  url: string | null;
  /**
   * Every raw observation that merged into this row, with the source that
   * reported it. The table shows a summary; the detail pane shows this, so
   * nothing an adapter collected is unreachable from the surface.
   */
  evidence: { source: string; observation: unknown }[];
}

/** Group display order. Anything unlisted sorts after these, alphabetically. */
const GROUP_ORDER = [
  "Registration",
  "DNS Records",
  "Organization",
  "Emails",
  "Hosts",
  "Subdomains",
  "Certificates",
  "Web Scans",
  "Profiles",
  "Breaches",
  "Credentials",
  "Sanctions",
  "Dataset Hits",
  "Other",
];

export function groupRank(type: string): number {
  const index = GROUP_ORDER.indexOf(type);
  return index === -1 ? GROUP_ORDER.length : index;
}

/** Discriminator carried by every normalized observation. */
interface Observation {
  kind?: string;
  [key: string]: unknown;
}

/** A row before merging, carrying the raw dates so windows can be widened. */
interface DraftRow extends Omit<ResultRow, "sources" | "occurrences" | "evidence"> {
  source: string;
  raw?: unknown;
  firstSeen: string | null;
  lastSeen: string | null;
  extra: string | null;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const detailOf = (...parts: (string | null)[]): string =>
  parts
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");

/** Dates render as days. The clock time on a certificate is never the point. */
const day = (value: string | null): string | null =>
  value === null ? null : (value.split("T")[0] ?? value);

/**
 * Some observations are containers.
 *
 * Hunter returns one `email-pattern` carrying the organisation, the address
 * pattern, and every mailbox it found with the person's name and job title.
 * Rendered as a single row that was one line reading "betterman.com" while ten
 * named people sat inside it, unreadable. A container has to be unpacked into
 * the rows it actually represents.
 */
function expand(observation: Observation, sourceName: string): DraftRow[] {
  if (observation.kind !== "email-pattern") return [];

  const rows: DraftRow[] = [];
  const base = { source: sourceName, firstSeen: null, lastSeen: null, extra: null };
  const organization = str(observation.organization);
  const pattern = str(observation.pattern);
  const domain = str(observation.domain);

  const emails = Array.isArray(observation.emails) ? observation.emails : [];
  for (const raw of emails) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Observation;
    const address = str(entry.value) ?? str(entry.email);
    if (address === null) continue;

    const first = str(entry.firstName);
    const last = str(entry.lastName);
    const person = [first, last].filter((p) => p !== null).join(" ").trim();
    const confidence = num(entry.confidence);

    // `personal` and `generic` are Hunter's vocabulary, not a reader's. An
    // unattributed mailbox is worth naming as such — it is a different thing
    // from one belonging to a named person.
    const mailbox =
      str(entry.type) === "generic"
        ? "Shared mailbox"
        : person.length > 0
          ? null
          : "Unattributed";

    rows.push({
      ...base,
      type: "Emails",
      value: address.toLowerCase(),
      detail: detailOf(
        person.length > 0 ? person : null,
        str(entry.position),
        mailbox,
        confidence === null ? null : `${confidence}% match`,
      ),
      url: null,
    });
  }

  // The pattern itself is a finding — it predicts addresses that were not
  // enumerated — so it stays, alongside the mailboxes rather than instead.
  if (pattern !== null || organization !== null) {
    rows.push({
      ...base,
      type: "Organization",
      value: organization ?? domain ?? "Unknown",
      detail: detailOf(
        pattern === null ? null : `Address pattern ${pattern}`,
        emails.length > 0 ? `${emails.length} mailboxes` : null,
      ),
      url: null,
    });
  }

  return rows;
}

function draftFor(
  observation: Observation,
  sourceName: string,
): DraftRow | null {
  const kind = observation.kind;
  const base = { source: sourceName, firstSeen: null, lastSeen: null, extra: null };

  switch (kind) {
    case "subdomain": {
      const hostname = str(observation.hostname);
      if (hostname === null) return null;
      return {
        ...base,
        type: "Subdomains",
        value: hostname.toLowerCase(),
        detail: "",
        firstSeen: str(observation.firstSeen),
        lastSeen: str(observation.lastSeen),
        url: null,
      };
    }

    case "host": {
      const ip = str(observation.ip);
      if (ip === null) return null;
      const ports = Array.isArray(observation.ports)
        ? observation.ports.filter((p): p is number => typeof p === "number")
        : [];
      return {
        ...base,
        type: "Hosts",
        value: ip,
        detail: detailOf(
          // Services first: `443/HTTPS` says more than `443`.
          list(observation.services).length > 0
            ? list(observation.services).join(", ")
            : ports.length > 0
              ? `Ports ${ports.join(", ")}`
              : null,
          list(observation.vulns).length > 0
            ? `${list(observation.vulns).length} CVEs: ${list(observation.vulns).slice(0, 3).join(", ")}`
            : null,
          list(observation.software).slice(0, 3).join(", ") || null,
          list(observation.tags).join(", ") || null,
          str(observation.org),
          str(observation.asn),
          [str(observation.location), str(observation.country)]
            .filter((p) => p !== null)
            .join(", ") || null,
        ),
        extra: list(observation.hostnames).slice(0, 2).join(", ") || null,
        lastSeen: str(observation.lastSeen),
        url: null,
      };
    }

    case "cert": {
      const commonName = str(observation.commonName);
      if (commonName === null) return null;
      const names = list(observation.names);
      return {
        ...base,
        type: "Certificates",
        value: commonName.toLowerCase(),
        detail: detailOf(
          str(observation.issuer),
          names.length > 1 ? `${names.length} names` : null,
        ),
        firstSeen: str(observation.notBefore),
        lastSeen: str(observation.notAfter),
        url: null,
      };
    }

    case "threat-pulse": {
      const name = str(observation.name);
      if (name === null) return null;
      return {
        ...base,
        type: "Threat Intel",
        value: name,
        detail: detailOf(
          str(observation.author),
          list(observation.tags).slice(0, 5).join(", ") || null,
          day(str(observation.created)),
        ),
        url: str(observation.reportUrl),
      };
    }

    case "reputation": {
      const ip = str(observation.ip);
      if (ip === null) return null;
      return {
        ...base,
        type: "Reputation",
        value: ip,
        detail: detailOf(str(observation.verdict), str(observation.actor)),
        lastSeen: str(observation.lastSeen),
        url: str(observation.reportUrl),
      };
    }

    case "web-scan": {
      const url = str(observation.url);
      if (url === null) return null;
      const age = num(observation.domainAgeDays);
      return {
        ...base,
        type: "Web Scans",
        value: str(observation.title) ?? url,
        detail: detailOf(
          url === (str(observation.title) ?? url) ? null : url,
          str(observation.server),
          str(observation.tlsIssuer),
          str(observation.ip),
          age === null ? null : `domain ${age}d old`,
        ),
        lastSeen: str(observation.scannedAt),
        url: str(observation.reportUrl) ?? url,
      };
    }

    case "registration": {
      const domain = str(observation.domain);
      if (domain === null) return null;
      const nameservers = list(observation.nameservers);
      return {
        ...base,
        type: "Registration",
        value: domain,
        detail: detailOf(
          str(observation.registrar),
          nameservers.length > 0 ? `NS ${nameservers.join(", ")}` : null,
          list(observation.statuses).slice(0, 3).join(", ") || null,
        ),
        firstSeen: str(observation.created),
        lastSeen: str(observation.expires),
        url: null,
      };
    }

    case "dns-record": {
      const value = str(observation.value);
      const type = str(observation.type);
      if (value === null || type === null) return null;
      return {
        ...base,
        // Type in the value column so the table reads as a zone file would.
        type: "DNS Records",
        value: `${type}  ${value}`,
        detail: str(observation.name) ?? "",
        url: null,
      };
    }

    case "username-sighting": {
      const site = str(observation.site);
      if (site === null) return null;
      return {
        ...base,
        type: "Profiles",
        value: site,
        detail: detailOf(str(observation.username), str(observation.category)),
        url: str(observation.url),
      };
    }

    case "breach": {
      const name = str(observation.name) ?? str(observation.title);
      if (name === null) return null;
      return {
        ...base,
        type: "Breaches",
        value: name,
        detail: detailOf(
          str(observation.breachDate),
          list(observation.dataClasses).slice(0, 4).join(", ") || null,
        ),
        url: null,
      };
    }

    case "credential": {
      const identifier = str(observation.email) ?? str(observation.username);
      if (identifier === null) return null;
      return {
        ...base,
        type: "Credentials",
        value: identifier,
        detail: detailOf(
          str(observation.database),
          // Never renders credential material, only that it exists. The API
          // redacts by default; this is the second place that holds.
          observation.hasPassword === true ? "Password present" : null,
        ),
        url: null,
      };
    }

    case "email-candidate": {
      const address = str(observation.address) ?? str(observation.email);
      if (address === null) return null;
      return {
        ...base,
        type: "Emails",
        value: address.toLowerCase(),
        detail: detailOf(str(observation.type), str(observation.confidence)),
        url: null,
      };
    }

    case "dataset-hit": {
      const title = str(observation.title) ?? str(observation.name);
      if (title === null) return null;
      return {
        ...base,
        type: "Dataset Hits",
        value: title,
        detail: detailOf(str(observation.collection), str(observation.date)),
        url: str(observation.url),
      };
    }

    case "sanction-match": {
      const name = str(observation.name);
      if (name === null) return null;
      const score = num(observation.score);
      return {
        ...base,
        type: "Sanctions",
        value: name,
        detail: detailOf(
          list(observation.designations).join(", ") || null,
          str(observation.country),
          score === null ? null : `Score ${score.toFixed(2)}`,
        ),
        url: str(observation.url),
      };
    }

    default:
      return null;
  }
}

/**
 * Flattens and deduplicates every source's results.
 *
 * An observation whose shape is not recognised is not dropped — an adapter
 * returning something new would otherwise go silently missing from the one
 * view that is supposed to show everything. It lands under "Other", which is
 * ugly on purpose: visible and wrong is fixable, invisible is not.
 */
export function flattenObservations(results: RunResultRow[]): ResultRow[] {
  const drafts: DraftRow[] = [];

  for (const result of results) {
    if (result.status !== "ok") continue;

    for (const raw of result.data) {
      if (typeof raw !== "object" || raw === null) continue;
      const observation = raw as Observation;

      const expanded = expand(observation, result.name);
      if (expanded.length > 0) {
        drafts.push(...expanded);
        continue;
      }

      const draft = draftFor(observation, result.name);
      if (draft !== null) {
        drafts.push({ ...draft, raw: observation });
        continue;
      }

      drafts.push({
        raw: observation,
        type: "Other",
        value:
          str(observation.value) ??
          str(observation.name) ??
          str(observation.title) ??
          str(observation.hostname) ??
          str(observation.id) ??
          (observation.kind ?? "Unknown"),
        detail: JSON.stringify(observation).slice(0, 160),
        source: result.name,
        firstSeen: null,
        lastSeen: null,
        extra: null,
        url: null,
      });
    }
  }

  const merged = new Map<
    string,
    ResultRow & { firstSeen: string | null; lastSeen: string | null }
  >();

  for (const draft of drafts) {
    const key = `${draft.type} ${draft.value.toLowerCase()}`;
    const existing = merged.get(key);

    if (existing === undefined) {
      merged.set(key, {
        type: draft.type,
        value: draft.value,
        detail: detailOf(draft.detail, draft.extra),
        sources: [draft.source],
        occurrences: 1,
        url: draft.url,
        evidence: [{ source: draft.source, observation: draft.raw ?? null }],
        firstSeen: draft.firstSeen,
        lastSeen: draft.lastSeen,
      });
      continue;
    }

    existing.occurrences += 1;
    existing.evidence.push({
      source: draft.source,
      observation: draft.raw ?? null,
    });
    if (!existing.sources.includes(draft.source)) {
      existing.sources.push(draft.source);
    }
    // Widen the observed window rather than letting the last row win.
    if (
      draft.firstSeen !== null &&
      (existing.firstSeen === null || draft.firstSeen < existing.firstSeen)
    ) {
      existing.firstSeen = draft.firstSeen;
    }
    if (
      draft.lastSeen !== null &&
      (existing.lastSeen === null || draft.lastSeen > existing.lastSeen)
    ) {
      existing.lastSeen = draft.lastSeen;
    }
    if (existing.detail === "" && draft.detail !== "") {
      existing.detail = detailOf(draft.detail, draft.extra);
    }
    if (existing.url === null) existing.url = draft.url;
  }

  return [...merged.values()]
    .map(({ firstSeen, lastSeen, ...row }) => ({
      ...row,
      detail: detailOf(
        row.detail,
        firstSeen === null && lastSeen === null
          ? null
          : `${day(firstSeen) ?? "?"} → ${day(lastSeen) ?? "?"}`,
      ),
    }))
    .sort(
      (a, b) =>
        groupRank(a.type) - groupRank(b.type) ||
        b.sources.length - a.sources.length ||
        a.value.localeCompare(b.value),
    );
}
