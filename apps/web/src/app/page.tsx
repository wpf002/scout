"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  CATEGORIES,
  LAYERS,
  LAYER_BY_ID,
  parseLayers,
  layersToSearch,
} from "@/lib/layers";
import type { BasemapId } from "@/lib/basemap";
import type { Selection } from "@/components/GlobeMap";
import { OsintPanel } from "@/components/OsintPanel";
import { Ticker, ZuluClock, type TickerItem } from "@/components/Hud";

/**
 * MapLibre touches `window` at import time, so it cannot be server-rendered.
 * Loading it dynamically also keeps the map bundle out of the first paint.
 */
const GlobeMap = dynamic(
  () => import("@/components/GlobeMap").then((m) => m.GlobeMap),
  { ssr: false },
);

const TOOLS = [
  { id: "osint", glyph: "◎", name: "OSINT Search" },
  { id: "alerts", glyph: "⚠", name: "Live Alerts" },
  { id: "layers", glyph: "≡", name: "Layers" },
];

export default function Page() {
  const [active, setActive] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<Record<string, number | string>>({});
  const [osintFeatures, setOsintFeatures] = useState<GeoJSON.Feature[]>([]);
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("sat");
  const [projection, setProjection] = useState<"globe" | "mercator">("globe");
  const [cursor, setCursor] = useState({ lat: 0, lon: 0, zoom: 3.2 });
  const [quakes, setQuakes] = useState<TickerItem[]>([]);

  // ── URL is the source of truth ───────────────────────────────────────────
  useEffect(() => {
    setActive(parseLayers(window.location.search));
    const onPop = () => setActive(parseLayers(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const toggle = useCallback((id: string) => {
    setActive((current) => {
      const next = current.includes(id)
        ? current.filter((layer) => layer !== id)
        : [...current, id];
      window.history.replaceState(null, "", layersToSearch(next));
      return next;
    });
  }, []);

  const onStatus = useCallback((patch: Record<string, number | string>) => {
    setStatus((current) => ({ ...current, ...patch }));
  }, []);

  const onLocated = useCallback((features: GeoJSON.Feature[]) => {
    setOsintFeatures(features);
  }, []);

  const onCursor = useCallback(
    (position: { lat: number; lon: number; zoom: number }) => setCursor(position),
    [],
  );

  // The ticker reads the same feed the map draws, so it cannot disagree with
  // what is on screen.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/live/earthquakes", { cache: "no-store" });
        const data = (await response.json()) as GeoJSON.FeatureCollection;
        if (cancelled) return;
        setQuakes(
          data.features.slice(0, 20).map((feature, index) => {
            const properties = (feature.properties ?? {}) as Record<string, unknown>;
            const magnitude = Number(properties["magnitude"] ?? 0);
            return {
              id: String(properties["id"] ?? index),
              label: `M${magnitude.toFixed(1)}  ${String(properties["label"] ?? "")}`,
              tone: magnitude >= 5 ? ("deny" as const) : ("warn" as const),
            };
          }),
        );
      } catch {
        // A quiet ticker beats an error bar across the bottom of the map.
      }
    };
    void load();
    const timer = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const entities = useMemo(
    () =>
      Object.entries(status).reduce<number>(
        (total, [id, value]) =>
          total + (active.includes(id) && typeof value === "number" ? value : 0),
        0,
      ),
    [status, active],
  );

  const countFor = (layerId: string) => {
    const value = status[layerId];
    return typeof value === "number" ? value : null;
  };

  const activeInCategory = (ids: string[]) =>
    ids.filter((id) => active.includes(id)).length;

  return (
    <div className="osiris">
      <GlobeMap
        active={active}
        basemap={basemap}
        projection={projection}
        osintFeatures={osintFeatures}
        onSelect={setSelection}
        onStatus={onStatus}
        onCursor={onCursor}
      />

      {/* ── Top HUD ────────────────────────────────────────────────────── */}
      <header className="hud-top">
        <div className="brand">
          <span className="brand-mark">SCOUT</span>
          <span className="brand-sub">Open Source Intelligence</span>
        </div>
        <div className="hud-readout">
          <ZuluClock />
          <span>
            STATUS <b className="live">LIVE</b>
          </span>
          <span>
            <b>{active.length}</b> LAYERS
          </span>
          <span>
            <b>{entities.toLocaleString()}</b> ENTITIES
          </span>
        </div>
      </header>

      {/* ── Left category rail ─────────────────────────────────────────── */}
      <nav className="cat-rail">
        {CATEGORIES.map((category) => {
          const on = activeInCategory(category.layerIds);
          return (
            <button
              key={category.id}
              className={`cat-icon${openCategory === category.id ? " open" : ""}${on > 0 ? " lit" : ""}`}
              onClick={() =>
                setOpenCategory((current) =>
                  current === category.id ? null : category.id,
                )
              }
              title={category.name}
            >
              <span className="cat-glyph">{category.glyph}</span>
              {on > 0 ? <span className="cat-badge">{on}</span> : null}
            </button>
          );
        })}
      </nav>

      {/* ── Category panel ─────────────────────────────────────────────── */}
      {openCategory !== null ? (
        <section className="cat-panel">
          <div className="cat-panel-head">
            <h2>{CATEGORIES.find((c) => c.id === openCategory)?.name}</h2>
            <button className="link" onClick={() => setOpenCategory(null)}>
              ×
            </button>
          </div>
          <ul>
            {(CATEGORIES.find((c) => c.id === openCategory)?.layerIds ?? []).map(
              (layerId) => {
                const layer = LAYER_BY_ID.get(layerId);
                if (layer === undefined) return null;
                const on = active.includes(layerId);
                const count = countFor(layerId);
                return (
                  <li key={layerId}>
                    <button
                      className={`switch${on ? " on" : ""}`}
                      onClick={() => toggle(layerId)}
                      aria-pressed={on}
                      title={layer.description}
                    >
                      <span className="knob" />
                    </button>
                    <span className="switch-name">{layer.name}</span>
                    <span className="switch-count">
                      {on ? (count?.toLocaleString() ?? "…") : ""}
                    </span>
                  </li>
                );
              },
            )}
          </ul>
        </section>
      ) : null}

      {/* ── Right tool rail ────────────────────────────────────────────── */}
      <nav className="tool-rail">
        {TOOLS.map((item) => (
          <button
            key={item.id}
            className={`tool-icon${tool === item.id ? " on" : ""}`}
            onClick={() =>
              setTool((current) => (current === item.id ? null : item.id))
            }
            title={item.name}
          >
            {item.glyph}
          </button>
        ))}
      </nav>

      {/* ── View controls ──────────────────────────────────────────────── */}
      <div className="view-switch">
        <button
          className={projection === "globe" ? "on" : undefined}
          onClick={() => setProjection("globe")}
        >
          3D
        </button>
        <button
          className={projection === "mercator" ? "on" : undefined}
          onClick={() => setProjection("mercator")}
        >
          2D
        </button>
        <button
          className={basemap === "map" ? "on" : undefined}
          onClick={() => setBasemap("map")}
        >
          MAP
        </button>
        <button
          className={basemap === "sat" ? "on" : undefined}
          onClick={() => setBasemap("sat")}
        >
          SAT
        </button>
      </div>

      {/* ── Cursor readout ─────────────────────────────────────────────── */}
      <div className="cursor-readout">
        <span>
          CURSOR <b>{cursor.lat.toFixed(4)}, {cursor.lon.toFixed(4)}</b>
        </span>
        <span>
          ZOOM <b>{cursor.zoom.toFixed(1)}</b>
        </span>
      </div>

      {/* ── Tool panels ────────────────────────────────────────────────── */}
      {tool === "layers" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>All Layers</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <ul className="layer-list">
            {LAYERS.map((layer) => {
              const on = active.includes(layer.id);
              const count = countFor(layer.id);
              return (
                <li key={layer.id}>
                  <button
                    className={`switch${on ? " on" : ""}`}
                    onClick={() => toggle(layer.id)}
                    aria-pressed={on}
                  >
                    <span className="knob" />
                  </button>
                  <span className="swatch-dot" style={{ background: layer.colour }} />
                  <span className="switch-name">{layer.name}</span>
                  <span className="switch-count">
                    {on ? (count?.toLocaleString() ?? "…") : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {tool === "osint" ? (
        <section className="tool-panel wide">
          <div className="tool-panel-head">
            <h2>OSINT Search</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <div className="tool-panel-body">
            <OsintPanel onLocated={onLocated} />
          </div>
        </section>
      ) : null}

      {tool === "alerts" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Live Alerts</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <ul className="alert-list">
            {quakes.slice(0, 12).map((item) => (
              <li key={item.id}>
                <span className={`tick-dot ${item.tone ?? ""}`} />
                {item.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ── Feature detail ─────────────────────────────────────────────── */}
      {selection !== null ? (
        <aside className="hud-detail">
          <div className="hud-detail-head">
            <span
              className="hud-dot"
              style={{
                background: LAYER_BY_ID.get(selection.layer)?.colour ?? "#8e8e93",
              }}
            />
            <h2>{selection.label}</h2>
            <button className="link" onClick={() => setSelection(null)}>×</button>
          </div>
          <dl>
            {Object.entries(selection.properties)
              .filter(([key]) => key !== "label" && key !== "layer")
              .slice(0, 12)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
          </dl>
        </aside>
      ) : null}

      <Ticker items={quakes} />
    </div>
  );
}
