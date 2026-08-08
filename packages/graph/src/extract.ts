import type {
  EntityKind,
  EntityRef,
  ExtractionResult,
  FindingInput,
  Link,
  Mention,
  Relation,
} from "./types.js";

const lower = (value: string): string => value.trim().toLowerCase();

/**
 * The registrable-ish parent of a hostname.
 *
 * Deliberately naive — last two labels — and deliberately only used to draw a
 * `subdomain-of` link between two hostnames already in the graph, never to
 * invent a parent entity. Getting this right needs the public suffix list;
 * getting it wrong here costs a missing edge, not a false claim.
 */
function parentDomain(hostname: string): string | null {
  const labels = hostname.split(".");
  if (labels.length < 3) return null;
  return labels.slice(-2).join(".");
}

interface Collector {
  mentions: Mention[];
  links: Link[];
}

function mention(
  into: Collector,
  finding: FindingInput,
  kind: EntityKind,
  value: string,
  label?: string,
): EntityRef | null {
  const normalized = lower(value);
  if (normalized.length === 0) return null;
  const ref: EntityRef = label === undefined
    ? { kind, value: normalized }
    : { kind, value: normalized, label };
  into.mentions.push({
    entity: ref,
    findingId: finding.id,
    sourceId: finding.sourceId,
    observedAt: finding.observedAt,
  });
  return ref;
}

function link(
  into: Collector,
  finding: FindingInput,
  from: EntityRef | null,
  to: EntityRef | null,
  relation: Relation,
): void {
  if (from === null || to === null) return;
  if (from.kind === to.kind && from.value === to.value) return;
  into.links.push({
    from,
    to,
    relation,
    findingId: finding.id,
    sourceId: finding.sourceId,
  });
}

/** Narrow an unknown payload to a record without trusting its shape. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Pulls entities and relationships out of one finding.
 *
 * Reads the normalized observation stored on the finding — the same shapes the
 * adapters produce — so a new source contributes to the graph by normalizing
 * correctly, not by teaching the extractor about itself.
 *
 * Everything emitted carries the finding and source it came from. There is no
 * path here that produces an entity without provenance.
 */
export function extractFromFinding(finding: FindingInput): ExtractionResult {
  const into: Collector = { mentions: [], links: [] };
  const data = asRecord(finding.data);

  // The subject that produced the finding is itself an entity. This is what
  // ties results from different sources together: they were asked the same
  // question.
  const queryKindMap: Partial<Record<string, EntityKind>> = {
    domain: "domain",
    ip: "ip",
    email: "email",
    username: "username",
    person: "person",
    company: "company",
  };
  const queryEntityKind = queryKindMap[finding.queryKind];
  const queryEntity =
    queryEntityKind === undefined
      ? null
      : mention(into, finding, queryEntityKind, finding.queryTerm);

  if (data === null) return into;

  switch (asString(data["kind"])) {
    case "subdomain": {
      const hostname = asString(data["hostname"]);
      if (hostname === null) break;
      const host = mention(into, finding, "domain", hostname);
      const parent = parentDomain(lower(hostname));
      if (parent !== null) {
        link(into, finding, host, { kind: "domain", value: parent }, "subdomain-of");
      }
      break;
    }

    case "host": {
      const ip = asString(data["ip"]);
      if (ip === null) break;
      const address = mention(into, finding, "ip", ip);
      for (const hostname of asStringArray(data["hostnames"])) {
        const host = mention(into, finding, "domain", hostname);
        link(into, finding, host, address, "resolves-to");
      }
      break;
    }

    case "cert": {
      const serial = asString(data["serial"]);
      const commonName = asString(data["commonName"]);
      const identity = serial ?? commonName;
      if (identity === null) break;
      const cert = mention(
        into,
        finding,
        "cert",
        identity,
        commonName ?? undefined,
      );
      for (const name of asStringArray(data["names"])) {
        // A wildcard is not a host you can resolve, so it stays on the
        // certificate rather than becoming a node of its own.
        if (name.startsWith("*.")) continue;
        const host = mention(into, finding, "domain", name);
        link(into, finding, cert, host, "covers");
      }
      break;
    }

    case "credential-record": {
      const database = asString(data["databaseName"]);
      const breach =
        database === null ? null : mention(into, finding, "breach", database);
      const email = asString(data["email"]);
      const username = asString(data["username"]);

      const emailEntity =
        email === null ? null : mention(into, finding, "email", email);
      const usernameEntity =
        username === null ? null : mention(into, finding, "username", username);

      link(into, finding, emailEntity, breach, "exposed-in");
      link(into, finding, usernameEntity, breach, "exposed-in");
      // Same record, so the source is asserting these belong together.
      link(into, finding, emailEntity, usernameEntity, "co-occurs");
      break;
    }

    case "email-pattern": {
      const domain = asString(data["domain"]);
      const domainEntity =
        domain === null ? null : mention(into, finding, "domain", domain);
      const emails = Array.isArray(data["emails"]) ? data["emails"] : [];
      for (const entry of emails) {
        const record = asRecord(entry);
        const value = record === null ? null : asString(record["value"]);
        if (value === null) continue;
        const emailEntity = mention(into, finding, "email", value);
        link(into, finding, emailEntity, domainEntity, "email-at");
      }
      break;
    }

    case "sanction-match": {
      const caption = asString(data["caption"]);
      if (caption === null) break;
      const schema = asString(data["schema"]) ?? "";
      const kind: EntityKind = schema === "Person" ? "person" : "company";
      const subject = mention(into, finding, kind, caption, caption);
      link(into, finding, subject, queryEntity, "co-occurs");
      break;
    }

    case "username-sighting": {
      const username = asString(data["username"]);
      if (username !== null) mention(into, finding, "username", username);
      break;
    }

    default:
      break;
  }

  // Entities the adapters already extracted (dataset hits carry these). They
  // are suggestions upstream, but a saved finding means an operator kept it.
  const entities = Array.isArray(data["entities"]) ? data["entities"] : [];
  for (const entry of entities) {
    const record = asRecord(entry);
    if (record === null) continue;
    const value = asString(record["value"]);
    const kind = asString(record["kind"]);
    if (value === null || kind === null) continue;
    if (!["domain", "email", "ip", "username", "person", "company"].includes(kind)) {
      continue;
    }
    const entity = mention(into, finding, kind as EntityKind, value);
    link(into, finding, entity, queryEntity, "co-occurs");
  }

  return into;
}

/** Extracts across a whole case. */
export function extractAll(
  findings: readonly FindingInput[],
): ExtractionResult {
  const mentions: Mention[] = [];
  const links: Link[] = [];
  for (const finding of findings) {
    const result = extractFromFinding(finding);
    mentions.push(...result.mentions);
    links.push(...result.links);
  }
  return { mentions, links };
}
