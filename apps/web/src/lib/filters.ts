/**
 * Asking a layer a question.
 *
 * Every field these predicates read is already on the wire and was, until now,
 * unused — an operator could look at nine thousand aircraft but not ask which
 * of them were military above thirty thousand feet. This is the difference
 * between a map you look at and a map you interrogate.
 *
 * Predicates compile to MapLibre layer filters, so they run in the style and
 * cost nothing per frame. That only works because the source now holds the
 * unfiltered set — which is the other reason clustering had to replace
 * destructive thinning.
 */

export type Operator = "is" | "not" | "gte" | "lte" | "contains" | "exists";

export interface Predicate {
  field: string;
  operator: Operator;
  value: string;
}

export interface FieldDef {
  field: string;
  label: string;
  /** Numeric fields offer thresholds; text fields offer matching. */
  kind: "number" | "text" | "flag";
  /** Suggested values, where the vocabulary is small and known. */
  options?: string[];
  unit?: string;
  hint?: string;
}

/**
 * What each layer can be asked about.
 *
 * Deliberately curated rather than derived from the data: a field list built
 * by walking the first feature would offer `colour` and `layer` alongside
 * `altitudeM`, and an operator would have to work out which of them mean
 * anything.
 */
export const FILTERABLE: Record<string, FieldDef[]> = {
  aircraft: [
    { field: "tier", label: "Tier", kind: "text", options: ["commercial", "private", "jet", "military"] },
    { field: "altitudeM", label: "Altitude", kind: "number", unit: "m", hint: "30,000 ft is 9,144 m" },
    { field: "speedKts", label: "Speed", kind: "number", unit: "kt" },
    { field: "aircraftType", label: "Type code", kind: "text", hint: "ICAO designator, e.g. B738" },
    { field: "squawk", label: "Squawk", kind: "text" },
    { field: "emergency", label: "Emergency", kind: "flag" },
    { field: "grounded", label: "On the ground", kind: "flag" },
    { field: "registration", label: "Registration", kind: "text" },
    { field: "origin", label: "Origin country", kind: "text" },
  ],
  maritime: [
    { field: "shipType", label: "Ship type", kind: "text", options: ["Cargo", "Tanker", "Passenger", "Fishing", "Tug", "Military", "Law enforcement", "Search and rescue"] },
    { field: "speedKn", label: "Speed", kind: "number", unit: "kn" },
    { field: "draughtM", label: "Draught", kind: "number", unit: "m" },
    { field: "lengthM", label: "Length", kind: "number", unit: "m" },
    { field: "destination", label: "Destination", kind: "text" },
    { field: "role", label: "Role", kind: "text", options: ["vessel", "port", "chokepoint"] },
  ],
  satellites: [
    { field: "category", label: "Category", kind: "text", options: ["comms", "military", "navigation", "earth_obs", "science", "other"] },
    { field: "mission", label: "Mission", kind: "text" },
    { field: "altitudeKm", label: "Altitude", kind: "number", unit: "km" },
  ],
  earthquakes: [
    { field: "magnitude", label: "Magnitude", kind: "number" },
    { field: "depthKm", label: "Depth", kind: "number", unit: "km" },
    { field: "tsunami", label: "Tsunami flag", kind: "flag" },
  ],
  fires: [
    { field: "frp", label: "Radiative power", kind: "number", unit: "MW" },
    { field: "brightness", label: "Brightness", kind: "number", unit: "K" },
    { field: "confidence", label: "Confidence", kind: "text", options: ["low", "nominal", "high"] },
    { field: "daynight", label: "Day or night", kind: "text", options: ["Day", "Night"] },
  ],
  malware: [
    { field: "malware", label: "Family", kind: "text" },
    { field: "status", label: "Status", kind: "text", options: ["online", "offline"] },
    { field: "country", label: "Country", kind: "text" },
    { field: "asName", label: "Network", kind: "text" },
    { field: "urlCount", label: "Payload URLs", kind: "number" },
  ],
  cctv: [
    { field: "operator", label: "Operator", kind: "text" },
    { field: "country", label: "Country", kind: "text" },
    { field: "city", label: "City", kind: "text" },
  ],
  sigmets: [
    { field: "hazard", label: "Hazard", kind: "text", options: ["Thunderstorms", "Severe turbulence", "Icing", "Mountain wave", "Volcanic ash", "Tropical cyclone"] },
    { field: "fir", label: "Airspace", kind: "text" },
  ],
  volcanoes: [
    { field: "aviationColour", label: "Alert code", kind: "text", options: ["RED", "ORANGE", "YELLOW", "GREEN"] },
    { field: "country", label: "Country", kind: "text" },
    { field: "inWeeklyReport", label: "In this week's report", kind: "flag" },
  ],
  global_incidents: [
    { field: "alertLevel", label: "Alert level", kind: "text", options: ["Red", "Orange", "Green"] },
    { field: "category", label: "Category", kind: "text" },
    { field: "country", label: "Country", kind: "text" },
  ],
};

/** Layers that share a field vocabulary — the four aircraft tiers, and the SDK views. */
const ALIAS: Record<string, string> = {
  flights: "aircraft",
  private: "aircraft",
  jets: "aircraft",
  military: "aircraft",
  sdk_air: "aircraft",
  sdk_sea: "maritime",
  sdk_naval: "maritime",
  sat_comms: "satellites",
  sat_military: "satellites",
  sat_navigation: "satellites",
  sat_earth: "satellites",
  sat_science: "satellites",
  cyber_attacks: "malware",
};

export function fieldsFor(layerId: string): FieldDef[] {
  return FILTERABLE[ALIAS[layerId] ?? layerId] ?? [];
}

/**
 * One predicate as a MapLibre expression.
 *
 * `coalesce` on every read, because a missing property is null and every
 * comparison against null is false — which silently filters out exactly the
 * features whose field was not published, rather than leaving them in.
 */
const MISSING_LOW = -1e12;
const MISSING_HIGH = 1e12;

function compile(predicate: Predicate): unknown[] | null {
  const { field, operator, value } = predicate;
  const get = ["get", field];

  switch (operator) {
    case "exists":
      return ["all", ["has", field], ["!=", ["coalesce", get, ""], ""]];
    case "is":
      return ["==", ["coalesce", ["to-string", get], ""], value];
    case "not":
      return ["!=", ["coalesce", ["to-string", get], ""], value];
    case "contains":
      // MapLibre has no regex; substring matching is what `in` does on a
      // string haystack.
      return value.length === 0
        ? null
        : ["in", value.toUpperCase(), ["upcase", ["coalesce", ["to-string", get], ""]]];
    /*
     * A finite sentinel, not Infinity.
     *
     * The sentinel exists because a feature with no altitude is not at sea
     * level — it is unknown, and it must fail a "greater than" test rather
     * than pass a "less than" one. But `Infinity` cannot be used for it: a
     * MapLibre expression is JSON, and JSON has no infinity, so it serialises
     * to `null` and the comparison becomes undefined behaviour. These are
     * far outside any real value in any field here.
     */
    case "gte": {
      const n = Number(value);
      return Number.isFinite(n) ? [">=", ["coalesce", get, MISSING_LOW], n] : null;
    }
    case "lte": {
      const n = Number(value);
      return Number.isFinite(n) ? ["<=", ["coalesce", get, MISSING_HIGH], n] : null;
    }
    default:
      return null;
  }
}

/** All predicates, combined. Null means "no filter", which is not the same as "match nothing". */
export function compileAll(predicates: Predicate[]): unknown[] | null {
  const parts = predicates.map(compile).filter((p): p is unknown[] => p !== null);
  if (parts.length === 0) return null;
  return ["all", ...parts];
}

/** The same predicates in JavaScript, to count matches honestly. */
export function matches(
  properties: Record<string, unknown>,
  predicates: Predicate[],
): boolean {
  return predicates.every((predicate) => {
    const raw = properties[predicate.field];
    const text = raw === null || raw === undefined ? "" : String(raw);

    switch (predicate.operator) {
      case "exists":
        return text.length > 0 && text !== "false";
      case "is":
        return text === predicate.value;
      case "not":
        return text !== predicate.value;
      case "contains":
        return (
          predicate.value.length === 0 ||
          text.toUpperCase().includes(predicate.value.toUpperCase())
        );
      case "gte": {
        const n = Number(predicate.value);
        return Number.isFinite(n) && typeof raw === "number" && raw >= n;
      }
      case "lte": {
        const n = Number(predicate.value);
        return Number.isFinite(n) && typeof raw === "number" && raw <= n;
      }
      default:
        return true;
    }
  });
}

/** `?filter=layer:field:op:value` — so a filtered view is a link, like the layers are. */
export function filtersToSearch(
  active: string[],
  filters: Record<string, Predicate[]>,
): string {
  const layers = active.length === 0 ? "?layers=" : `?layers=${active.join(",")}`;
  const encoded = Object.entries(filters)
    .flatMap(([layerId, predicates]) =>
      predicates.map((p) =>
        [layerId, p.field, p.operator, p.value]
          .map((part) => encodeURIComponent(part))
          .join(":"),
      ),
    )
    .join(",");
  return encoded.length === 0 ? layers : `${layers}&filter=${encoded}`;
}

export function parseFilters(search: string): Record<string, Predicate[]> {
  /*
   * Read the parameter still encoded, deliberately.
   *
   * `URLSearchParams.get` decodes the whole value before it is returned,
   * which turns an escaped comma inside a value — a destination like
   * "ROTTERDAM, NL" — back into a literal one, and it is then
   * indistinguishable from the separator between clauses. Splitting first and
   * decoding each part afterwards is what keeps the two apart.
   */
  const match = /[?&]filter=([^&]*)/.exec(search);
  const raw = match?.[1];
  if (raw === undefined || raw.length === 0) return {};

  const out: Record<string, Predicate[]> = {};
  for (const clause of raw.split(",")) {
    const [layerId, field, operator, value] = clause
      .split(":")
      .map((part) => decodeURIComponent(part));
    if (layerId === undefined || field === undefined || operator === undefined) continue;
    // An unknown operator from a hand-edited link is dropped rather than
    // becoming a filter that matches nothing.
    if (!["is", "not", "gte", "lte", "contains", "exists"].includes(operator)) continue;

    (out[layerId] ??= []).push({
      field,
      operator: operator as Operator,
      value: value ?? "",
    });
  }
  return out;
}
