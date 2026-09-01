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
import { Search } from "@/components/Search";
import { Detail } from "@/components/Detail";
import { Directions, type Route, type Stop } from "@/components/Directions";
import { Minimap } from "@/components/Minimap";
import { useAlerts, ago } from "@/lib/alerts";
import type { Shape } from "@/lib/measure";

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
  { id: "measure", glyph: "⊹", name: "Measure" },
  { id: "directions", glyph: "⇄", name: "Directions" },
  { id: "intel", glyph: "◫", name: "Intel Feed" },
  { id: "layers", glyph: "≡", name: "All Layers" },
];

const SHAPES: Array<{ id: Shape; name: string; hint: string }> = [
  { id: "radius", name: "Radius", hint: "Centre, then edge." },
  { id: "box", name: "Box", hint: "Two opposite corners." },
  { id: "path", name: "Path", hint: "Click each leg." },
];

interface Headline {
  id: string;
  title: string;
  url: string | null;
  source: string;
  category: string;
  at: number | null;
}

interface Quote {
  symbol: string;
  name: string;
  price: number;
  changePercent: number | null;
}

export default function Page() {
  const [active, setActive] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [status, setStatus] = useState<Record<string, number | string>>({});
  const [osintFeatures, setOsintFeatures] = useState<GeoJSON.Feature[]>([]);
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [tool, setTool] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapId>("sat");
  const [projection, setProjection] = useState<"globe" | "mercator">("globe");
  const [cursor, setCursor] = useState({ lat: 0, lon: 0, zoom: 2.2 });
  const [flyTo, setFlyTo] = useState<{
    lat: number;
    lon: number;
    zoom?: number;
  } | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [seeded, setSeeded] = useState("");
  const [measure, setMeasure] = useState<Shape | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [route, setRoute] = useState<Route | null>(null);
  const [stops, setStops] = useState<Array<Stop | null>>([null, null]);
  const [picking, setPicking] = useState<number | null>(null);
  const [headlines, setHeadlines] = useState<Headline[]>([]);
  const [centre, setCentre] = useState({ lat: 25, lon: -40 });
  const [kp, setKp] = useState<{ kp: number | null; level: string } | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});

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

  /**
   * Where the camera is pointed, in words. Keyed off the settled centre rather
   * than the cursor: this is a geocoder call, and one per mouse move would be
   * both useless and a good way to be blocked.
   */
  const onCentre = useCallback(async (centre: { lat: number; lon: number }) => {
    setCentre(centre);
    try {
      const response = await fetch(
        `/api/geo/reverse?lat=${centre.lat.toFixed(3)}&lon=${centre.lon.toFixed(3)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as { label?: string | null };
      setPlace(data.label ?? null);
    } catch {
      setPlace(null);
    }
  }, []);

  // An indicator typed into the map's search box belongs to the OSINT panel.
  const onIndicator = useCallback((value: string) => {
    setSeeded(value);
    setTool("osint");
  }, []);

  /**
   * A stop picked off the map is named by reverse geocoding it, so the panel
   * reads "Greenwood County, Kansas" rather than a coordinate pair the
   * operator has to decode.
   */
  const onPick = useCallback(
    async (index: number, lngLat: { lat: number; lon: number }) => {
      let label = `${lngLat.lat.toFixed(4)}, ${lngLat.lon.toFixed(4)}`;
      try {
        const response = await fetch(
          `/api/geo/reverse?lat=${lngLat.lat.toFixed(4)}&lon=${lngLat.lon.toFixed(4)}`,
          { cache: "no-store" },
        );
        const data = (await response.json()) as { label?: string | null };
        if (typeof data.label === "string" && data.label.length > 0) {
          label = data.label;
        }
      } catch {
        // The coordinate is a perfectly good name for a place.
      }
      setStops((current) => {
        const next = [...current];
        next[index] = { label, lat: lngLat.lat, lon: lngLat.lon };
        return next;
      });
      setPicking(null);
    },
    [],
  );

  /*
   * What this deployment can actually offer. Layers needing a capability the
   * server does not have are dropped from the rail entirely rather than shown
   * and permanently failing.
   */
  useEffect(() => {
    void fetch("/api/live/layers", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ capabilities?: Record<string, boolean> }>)
      .then((d) => setCapabilities(d.capabilities ?? {}))
      .catch(() => setCapabilities({}));
  }, []);

  const offered = useCallback(
    (layerId: string) => {
      const layer = LAYER_BY_ID.get(layerId);
      if (layer === undefined) return false;
      return layer.requires === undefined || capabilities[layer.requires] === true;
    },
    [capabilities],
  );

  // Headlines are only fetched while the panel that shows them is open. A
  // crawl nobody is reading should not be pulling six RSS feeds on a timer.
  useEffect(() => {
    if (tool !== "intel") return;
    let cancelled = false;
    const load = () =>
      fetch("/api/live/news", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ headlines?: Headline[] }>)
        .then((d) => {
          if (!cancelled) setHeadlines(d.headlines ?? []);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tool]);

  const alerts = useAlerts(active);

  // ── Ticker and HUD readings ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [marketResult, spaceResult] = await Promise.allSettled([
        fetch("/api/live/markets", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/live/space_weather", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (cancelled) return;

      if (marketResult.status === "fulfilled") {
        setQuotes((marketResult.value as { quotes?: Quote[] }).quotes ?? []);
      }
      if (spaceResult.status === "fulfilled") {
        const meta = (spaceResult.value as { meta?: { kp?: number | null; stormLevel?: string } }).meta;
        if (meta !== undefined) {
          setKp({ kp: meta.kp ?? null, level: meta.stormLevel ?? "Unknown" });
        }
      }
    };
    void load();
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /*
   * One crawl, two kinds of thing. Alerts first because they are the reason to
   * look at it; markets after, because an operator watching an incident still
   * wants to know oil moved.
   */
  const ticker: TickerItem[] = useMemo(
    () => [
      ...alerts.slice(0, 20).map((alert) => ({
        id: alert.id,
        label: `${alert.detail}  ${alert.label}`,
        tone:
          alert.severity === "high"
            ? ("deny" as const)
            : alert.severity === "medium"
              ? ("warn" as const)
              : ("ok" as const),
      })),
      ...quotes.map((quote) => ({
        id: `q-${quote.symbol}`,
        label: `${quote.name} ${quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}${
          quote.changePercent === null
            ? ""
            : `  ${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%`
        }`,
        tone:
          quote.changePercent === null
            ? undefined
            : quote.changePercent >= 0
              ? ("ok" as const)
              : ("deny" as const),
      })),
    ],
    [alerts, quotes],
  );

  /**
   * Everything currently on screen, as a file.
   *
   * The export is the layers that are on, their counts, the view, and any
   * measurement or route — enough for someone to reconstruct what was being
   * looked at. It is written from state already held rather than by refetching,
   * so it always matches the screen it came from.
   */
  const exportView = useCallback(() => {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      view: {
        centre,
        zoom: cursor.zoom,
        projection,
        basemap,
        place,
      },
      layers: active.map((id) => ({
        id,
        name: LAYER_BY_ID.get(id)?.name ?? id,
        features: status[id] ?? null,
      })),
      alerts: alerts.slice(0, 50),
      measurement: reading,
      route:
        route === null
          ? null
          : {
              distanceM: route.distanceM,
              durationS: route.durationS,
              stops: stops.filter(Boolean),
            },
      url: window.location.href,
    };

    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `scout-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z.json`;
    link.click();
    URL.revokeObjectURL(url);
  }, [active, alerts, basemap, centre, cursor.zoom, place, projection, reading, route, status, stops]);

  /**
   * Keyboard shortcuts.
   *
   * Deliberately ignored while a field has focus — an operator typing a place
   * name into the search box should not toggle a layer with every letter.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case "Escape":
          setTool(null);
          setOpenCategory(null);
          setSelection(null);
          setMeasure(null);
          setPicking(null);
          break;
        case "l":
          setTool((c) => (c === "layers" ? null : "layers"));
          break;
        case "a":
          setTool((c) => (c === "alerts" ? null : "alerts"));
          break;
        case "i":
          setTool((c) => (c === "intel" ? null : "intel"));
          break;
        case "m":
          setTool((c) => (c === "measure" ? null : "measure"));
          break;
        case "d":
          setTool((c) => (c === "directions" ? null : "directions"));
          break;
        case "o":
          setTool((c) => (c === "osint" ? null : "osint"));
          break;
        case "3":
          setProjection("globe");
          break;
        case "2":
          setProjection("mercator");
          break;
        case "s":
          setBasemap((c) => (c === "sat" ? "map" : "sat"));
          break;
        case "f":
          if (document.fullscreenElement === null) {
            void document.documentElement.requestFullscreen().catch(() => undefined);
          } else {
            void document.exitFullscreen().catch(() => undefined);
          }
          break;
        case "e":
          exportView();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportView]);

  const entities = useMemo(
    () =>
      Object.entries(status).reduce<number>(
        (total, [id, value]) =>
          total + (active.includes(id) && typeof value === "number" ? value : 0),
        0,
      ),
    [status, active],
  );

  const countFor = (layerId: string) => status[layerId];
  const activeInCategory = (ids: string[]) =>
    ids.filter((id) => active.includes(id) && offered(id)).length;

  const switchRow = (layerId: string) => {
    const layer = LAYER_BY_ID.get(layerId);
    if (layer === undefined || !offered(layerId)) return null;
    const on = active.includes(layerId);
    const count = countFor(layerId);
    const failed = typeof count === "string";

    // A child toggle does nothing on its own — it modifies its parent — so it
    // is shown as subordinate and disabled while the parent is off.
    const parentOff =
      layer.parent !== undefined && !active.includes(layer.parent);

    return (
      <li
        key={layerId}
        className={[
          failed && on ? "failed" : "",
          layer.parent !== undefined ? "child" : "",
          parentOff ? "muted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <button
          className={`switch${on && !parentOff ? " on" : ""}`}
          onClick={() => toggle(layerId)}
          aria-pressed={on}
          aria-label={layer.name}
          disabled={parentOff}
        >
          <span className="knob" />
        </button>
        <span className="swatch-dot" style={{ background: layer.colour }} />
        <span className="switch-name" title={layer.description}>
          {layer.name}
        </span>
        <span className="switch-count">
          {!on ? "" : count === undefined ? "…" : failed ? String(count) : count.toLocaleString()}
        </span>
      </li>
    );
  };

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
        flyTo={flyTo}
        onCentre={onCentre}
        measure={measure}
        onMeasure={setReading}
        route={route}
        stops={stops}
        picking={picking}
        onPick={onPick}
      />

      {/* ── Top HUD ────────────────────────────────────────────────────── */}
      <header className="hud-top">
        <div className="brand">
          <span className="brand-mark">SCOUT</span>
          <span className="brand-sub">Global Intelligence</span>
        </div>

        <Search onFly={setFlyTo} onIndicator={onIndicator} />

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
          {kp !== null ? (
            <span title={`Geomagnetic activity: ${kp.level}`}>
              SOLAR <b>Kp {kp.kp ?? "?"}</b>
            </span>
          ) : null}
        </div>
      </header>

      {/* ── Left category rail ─────────────────────────────────────────── */}
      <nav className="cat-rail" aria-label="Layer categories">
        {CATEGORIES.filter((c) => c.layerIds.some(offered)).map((category) => {
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
              switchRow,
            )}
          </ul>
        </section>
      ) : null}

      {/* ── Right tool rail ────────────────────────────────────────────── */}
      <nav className="tool-rail" aria-label="Tools">
        {TOOLS.map((item) => {
          const high =
            item.id === "alerts"
              ? alerts.filter((alert) => alert.severity === "high").length
              : 0;
          return (
            <button
              key={item.id}
              className={`tool-icon${tool === item.id ? " on" : ""}`}
              onClick={() =>
                setTool((current) => {
                  const next = current === item.id ? null : item.id;
                  // Leaving the measure panel leaves measure mode. A crosshair
                  // that outlives its panel eats clicks meant for features.
                  if (next !== "measure") setMeasure(null);
                  // A pick mode that outlives its panel eats clicks meant for
                  // features, exactly as a stray crosshair does.
                  if (next !== "directions") setPicking(null);
                  return next;
                })
              }
              title={item.name}
            >
              {item.glyph}
              {high > 0 ? <span className="cat-badge">{high}</span> : null}
            </button>
          );
        })}
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
          CURSOR{" "}
          <b>
            {cursor.lat.toFixed(4)}, {cursor.lon.toFixed(4)}
          </b>
        </span>
        {place !== null ? (
          <span>
            LOCATION <b>{place}</b>
          </span>
        ) : null}
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
          <ul className="layer-list">{LAYERS.map((layer) => switchRow(layer.id))}</ul>
        </section>
      ) : null}

      {tool === "measure" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Measure</h2>
            <button
              className="link"
              onClick={() => {
                setTool(null);
                setMeasure(null);
              }}
            >
              ×
            </button>
          </div>
          <div className="measure-body">
            <div className="measure-shapes">
              {SHAPES.map((shape) => (
                <button
                  key={shape.id}
                  className={measure === shape.id ? "on" : undefined}
                  onClick={() =>
                    setMeasure((current) =>
                      current === shape.id ? null : shape.id,
                    )
                  }
                >
                  {shape.name}
                </button>
              ))}
            </div>
            <p className="measure-hint">
              {measure === null
                ? "Pick a shape, then click the map."
                : (SHAPES.find((s) => s.id === measure)?.hint ?? "")}
            </p>
            {reading !== null ? (
              <p className="measure-reading">{reading}</p>
            ) : null}
          </div>
        </section>
      ) : null}

      {tool === "directions" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Directions</h2>
            <button
              className="link"
              onClick={() => {
                setTool(null);
                setPicking(null);
              }}
            >
              ×
            </button>
          </div>
          <Directions
            stops={stops}
            setStops={setStops}
            picking={picking}
            setPicking={setPicking}
            onRoute={setRoute}
            onFly={setFlyTo}
          />
        </section>
      ) : null}

      {tool === "osint" ? (
        <section className="tool-panel wide">
          <div className="tool-panel-head">
            <h2>OSINT Search</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <div className="tool-panel-body">
            <OsintPanel onLocated={onLocated} initialQuery={seeded} />
          </div>
        </section>
      ) : null}

      {tool === "alerts" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Live Alerts</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          {alerts.length === 0 ? (
            <p className="panel-empty">No alerts from the layers currently on.</p>
          ) : (
            <ul className="alert-list">
              {alerts.map((alert) => (
                <li key={`${alert.layer}:${alert.id}`}>
                  <button
                    type="button"
                    onClick={() =>
                      setFlyTo({ lat: alert.lat, lon: alert.lon, zoom: 7 })
                    }
                    title={alert.label}
                  >
                    <span className={`sev ${alert.severity}`} />
                    <span className="alert-detail">{alert.detail}</span>
                    <span className="alert-label">{alert.label}</span>
                    <span className="alert-age">{ago(alert.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {tool === "intel" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Intel Feed</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          {headlines.length === 0 ? (
            <p className="panel-empty">Loading headlines…</p>
          ) : (
            <ul className="intel-list">
              {headlines.slice(0, 80).map((item) => (
                <li key={item.id}>
                  <a
                    href={item.url ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <span className="intel-title">{item.title}</span>
                    <span className="intel-meta">
                      <span
                        className={`intel-source${item.category === "security" ? " security" : ""}`}
                      >
                        {item.source}
                      </span>
                      <span>{ago(item.at)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {selection !== null ? (
        <Detail
          selection={selection}
          onClose={() => setSelection(null)}
          onFly={setFlyTo}
        />
      ) : null}

      <div className="corner-tools">
        <Minimap
          centre={centre}
          zoom={cursor.zoom}
          onJump={(place) => setFlyTo({ ...place, zoom: 4 })}
        />
        <div className="corner-buttons">
          <button
            onClick={() => {
              if (document.fullscreenElement === null) {
                void document.documentElement.requestFullscreen().catch(() => undefined);
              } else {
                void document.exitFullscreen().catch(() => undefined);
              }
            }}
            title="Full screen (F)"
          >
            ⛶
          </button>
          <button onClick={exportView} title="Export this view (E)">
            ↧
          </button>
        </div>
      </div>

      <Ticker items={ticker} />
    </div>
  );
}
