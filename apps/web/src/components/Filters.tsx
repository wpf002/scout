"use client";

import { useMemo, useState } from "react";
import { LAYER_BY_ID } from "@/lib/layers";
import { fieldsFor, matches, type Operator, type Predicate } from "@/lib/filters";

/**
 * The filter panel.
 *
 * One layer at a time, because a predicate only means anything against a
 * vocabulary — "above 30,000 ft" is a question you ask aircraft, not fires.
 *
 * The match count is the load-bearing part. A filter that matches nothing and
 * a feed that died look identical on a map, so every filtered layer says how
 * many of how many it is drawing. A filter without a denominator is how an
 * operator talks themselves into believing an empty sky.
 */

const OPERATORS: Array<{ id: Operator; label: string; kinds: string[] }> = [
  { id: "is", label: "is", kinds: ["text", "number"] },
  { id: "not", label: "is not", kinds: ["text"] },
  { id: "contains", label: "contains", kinds: ["text"] },
  { id: "gte", label: "at least", kinds: ["number"] },
  { id: "lte", label: "at most", kinds: ["number"] },
  { id: "exists", label: "is present", kinds: ["flag", "text"] },
];

export function Filters({
  active,
  filters,
  setFilters,
  held,
}: {
  active: string[];
  filters: Record<string, Predicate[]>;
  setFilters: (next: Record<string, Predicate[]>) => void;
  /** Everything each layer returned, for an honest denominator. */
  held: Map<string, GeoJSON.Feature[]>;
}) {
  const filterable = active.filter((id) => fieldsFor(id).length > 0);
  const [layerId, setLayerId] = useState<string>(filterable[0] ?? "");

  const chosen = filterable.includes(layerId) ? layerId : (filterable[0] ?? "");
  const fields = fieldsFor(chosen);
  const predicates = filters[chosen] ?? [];

  const counts = useMemo(() => {
    const features = held.get(chosen) ?? [];
    if (features.length === 0) return null;
    if (predicates.length === 0) return { shown: features.length, total: features.length };
    const shown = features.filter((f) =>
      matches((f.properties ?? {}) as Record<string, unknown>, predicates),
    ).length;
    return { shown, total: features.length };
  }, [held, chosen, predicates]);

  const update = (next: Predicate[]) => {
    const merged = { ...filters };
    if (next.length === 0) delete merged[chosen];
    else merged[chosen] = next;
    setFilters(merged);
  };

  if (filterable.length === 0) {
    return (
      <p className="panel-empty">
        Turn on a layer that carries attributes — aircraft, vessels, satellites,
        fires — and its fields appear here.
      </p>
    );
  }

  return (
    <div className="filters">
      <select
        className="filter-layer"
        value={chosen}
        onChange={(event) => setLayerId(event.target.value)}
      >
        {filterable.map((id) => (
          <option key={id} value={id}>
            {LAYER_BY_ID.get(id)?.name ?? id}
          </option>
        ))}
      </select>

      {counts !== null ? (
        <p
          className={`filter-count${counts.shown === 0 && predicates.length > 0 ? " none" : ""}`}
        >
          {predicates.length === 0
            ? `${counts.total.toLocaleString()} features`
            : `${counts.shown.toLocaleString()} of ${counts.total.toLocaleString()} shown`}
        </p>
      ) : null}

      <ul className="filter-list">
        {predicates.map((predicate, index) => {
          const field = fields.find((f) => f.field === predicate.field);
          const allowed = OPERATORS.filter((o) =>
            o.kinds.includes(field?.kind ?? "text"),
          );

          return (
            <li key={index}>
              <select
                value={predicate.field}
                onChange={(event) => {
                  const next = [...predicates];
                  next[index] = { ...predicate, field: event.target.value, value: "" };
                  update(next);
                }}
              >
                {fields.map((f) => (
                  <option key={f.field} value={f.field}>
                    {f.label}
                  </option>
                ))}
              </select>

              <select
                value={predicate.operator}
                onChange={(event) => {
                  const next = [...predicates];
                  next[index] = {
                    ...predicate,
                    operator: event.target.value as Operator,
                  };
                  update(next);
                }}
              >
                {allowed.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>

              {predicate.operator === "exists" ? null : field?.options !== undefined ? (
                <select
                  value={predicate.value}
                  onChange={(event) => {
                    const next = [...predicates];
                    next[index] = { ...predicate, value: event.target.value };
                    update(next);
                  }}
                >
                  <option value="">—</option>
                  {field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={predicate.value}
                  placeholder={field?.unit ?? "value"}
                  inputMode={field?.kind === "number" ? "decimal" : "text"}
                  onChange={(event) => {
                    const next = [...predicates];
                    next[index] = { ...predicate, value: event.target.value };
                    update(next);
                  }}
                />
              )}

              <button
                className="pick"
                title="Remove"
                onClick={() => update(predicates.filter((_, i) => i !== index))}
              >
                −
              </button>
            </li>
          );
        })}
      </ul>

      {predicates.length > 0 &&
      fields.find((f) => f.field === predicates[predicates.length - 1]?.field)?.hint !==
        undefined ? (
        <p className="measure-hint">
          {fields.find((f) => f.field === predicates[predicates.length - 1]?.field)?.hint}
        </p>
      ) : null}

      <div className="directions-actions">
        <button
          onClick={() => {
            const first = fields[0];
            if (first === undefined) return;
            update([
              ...predicates,
              {
                field: first.field,
                operator: first.kind === "number" ? "gte" : "is",
                value: "",
              },
            ]);
          }}
          disabled={fields.length === 0}
        >
          Add a condition
        </button>
        <button onClick={() => update([])} disabled={predicates.length === 0}>
          Clear
        </button>
      </div>
    </div>
  );
}
