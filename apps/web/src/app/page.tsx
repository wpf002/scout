"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  CATEGORIES,
  LAYERS,
  LAYER_BY_ID,
  parseLayers,
} from "@/lib/layers";
import type { BasemapId } from "@/lib/basemap";
import type { Selection } from "@/components/GlobeMap";
import { OsintPanel } from "@/components/OsintPanel";
import { LocalClock, Ticker, type TickerItem } from "@/components/Hud";
import { Search } from "@/components/Search";
import { Detail } from "@/components/Detail";
import { Directions, type Route, type Stop } from "@/components/Directions";
import { Minimap } from "@/components/Minimap";
import { useAlerts, ago, qualify } from "@/lib/alerts";
import type { Shape } from "@/lib/measure";
import { Filters } from "@/components/Filters";
import { Aoi, type Box } from "@/components/Aoi";
import { SpacePanel } from "@/components/SpacePanel";
import { MarketsPanel } from "@/components/MarketsPanel";
import { MarauderPanel } from "@/components/MarauderPanel";
import { PanelBoundary } from "@/components/PanelBoundary";
import { ArcGisPanel } from "@/components/ArcGisPanel";
import { EMPTY_LAYER, type ImageryOverlay, type MapLayer, type Viewport } from "@/lib/investigation";
import { filtersToSearch, parseFilters, type Predicate } from "@/lib/filters";
import { IMAGERY_BY_ID } from "@/lib/imagery";

/**
 * MapLibre touches `window` at import time, so it cannot be server-rendered.
 * Loading it dynamically also keeps the map bundle out of the first paint.
 */
const GlobeMap = dynamic(
  () => import("@/components/GlobeMap").then((m) => m.GlobeMap),
  { ssr: false },
);

// Ordered top to bottom, grouped by what the tool is for. A divider is drawn
// wherever the group changes, so the rail reads as investigate / map / feeds /
// extras rather than one undifferentiated column.
const TOOLS = [
  { id: "osint", glyph: "◎", name: "Investigate", group: "investigate" },
  { id: "layers", glyph: "≡", name: "All Layers", group: "map" },
  { id: "filters", glyph: "⚗", name: "Filters", group: "map" },
  { id: "aoi", glyph: "▢", name: "Area of Interest", group: "map" },
  { id: "measure", glyph: "⊹", name: "Measure", group: "map" },
  { id: "directions", glyph: "⇄", name: "Directions", group: "map" },
  { id: "alerts", glyph: "⚠", name: "Live Alerts", group: "feeds" },
  { id: "intel", glyph: "◫", name: "Intel Feed", group: "feeds" },
  { id: "markets", glyph: "▦", name: "Markets", group: "feeds" },
  { id: "space", glyph: "◉", name: "Live from Space", group: "feeds" },
  { id: "arcgis", glyph: "⬡", name: "ArcGIS Layers", group: "extra" },
  { id: "marauder", glyph: "✷", name: "Marauder", group: "extra" },
  { id: "self", glyph: "⌖", name: "Self Track", group: "extra" },
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
  // Bumped to make the Investigate panel run the seeded term immediately, so
  // the top search bar can investigate without a second click in the panel.
  const [runToken, setRunToken] = useState(0);
  const [selfNote, setSelfNote] = useState<string | null>(null);
  const [mapBusy, setMapBusy] = useState(true);
  const [overview, setOverview] = useState<string[] | null>(null);
  const [overviewing, setOverviewing] = useState(false);
  const [arcgisFeatures, setArcgisFeatures] = useState<GeoJSON.Feature[]>([]);
  const [basemap, setBasemap] = useState<BasemapId>("sat");
  const [projection, setProjection] = useState<"globe" | "mercator">("globe");
  const [cursor, setCursor] = useState({ lat: 0, lon: 0, zoom: 2.2 });
  const [flyTo, setFlyTo] = useState<{
    lat: number;
    lon: number;
    zoom?: number;
    offset?: [number, number];
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
  const [filters, setFiltersState] = useState<Record<string, Predicate[]>>({});
  const [held, setHeld] = useState<Map<string, GeoJSON.Feature[]>>(new Map());
  const [aoi, setAoi] = useState<Box | null>(null);
  const [drawingAoi, setDrawingAoi] = useState(false);
  const [aoiFeatures, setAoiFeatures] = useState<GeoJSON.Feature[]>([]);
  const [investigation, setInvestigation] = useState<MapLayer>(EMPTY_LAYER);
  const [imagery, setImagery] = useState<ImageryOverlay[]>([]);
  // Bounds still flow in from the map; nothing reads them now that the console
  // is gone, so only the setter is kept.
  const [, setView] = useState<Viewport | null>(null);
  const [track, setTrack] = useState<{
    path: [number, number][];
    altitudes: Array<number | null>;
    route: {
      from: { code: string | null; place: string | null; lon: number; lat: number };
      to: { code: string | null; place: string | null; lon: number; lat: number };
    } | null;
  } | null>(null);
  const [kp, setKp] = useState<{ kp: number | null; level: string } | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, boolean>>({});

  // ── URL is the source of truth ───────────────────────────────────────────
  useEffect(() => {
    setActive(parseLayers(window.location.search));
    setFiltersState(parseFilters(window.location.search));
    const onPop = () => {
      setActive(parseLayers(window.location.search));
      setFiltersState(parseFilters(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /**
   * `active`, mirrored into a ref.
   *
   * The toggle below needs to read the current set and also write to the URL.
   * Doing both inside a `setActive` updater looked tidy and was wrong: React
   * runs updaters during the render phase, so `history.replaceState` fired
   * mid-render and Next's Router set state while Page was still rendering —
   * "Cannot update a component (Router) while rendering a different component
   * (Page)". Reading from a ref keeps the URL write in the event handler,
   * where a side effect belongs.
   */
  const activeRef = useRef<string[]>([]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const toggle = useCallback((id: string) => {
    const current = activeRef.current;
    // In an exclusive category, switching one on switches its siblings off.
    const exclusive = CATEGORIES.find(
      (category) => category.exclusive === true && category.layerIds.includes(id),
    );
    const siblings = exclusive === undefined ? [] : exclusive.layerIds.filter((layer) => layer !== id);
    const next = current.includes(id)
      ? current.filter((layer) => layer !== id)
      : [...current.filter((layer) => !siblings.includes(layer)), id];

    activeRef.current = next;
    setActive(next);
    window.history.replaceState(null, "", filtersToSearch(next, filtersRef.current));
  }, []);

  /**
   * A filtered view is a link, exactly as a set of layers is. Sending someone
   * "military traffic above 30,000 ft over the Baltic" should not mean sending
   * them a screenshot and instructions.
   */
  const filtersRef = useRef<Record<string, Predicate[]>>({});
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const setFilters = useCallback((next: Record<string, Predicate[]>) => {
    filtersRef.current = next;
    setFiltersState(next);
    window.history.replaceState(null, "", filtersToSearch(activeRef.current, next));
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

  // The top search bar's investigate action: seed the panel, open it, and run.
  // The same handler serves the explicit Investigate button and an indicator
  // typed straight into the bar, so both land in one place with results.
  const investigate = useCallback((value: string) => {
    const term = value.trim();
    if (term.length === 0) return;
    setSeeded(term);
    setTool("osint");
    setRunToken((n) => n + 1);
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

  /**
   * Fetch the selected aircraft's recorded track and filed route.
   *
   * Only for aircraft, and only on selection. Every other layer either does
   * not move or has no published history, and asking for nine thousand traces
   * in the background would be both useless and rude.
   */
  useEffect(() => {
    const properties = selection?.properties ?? {};
    const layer = String(properties["layer"] ?? "");
    const hex = String(properties["icao24"] ?? "");

    if (!layer.startsWith("aircraft:") || !/^[0-9a-f]{6}$/i.test(hex)) {
      setTrack(null);
      return;
    }

    let cancelled = false;
    const callsign = String(properties["label"] ?? "").trim();
    const query = /^[A-Z0-9]{2,8}$/.test(callsign)
      ? `?callsign=${encodeURIComponent(callsign)}`
      : "";

    void fetch(`/api/track/${hex}${query}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { path?: [number, number][]; altitudes?: Array<number | null>; route?: unknown }) => {
        if (cancelled) return;
        setTrack({
          path: d.path ?? [],
          altitudes: d.altitudes ?? [],
          route: (d.route ?? null) as never,
        });
      })
      .catch(() => {
        if (!cancelled) setTrack(null);
      });

    return () => {
      cancelled = true;
    };
  }, [selection]);

  /** A completed box ends drawing mode — two clicks, then done. */
  const onAoi = useCallback((box: Box) => {
    setAoi(box);
    setDrawingAoi(false);
  }, []);

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
        label: qualify(alert.detail, alert.label),
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

  /*
   * Still working.
   *
   * The map's own `idle` covers tiles and style, but the feed layers arrive
   * separately — a layer that has not reported a count yet is still in flight.
   * Either one means a drag may do nothing, which is the whole reason this is
   * shown at all.
   */
  const pendingLayers = active.filter(
    (id) => offered(id) && LAYER_BY_ID.get(id)?.kind === "feed" && countFor(id) === undefined,
  ).length;
  const busy = mapBusy || pendingLayers > 0;
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

    // Imagery only: how deep this product actually publishes, when the view has
    // already gone past it.
    const native = IMAGERY_BY_ID.get(layerId)?.maxzoom;
    const overzoomed =
      native !== undefined && cursor.zoom > native + 0.5 ? native : null;

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
          {on && overzoomed !== null ? (
            /*
             * Past a product's deepest published tile the map stretches the
             * last one, which looks like a rendering fault rather than the
             * instrument's resolution. GOES ABI is about 2 km a pixel and
             * NASA publishes nothing below zoom 7; saying so is the only
             * honest fix, since there is no sharper tile to fetch.
             */
            <span className="switch-limit" title={`No tiles below zoom ${overzoomed}. This is the instrument's resolution, not a loading state.`}>
              max z{overzoomed}
            </span>
          ) : !on ? "" : count === undefined ? "…" : failed ? String(count) : count.toLocaleString()}
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
        arcgisFeatures={arcgisFeatures}
        onSelect={setSelection}
        onStatus={onStatus}
        onBusy={setMapBusy}
        onCursor={onCursor}
        flyTo={flyTo}
        onCentre={onCentre}
        onBounds={setView}
        measure={measure}
        onMeasure={setReading}
        filters={filters}
        onHeld={setHeld}
        track={track}
        aoi={aoi}
        drawingAoi={drawingAoi}
        onAoi={onAoi}
        aoiFeatures={aoiFeatures}
        investigation={investigation}
        imagery={imagery}
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

        <Search onFly={setFlyTo} onIndicator={investigate} onInvestigate={investigate} />

        <div className="hud-readout">
          <LocalClock />
          <span>
            STATUS{" "}
            <b className={busy ? "busy" : "live"}>{busy ? "LOADING" : "LIVE"}</b>
          </span>
          <span>
            <b>{active.length}</b> LAYERS
          </span>
          <span>
            <b>{entities.toLocaleString()}</b> ENTITIES
          </span>
          {selfNote !== null ? <span className="self-note">{selfNote}</span> : null}
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

      {/*
        * Self Track: centre the map on this browser's own position.
        *
        * An action, not a panel — the browser asks for permission itself, and a
        * refusal has to be said out loud or the button looks broken.
        */}
      {/* ── Right tool rail ────────────────────────────────────────────── */}
      <nav className="tool-rail" aria-label="Tools">
        {TOOLS.map((item, index) => {
          const high =
            item.id === "alerts"
              ? alerts.filter((alert) => alert.severity === "high").length
              : 0;
          const startsGroup = index > 0 && TOOLS[index - 1]?.group !== item.group;
          return (
            <div key={item.id} className="tool-slot">
              {startsGroup ? <span className="tool-divider" aria-hidden /> : null}
            <button
              className={`tool-icon${tool === item.id ? " on" : ""}`}
              onClick={() => {
                if (item.id === "self") {
                  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
                    setSelfNote("This browser has no geolocation.");
                    return;
                  }
                  setSelfNote("Locating…");
                  navigator.geolocation.getCurrentPosition(
                    (pos) => {
                      setSelfNote(null);
                      setFlyTo({
                        lat: pos.coords.latitude,
                        lon: pos.coords.longitude,
                        zoom: 12,
                      });
                    },
                    (err) => {
                      setSelfNote(
                        err.code === err.PERMISSION_DENIED
                          ? "Location permission denied."
                          : "Could not get a location fix.",
                      );
                    },
                    { enableHighAccuracy: true, timeout: 10_000 },
                  );
                  return;
                }
                setTool((current) => {
                  const next = current === item.id ? null : item.id;
                  // Leaving the measure panel leaves measure mode. A crosshair
                  // that outlives its panel eats clicks meant for features.
                  if (next !== "measure") setMeasure(null);
                  // A pick mode that outlives its panel eats clicks meant for
                  // features, exactly as a stray crosshair does.
                  if (next !== "directions") setPicking(null);
                  if (next !== "aoi") setDrawingAoi(false);
                  // The console's picture belongs to the console; closing it
                  // takes the picture off the live map.
                  if (next !== "investigation") {
                    setInvestigation(EMPTY_LAYER);
                    setImagery([]);
                  }
                  return next;
                });
              }}
              title={item.name}
            >
              {item.glyph}
              {high > 0 ? <span className="cat-badge">{high}</span> : null}
            </button>
            </div>
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
        {/*
          The map could always show a place and never investigate one. This is
          the whole of the bridge: the coordinate under the cursor becomes the
          subject, and the OSINT panel answers it like any other indicator.
        */}
        <button
          type="button"
          className="cursor-investigate"
          onClick={() =>
            investigate(`${cursor.lat.toFixed(4)}, ${cursor.lon.toFixed(4)}`)
          }
          title="Investigate this place"
        >
          Investigate
        </button>
      </div>

      {/* One boundary, not sixteen: only one panel is mounted at a time, so
          this contains a crash to the panel that caused it while leaving the
          map, the layer rail and everything else standing. */}
      <PanelBoundary name={TOOLS.find((t) => t.id === tool)?.name ?? "Panel"}>
      {/* ── Tool panels ────────────────────────────────────────────────── */}
      {tool === "layers" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Layers &amp; Sources</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <ul className="layer-list">{LAYERS.map((layer) => switchRow(layer.id))}</ul>

          {/*
            * Every layer, named with who publishes it. A reading an operator
            * is going to act on should be traceable to its source without
            * having to ask, and a source list is also the honest place to say
            * what a layer does not cover.
            */}
          <div className="sources">
            <h3>Sources</h3>
            <dl>
              {LAYERS.filter((layer) => offered(layer.id)).map((layer) => (
                <div key={layer.id}>
                  <dt style={{ color: layer.colour }}>{layer.name}</dt>
                  <dd>{layer.source}</dd>
                </div>
              ))}
            </dl>
            <p className="sources-note">
              Every source here is public and keyless except Cloudflare Radar,
              which is only offered when a token is configured. Satellite
              positions are computed from orbital elements, not observed.
              Threat-feed positions are IP geolocation and are approximate.
            </p>
          </div>

          <div className="sources">
            <h3>Shortcuts</h3>
            <ul className="shortcuts">
              {[
                ["L", "Layers and sources"],
                ["A", "Live alerts"],
                ["I", "Intel feed"],
                ["M", "Measure"],
                ["D", "Directions"],
                ["O", "OSINT search"],
                ["3 / 2", "Globe or flat"],
                ["S", "Satellite or map"],
                ["F", "Full screen"],
                ["E", "Export this view"],
                ["Esc", "Close everything"],
              ].map(([key, what]) => (
                <li key={key}>
                  <kbd>{key}</kbd>
                  <span>{what}</span>
                </li>
              ))}
            </ul>
          </div>
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

      {tool === "filters" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Filters</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <Filters
            active={active}
            filters={filters}
            setFilters={setFilters}
            held={held}
          />
        </section>
      ) : null}

      {tool === "aoi" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Area of Interest</h2>
            <button
              className="link"
              onClick={() => {
                setTool(null);
                setDrawingAoi(false);
              }}
            >
              ×
            </button>
          </div>
          <Aoi
            box={aoi}
            drawing={drawingAoi}
            setDrawing={setDrawingAoi}
            clear={() => {
              setAoi(null);
              setDrawingAoi(false);
            }}
            held={held}
            active={active}
            onInfrastructure={setAoiFeatures}
            onFly={setFlyTo}
          />
        </section>
      ) : null}


      {tool === "osint" ? (
        <section className="tool-panel wide">
          <div className="tool-panel-head">
            <h2>Investigate</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <div className="tool-panel-body">
            <OsintPanel
              onLocated={onLocated}
              initialQuery={seeded}
              runToken={runToken}
            />
          </div>
        </section>
      ) : null}

      {tool === "space" ? (
        <section className="tool-panel fit">
          <div className="tool-panel-head">
            <h2>Live from Space</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <SpacePanel />
        </section>
      ) : null}

      {tool === "markets" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Markets &amp; Intel</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <MarketsPanel kp={kp} />
        </section>
      ) : null}

      {tool === "arcgis" ? (
        <section className="tool-panel wide">
          <div className="tool-panel-head">
            <h2>ArcGIS Layers</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <ArcGisPanel onImport={(features) => setArcgisFeatures(features)} />
        </section>
      ) : null}

      {tool === "marauder" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Marauder</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <MarauderPanel />
        </section>
      ) : null}

      {tool === "alerts" ? (
        <section className="tool-panel">
          <div className="tool-panel-head">
            <h2>Live Alerts</h2>
            <button className="link" onClick={() => setTool(null)}>×</button>
          </div>
          <div className="overview">
            <button
              type="button"
              className="overview-run"
              disabled={overviewing || alerts.length === 0}
              onClick={() => {
                setOverviewing(true);
                setOverview(null);
                fetch("/api/live/overview", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    items: alerts.slice(0, 80).map((alert) => ({
                      label: alert.label,
                      detail: alert.detail,
                      severity: alert.severity,
                      kind: alert.layer,
                    })),
                  }),
                })
                  .then((r) => r.json() as Promise<{ bullets?: string[]; reason?: string }>)
                  .then((d) =>
                    setOverview(
                      (d.bullets ?? []).length > 0
                        ? (d.bullets as string[])
                        : [d.reason ?? "No overview available."],
                    ),
                  )
                  .catch(() => setOverview(["Could not reach the overview service."]))
                  .finally(() => setOverviewing(false));
              }}
            >
              {overviewing ? "Reading…" : "Overview"}
            </button>
            {overview !== null ? (
              <ul className="overview-bullets">
                {overview.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
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
                    {/* The category is dropped when the label already leads
                        with it — see qualify(). */}
                    {qualify(alert.detail, alert.label) === alert.label ? null : (
                      <span className="alert-detail">{alert.detail}</span>
                    )}
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
      </PanelBoundary>

      {selection !== null ? (
        <Detail
          selection={selection}
          onClose={() => setSelection(null)}
          onFly={setFlyTo}
          track={track}
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
