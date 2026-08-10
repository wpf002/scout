import type { RunResultRow } from "./api";

/**
 * Turning every source's observations into one table.
 *
 * Each adapter returns its own shape — a certificate is not a breach is not a
 * username sighting — and the consolidated view has to show all of them
 * together without flattening away what makes them different. So every
 * observation becomes a value, a detail line, and the source that found it,
 * grouped by what kind of thing it is rather than by which tool produced it.
 *
 * Grouping by type rather than by tool is the whole point of consolidating. If
 * three sources each found the same subdomain, an investigator wants one
 * "Subdomains" list, not three per-tool lists to reconcile by hand.
 */

export interface ResultRow {
  /** Group heading. Title Case, plural. */
  type: string;
  value: string;
  detail: string;
  source: string;
  url: string | null;
}

/** Discriminator carried by every normalized observation. */
interface Observation {
  kind?: string;
  [key: string]: unknown;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Joins the parts of a detail line, dropping the ones that were absent. */
const detailOf = (...parts: (string | null)[]): string =>
  parts.filter((part): part is string => part !== null && part.length > 0).join(" · ");

function rowFor(
  observation: Observation,
  sourceName: string,
): ResultRow | null {
  const kind = observation.kind;

  switch (kind) {
    case "subdomain": {
      const hostname = str(observation.hostname);
      if (hostname === null) return null;
      return {
        type: "Subdomains",
        value: hostname,
        detail: detailOf(
          str(observation.firstSeen) === null
            ? null
            : `first seen ${str(observation.firstSeen)}`,
          str(observation.lastSeen) === null
            ? null
            : `last seen ${str(observation.lastSeen)}`,
        ),
        source: sourceName,
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
        type: "Hosts",
        value: ip,
        detail: detailOf(
          ports.length > 0 ? `ports ${ports.join(", ")}` : null,
          list(observation.hostnames).slice(0, 3).join(", ") || null,
          str(observation.org),
          str(observation.asn),
          str(observation.country),
        ),
        source: sourceName,
        url: null,
      };
    }

    case "cert": {
      const commonName = str(observation.commonName);
      if (commonName === null) return null;
      const names = list(observation.names);
      return {
        type: "Certificates",
        value: commonName,
        detail: detailOf(
          str(observation.issuer),
          names.length > 1 ? `${names.length} names` : null,
          str(observation.notAfter) === null
            ? null
            : `expires ${str(observation.notAfter)}`,
        ),
        source: sourceName,
        url: null,
      };
    }

    case "username-sighting": {
      const site = str(observation.site);
      const url = str(observation.url);
      if (site === null) return null;
      return {
        type: "Profiles",
        value: site,
        detail: detailOf(str(observation.username), str(observation.category)),
        source: sourceName,
        url,
      };
    }

    case "breach": {
      const name = str(observation.name) ?? str(observation.title);
      if (name === null) return null;
      return {
        type: "Breaches",
        value: name,
        detail: detailOf(
          str(observation.breachDate),
          list(observation.dataClasses).slice(0, 4).join(", ") || null,
        ),
        source: sourceName,
        url: null,
      };
    }

    case "credential": {
      const identifier = str(observation.email) ?? str(observation.username);
      if (identifier === null) return null;
      return {
        type: "Credentials",
        value: identifier,
        detail: detailOf(
          str(observation.database),
          // Never renders credential material, only that it exists. The API
          // redacts by default; this is the second place that holds.
          observation.hasPassword === true ? "password present" : null,
        ),
        source: sourceName,
        url: null,
      };
    }

    case "email-candidate": {
      const address = str(observation.address) ?? str(observation.email);
      if (address === null) return null;
      return {
        type: "Emails",
        value: address,
        detail: detailOf(str(observation.type), str(observation.confidence)),
        source: sourceName,
        url: null,
      };
    }

    case "dataset-hit": {
      const title = str(observation.title) ?? str(observation.name);
      if (title === null) return null;
      return {
        type: "Dataset Hits",
        value: title,
        detail: detailOf(str(observation.collection), str(observation.date)),
        source: sourceName,
        url: str(observation.url),
      };
    }

    case "sanction-match": {
      const name = str(observation.name);
      if (name === null) return null;
      const score = num(observation.score);
      return {
        type: "Sanctions",
        value: name,
        detail: detailOf(
          list(observation.designations).join(", ") || null,
          str(observation.country),
          score === null ? null : `score ${score.toFixed(2)}`,
        ),
        source: sourceName,
        url: str(observation.url),
      };
    }

    default:
      return null;
  }
}

/**
 * Flattens every source's results into display rows.
 *
 * An observation whose shape is not recognised is not dropped — an adapter
 * that returns something new would otherwise go silently missing from the one
 * view that is supposed to show everything. It lands under "Other" with its
 * fields serialized, which is ugly on purpose: visible and wrong is fixable,
 * invisible is not.
 */
export function flattenObservations(results: RunResultRow[]): ResultRow[] {
  const rows: ResultRow[] = [];

  for (const result of results) {
    if (result.status !== "ok") continue;

    for (const raw of result.data) {
      if (typeof raw !== "object" || raw === null) continue;
      const observation = raw as Observation;

      const row = rowFor(observation, result.name);
      if (row !== null) {
        rows.push(row);
        continue;
      }

      const fallback =
        str(observation.value) ??
        str(observation.name) ??
        str(observation.title) ??
        str(observation.hostname) ??
        str(observation.id);

      rows.push({
        type: "Other",
        value: fallback ?? (observation.kind ?? "unknown"),
        detail: JSON.stringify(observation).slice(0, 200),
        source: result.name,
        url: null,
      });
    }
  }

  return rows;
}
