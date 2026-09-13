/**
 * Case events, in English.
 *
 * The audit trail stored these as an action string and a JSON detail object,
 * and the panel printed the JSON. That is a faithful record and an unreadable
 * one: `{"area":{"east":-157,"west":-159,...},"kind":"geofence","layerIds":
 * [...]}` is a thing an operator has to decode before they can tell whether it
 * matters, and the whole point of an audit trail is that somebody reads it.
 *
 * Every action gets a label and a sentence. The sentence is built from the
 * detail that was actually recorded — nothing is inferred, and an action this
 * file has never heard of falls back to the raw JSON rather than pretending to
 * describe it.
 */

export interface CaseEvent {
  action: string;
  detail: unknown;
  actor?: string | null;
}

export interface Described {
  /** What happened, as a short noun phrase. */
  label: string;
  /** The particulars, as a sentence. Empty when the label says it all. */
  detail: string;
  /** Whether this is a destructive or authorisation-relevant act. */
  weight: "normal" | "notable" | "grave";
}

type Detail = Record<string, unknown>;

function read(detail: unknown): Detail {
  return detail !== null && typeof detail === "object"
    ? (detail as Detail)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown, one: string, many = `${one}s`): string | null {
  const n = num(value);
  if (n === null) return null;
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The particulars, joined.
 *
 * A middle dot rather than "and". These clauses are not a sentence — they are a
 * place, a list of layers and an interval — and stitching them with "and"
 * produced things like "watching military, flights and every 5 min", which
 * reads as though the interval were another layer. The separator is the one the
 * rest of the app already uses for exactly this.
 */
function list(parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * A bounding box as somebody would say it.
 *
 * Degrees with a hemisphere letter rather than a signed number: "20.5°N to
 * 22.5°N, 159.0°W to 157.0°W" is a place, `{"south":20.5,"west":-159}` is a
 * payload.
 */
function area(value: unknown): string | null {
  const box = read(value);
  const south = num(box["south"]);
  const west = num(box["west"]);
  const north = num(box["north"]);
  const east = num(box["east"]);
  if (south === null || west === null || north === null || east === null) {
    return null;
  }

  const lat = (deg: number): string =>
    `${Math.abs(deg).toFixed(1)}°${deg < 0 ? "S" : "N"}`;
  const lon = (deg: number): string =>
    `${Math.abs(deg).toFixed(1)}°${deg < 0 ? "W" : "E"}`;

  return `${lat(south)}–${lat(north)}, ${lon(west)}–${lon(east)}`;
}

function names(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.filter((entry) => typeof entry === "string").join(", ");
}

export function describeEvent(event: CaseEvent): Described {
  const d = read(event.detail);

  switch (event.action) {
    case "case.created": {
      const ref = text(d["authorizationRef"]);
      return {
        label: "Case Opened",
        detail: list([
          text(d["name"]),
          ref === null ? null : `authorised by ${ref}`,
          count(d["scopeEntryCount"], "scope entry", "scope entries"),
          text(d["source"]) === null ? null : `seeded from ${text(d["source"])}`,
        ]),
        weight: "notable",
      };
    }

    case "case.archived":
      return { label: "Case Archived", detail: "", weight: "notable" };

    case "case.restored":
      return { label: "Case Restored", detail: "", weight: "notable" };

    case "case.purged": {
      const reason = text(d["reason"]);
      return {
        label: "Case Purged",
        detail: list([
          count(d["findings"], "finding"),
          count(d["subjects"], "subject"),
          reason === null ? null : `reason: ${reason}`,
        ]),
        weight: "grave",
      };
    }

    case "scope.added":
      return {
        label: "Scope Added",
        detail: list([
          text(d["value"]),
          text(d["kind"]) === null ? null : `as a ${text(d["kind"])}`,
        ]),
        weight: "grave",
      };

    case "scope.removed":
      return {
        label: "Scope Removed",
        detail: list([
          text(d["value"]),
          text(d["kind"]) === null ? null : `as a ${text(d["kind"])}`,
        ]),
        weight: "grave",
      };

    case "monitor.created": {
      const geofence = d["kind"] === "geofence";
      const every = num(d["intervalMinutes"]);
      return {
        label: geofence ? "Geofence Created" : "Monitor Created",
        detail: list([
          geofence ? area(d["area"]) : text(d["subjectKind"]),
          geofence
            ? names(d["layerIds"]) === null
              ? null
              : `watching ${names(d["layerIds"]) as string}`
            : names(d["sourceIds"]) === null
              ? null
              : `across ${names(d["sourceIds"]) as string}`,
          every === null ? null : `every ${every} min`,
        ]),
        weight: "normal",
      };
    }

    case "monitor.deleted":
      return {
        label: "Monitor Removed",
        detail: text(d["name"]) ?? "",
        weight: "normal",
      };

    case "monitor.baseline":
      return {
        label: "Baseline Recorded",
        // The first run of a monitor reports nothing by design — it is
        // establishing what "normal" is, and saying so prevents the empty
        // result being read as "nothing there".
        detail: list([
          count(d["observations"], "observation"),
          "first run, so nothing is reported as a change",
        ]),
        weight: "normal",
      };

    case "graph.merged":
      return {
        label: "Entities Merged",
        detail: list([
          text(d["losingKey"]) === null || text(d["winningKey"]) === null
            ? null
            : `${text(d["losingKey"]) as string} into ${text(d["winningKey"]) as string}`,
          text(d["reason"]),
        ]),
        weight: "notable",
      };

    case "authorization.created": {
      const until = text(d["validUntil"]);
      return {
        label: "Authorization Created",
        detail: list([
          text(d["issuedBy"]) === null ? null : `issued by ${text(d["issuedBy"]) as string}`,
          names(d["sourceClasses"]) === null ? null : `sources: ${names(d["sourceClasses"]) as string}`,
          names(d["actionClasses"]) === null ? null : `actions: ${names(d["actionClasses"]) as string}`,
          until === null ? null : `until ${until.slice(0, 10)}`,
        ]),
        weight: "grave",
      };
    }

    case "authorization.revoked":
      return {
        label: "Authorization Revoked",
        detail: text(d["reason"]) ?? "",
        weight: "grave",
      };

    case "v2.collection.ran": {
      const outcome = text(d["outcome"]);
      return {
        label: outcome === "ok" ? "Collection Ran" : outcome === "inert" ? "Collection Inert" : "Collection Failed",
        detail: list([
          text(d["collectorId"]),
          outcome === "ok" ? count(d["written"], "observation") : null,
          outcome === "ok" ? `${num(d["skipped"]) ?? 0} already held` : null,
          text(d["reason"]),
          text(d["errorMessage"]),
        ]),
        weight: outcome === "error" ? "notable" : "normal",
      };
    }

    case "v2.resolution.ran":
      return {
        label: "Resolution Ran",
        detail: list([
          text(d["entityKind"]),
          count(d["observations"], "observation"),
          count(d["entities"], "entity", "entities"),
          num(d["review"]) === null ? null : `${num(d["review"]) as number} for review`,
          num(d["disputed"]) === null || num(d["disputed"]) === 0 ? null : `${num(d["disputed"]) as number} disputed`,
        ]),
        weight: "normal",
      };

    case "v2.adjudicated":
      return {
        label: "Pair Adjudicated",
        detail: list([text(d["decision"]), text(d["note"])]),
        weight: "notable",
      };

    case "v2.links.derived":
      return {
        label: "Links Derived",
        detail: list([count(d["entities"], "entity", "entities"), count(d["candidate"], "edge")]),
        weight: "normal",
      };

    case "v2.graph.checked":
      return {
        label: d["clean"] === true ? "Graph Consistent" : "Graph Inconsistent",
        detail: d["clean"] === true ? "" : list([count(d["danglingEvidence"], "dangling evidence edge"), count(d["resolvedWithoutMembers"], "empty resolved entity", "empty resolved entities")]),
        weight: d["clean"] === true ? "normal" : "notable",
      };

    case "report.exported":
      return {
        label: "Report Exported",
        detail: list([
          text(d["format"])?.toUpperCase() ?? null,
          count(d["findings"], "finding"),
          count(d["redactedIdentifiers"], "identifier redacted", "identifiers redacted"),
        ]),
        weight: "notable",
      };

    case "audit.exported":
      return {
        label: "Audit Trail Exported",
        detail: count(d["rows"], "row") ?? "",
        weight: "notable",
      };

    default:
      // An action this file does not know is shown exactly as recorded. A
      // guessed description of an unknown act would be worse than none.
      return {
        label: event.action,
        detail: JSON.stringify(event.detail),
        weight: "normal",
      };
  }
}
