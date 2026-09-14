"use client";

import { useState } from "react";

/**
 * ArcGIS Living Atlas — search the public catalogue and put a layer on the map.
 *
 * The catalogue is keyless, but most of what it lists is token-gated at the
 * data layer even where the metadata is public, so the server pins
 * `access:public` on the search. A service that still refuses says so on
 * import rather than importing as an empty layer.
 */
interface Item {
  id: string;
  title: string;
  owner: string;
  snippet: string | null;
  views: number;
  tags: string[];
  url: string;
}

const CHIPS = [
  ["Pipelines", "pipeline"],
  ["Power Grid", "electric transmission"],
  ["Infrastructure", "critical infrastructure"],
  ["Military", "military installation"],
  ["Emergency", "emergency shelter evacuation"],
] as const;

export function ArcGisPanel({
  onImport,
}: {
  onImport: (features: GeoJSON.Feature[], title: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function search(term: string) {
    const q = term.trim();
    if (q === "") return;
    setQuery(q);
    setBusy(true);
    setNote(null);
    setItems(null);
    try {
      const response = await fetch(`/api/live/arcgis/search?q=${encodeURIComponent(q)}`);
      const body = (await response.json()) as { results?: Item[]; message?: string };
      if (!response.ok) throw new Error(body.message ?? "Search failed.");
      setItems(body.results ?? []);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function bring(item: Item) {
    setImporting(item.id);
    setNote(null);
    try {
      const response = await fetch(`/api/live/arcgis/features?url=${encodeURIComponent(item.url)}&limit=2000`);
      const body = (await response.json()) as { features?: GeoJSON.Feature[]; message?: string };
      if (!response.ok) throw new Error(body.message ?? "Import failed.");
      const features = body.features ?? [];
      if (features.length === 0) {
        setNote(`${item.title} returned no features.`);
        return;
      }
      onImport(features, item.title);
      setNote(`${item.title}: ${features.length} features on the map.`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImporting(null);
    }
  }

  return (
    <div className="arcgis-panel">
      <div className="arcgis-form">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void search(query);
          }}
          placeholder="Search public layers"
          aria-label="Search ArcGIS layers"
          spellCheck={false}
        />
        <button type="button" onClick={() => void search(query)} disabled={busy || query.trim() === ""}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>

      <div className="arcgis-chips">
        {CHIPS.map(([label, term]) => (
          <button key={label} type="button" onClick={() => void search(term)} disabled={busy}>
            {label}
          </button>
        ))}
      </div>

      {note !== null ? <p className="arcgis-note">{note}</p> : null}

      {items === null ? (
        <p className="panel-empty">Search the public ArcGIS catalogue, then import a layer onto the map.</p>
      ) : items.length === 0 ? (
        <p className="panel-empty">Nothing public matched that.</p>
      ) : (
        <ul className="arcgis-list">
          {items.map((item) => (
            <li key={item.id}>
              <div className="ag-head">
                <span className="ag-title">{item.title}</span>
                <button type="button" onClick={() => void bring(item)} disabled={importing !== null}>
                  {importing === item.id ? "Importing…" : "Import"}
                </button>
              </div>
              <div className="ag-meta">
                {item.owner} · {item.views.toLocaleString()} views
              </div>
              {item.snippet !== null ? <p className="ag-snippet">{item.snippet}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
