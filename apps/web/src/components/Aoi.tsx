"use client";

import { useCallback, useMemo, useState } from "react";
import { LAYER_BY_ID } from "@/lib/layers";
import { area as sphericalArea, formatArea, type Point } from "@/lib/measure";

/**
 * Draw a box, and ask what is inside it.
 *
 * This is the verb the map was missing. Scout could measure a distance but not
 * select a place — and "what is in here" is the question an operator actually
 * has when they look at an airbase, a port or a border crossing.
 *
 * Two sources answer it, and they answer differently. The live layers are
 * already held in the browser, so counting what is in the box costs nothing
 * and is exact as of the last refresh. Fixed infrastructure comes from
 * OpenStreetMap, which is crowd-sourced — so it is fetched on request, cached,
 * and labelled as what it is. A feature missing from OSM is not evidence that
 * it is not there.
 */

export interface Box {
  south: number;
  west: number;
  north: number;
  east: number;
}

const CATEGORIES = [
  { id: "power", name: "Power" },
  { id: "aviation", name: "Aviation" },
  { id: "military", name: "Military" },
  { id: "maritime", name: "Ports" },
  { id: "telecom", name: "Telecoms" },
  { id: "emergency", name: "Emergency" },
];

function inBox(box: Box, lon: number, lat: number): boolean {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}

export function Aoi({
  box,
  drawing,
  setDrawing,
  clear,
  held,
  active,
  onInfrastructure,
  onFly,
}: {
  box: Box | null;
  drawing: boolean;
  setDrawing: (on: boolean) => void;
  clear: () => void;
  held: Map<string, GeoJSON.Feature[]>;
  active: string[];
  onInfrastructure: (features: GeoJSON.Feature[]) => void;
  onFly: (place: { lat: number; lon: number; zoom?: number }) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(CATEGORIES.map((c) => c.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infra, setInfra] = useState<Record<string, number> | null>(null);

  /** What the live layers already hold inside the box. No request needed. */
  const inside = useMemo(() => {
    if (box === null) return [];
    return active
      .map((layerId) => {
        const features = held.get(layerId) ?? [];
        const count = features.filter((feature) => {
          if (feature.geometry.type !== "Point") return false;
          const [lon, lat] = feature.geometry.coordinates;
          return typeof lon === "number" && typeof lat === "number" && inBox(box, lon, lat);
        }).length;
        return { layerId, count, total: features.length };
      })
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [box, held, active]);

  const size = useMemo(() => {
    if (box === null) return null;
    const ring: Point[] = [
      { lon: box.west, lat: box.south },
      { lon: box.east, lat: box.south },
      { lon: box.east, lat: box.north },
      { lon: box.west, lat: box.north },
    ];
    return formatArea(sphericalArea(ring));
  }, [box]);

  const ask = useCallback(async () => {
    if (box === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/aoi/infrastructure?south=${box.south}&west=${box.west}&north=${box.north}&east=${box.east}&categories=${chosen.join(",")}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        features?: GeoJSON.Feature[];
        meta?: { byCategory?: Record<string, number> };
        error?: string;
        message?: string;
      };
      if (data.error !== undefined || data.message !== undefined) {
        setError(data.error ?? data.message ?? "Could not query OpenStreetMap.");
        return;
      }
      onInfrastructure(data.features ?? []);
      setInfra(data.meta?.byCategory ?? {});
    } catch {
      setError("OpenStreetMap did not answer.");
    } finally {
      setBusy(false);
    }
  }, [box, chosen, onInfrastructure]);

  return (
    <div className="aoi">
      <div className="measure-shapes">
        <button
          className={drawing ? "on" : undefined}
          onClick={() => setDrawing(!drawing)}
        >
          {drawing ? "Drawing…" : "Draw a box"}
        </button>
        <button
          onClick={() => {
            clear();
            setInfra(null);
            onInfrastructure([]);
            setError(null);
          }}
          disabled={box === null}
        >
          Clear
        </button>
      </div>

      {box === null ? (
        <p className="measure-hint">
          {drawing
            ? "Click two opposite corners on the map."
            : "Draw a box to ask what is inside it."}
        </p>
      ) : (
        <>
          <p className="measure-reading">
            {size} · {box.south.toFixed(3)}, {box.west.toFixed(3)} to{" "}
            {box.north.toFixed(3)}, {box.east.toFixed(3)}
          </p>

          <h3 className="aoi-head">In view now</h3>
          {inside.length === 0 ? (
            <p className="measure-hint">
              Nothing from the active layers is inside this box.
            </p>
          ) : (
            <ul className="aoi-list">
              {inside.map((row) => (
                <li key={row.layerId}>
                  <span
                    className="swatch-dot"
                    style={{ background: LAYER_BY_ID.get(row.layerId)?.colour }}
                  />
                  <span className="aoi-name">
                    {LAYER_BY_ID.get(row.layerId)?.name ?? row.layerId}
                  </span>
                  <span className="aoi-count">
                    {row.count.toLocaleString()}
                    <span className="aoi-total"> of {row.total.toLocaleString()}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="aoi-head">Fixed infrastructure</h3>
          <div className="aoi-categories">
            {CATEGORIES.map((category) => (
              <button
                key={category.id}
                className={chosen.includes(category.id) ? "on" : undefined}
                onClick={() =>
                  setChosen((current) =>
                    current.includes(category.id)
                      ? current.filter((c) => c !== category.id)
                      : [...current, category.id],
                  )
                }
              >
                {category.name}
              </button>
            ))}
          </div>

          <div className="directions-actions">
            <button
              className="primary"
              onClick={() => void ask()}
              disabled={busy || chosen.length === 0}
            >
              {busy ? "Asking OpenStreetMap…" : "What is in here"}
            </button>
            <button
              onClick={() =>
                onFly({
                  lat: (box.south + box.north) / 2,
                  lon: (box.west + box.east) / 2,
                  zoom: 11,
                })
              }
            >
              Centre
            </button>
          </div>

          {error !== null ? <p className="directions-error">{error}</p> : null}

          {infra !== null ? (
            Object.keys(infra).length === 0 ? (
              <p className="measure-hint">
                OpenStreetMap has nothing tagged in these categories inside this
                box. That is not evidence that nothing is there.
              </p>
            ) : (
              <ul className="aoi-list">
                {Object.entries(infra)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, count]) => (
                    <li key={name}>
                      <span className="aoi-name">{name}</span>
                      <span className="aoi-count">{count.toLocaleString()}</span>
                    </li>
                  ))}
              </ul>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
