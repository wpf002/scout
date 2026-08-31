"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import { LAYERS, LAYER_BY_ID } from "@/lib/layers";
import { nightPolygon } from "@/lib/terminator";
import { BASEMAPS, type BasemapId } from "@/lib/basemap";

/**
 * The map.
 *
 * Every basemap request goes through Scout's own proxy. That keeps the tile
 * provider from learning which part of the world an investigator is looking
 * at, which for this tool is the whole point of not linking straight to it.
 */

export interface Selection {
  layer: string;
  label: string;
  properties: Record<string, unknown>;
}

interface Props {
  active: string[];
  basemap: BasemapId;
  projection: "globe" | "mercator";
  onCursor: (position: { lat: number; lon: number; zoom: number }) => void;
  /** Set by the search box. Changing it moves the camera. */
  flyTo: { lat: number; lon: number; zoom?: number } | null;
  /** Fired when the camera settles, for the reverse-geocoded readout. */
  onCentre: (centre: { lat: number; lon: number }) => void;
  /** Extra points contributed by the OSINT panel. */
  osintFeatures: GeoJSON.Feature[];
  onSelect: (selection: Selection | null) => void;
  onStatus: (status: Record<string, number | string>) => void;
}

const FEED_LAYERS = LAYERS.filter((layer) => layer.kind === "feed");

/*
 * Point MapLibre at the worker copied into `public/` — see
 * scripts/copy-map-worker.mjs for why its own resolution does not survive
 * bundling. This has to happen before the first Map is constructed, because
 * the pool is created lazily on that call and the URL is read then.
 */
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export function GlobeMap({
  active,
  basemap,
  projection,
  osintFeatures,
  onSelect,
  onStatus,
  onCursor,
  flyTo,
  onCentre,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [redraw, setRedraw] = useState(0);

  // ── Create the map once ──────────────────────────────────────────────────
  useEffect(() => {
    if (container.current === null || map.current !== null) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: BASEMAPS[basemap](),
      center: [-96, 38],
      zoom: 3.2,
      attributionControl: false,
      // A globe reads as a world view rather than a wall chart, and it is what
      // makes polar coverage legible at all.
      ...({ projection: { type: projection } } as object),
    });

    instance.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "bottom-right",
    );
    instance.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );

    instance.on("load", () => {
      // Ready first. Setting the projection is a nice-to-have, and when it
      // threw it took the rest of this handler with it — so `ready` stayed
      // false, no layer effect ever ran, and the map sat black with every
      // feed reporting nothing. A cosmetic call must not gate the app.
      setReady(true);
      try {
        instance.setProjection({ type: projection } as never);
      } catch {
        // Flat map. Still a map.
      }
    });

    instance.on("mousemove", (event) => {
      onCursor({
        lat: event.lngLat.lat,
        lon: event.lngLat.lng,
        zoom: instance.getZoom(),
      });
    });

    // `moveend`, not `move`: the readout behind this is a geocoder call, and
    // one per frame of a drag would be both useless and abusive.
    instance.on("moveend", () => {
      const centre = instance.getCenter();
      onCentre({ lat: centre.lat, lon: centre.lng });
    });

    instance.on("error", (event) => {
      // MapLibre reports tile and style failures here rather than throwing.
      // Swallowing them silently is how a half-loaded basemap looks like a
      // working one.
      // eslint-disable-next-line no-console
      console.warn("map:", event.error?.message ?? event);
    });

    /*
     * MapLibre measures the container once, at construction. This component is
     * imported dynamically, so on the first pass the div is in the document but
     * not yet laid out — MapLibre falls back to 400x300 and never revisits it.
     * The symptom is a map that loads its style and its tiles correctly and
     * paints them into the top-left corner of a full-screen div.
     *
     * Observing the container fixes it for every later cause too: opening a
     * side panel, rotating a tablet, dragging a window between displays.
     */
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);

    map.current = instance;
    // Dev aid: lets the map be inspected from the console when a layer does
    // not appear and the question is whether the style ever finished loading.
    (window as unknown as { __scoutMap?: unknown }).__scoutMap = instance;
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
    };
  }, []);

  /**
   * Switching basemap replaces the style, which discards every layer added on
   * top of it — so the layer effect has to rerun and redraw them, or changing
   * SAT to MAP silently empties the map.
   *
   * `applied` is why this does not fire on mount. The map is already built
   * with the right style, and replacing it with an identical one raced the
   * layer effect: sources were added to a style that was being torn down, and
   * the feeds reported their counts while drawing nothing.
   */
  const applied = useRef<BasemapId>(basemap);
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready || applied.current === basemap) return;
    applied.current = basemap;
    instance.setStyle(BASEMAPS[basemap]());
    instance.once("styledata", () => setRedraw((n) => n + 1));
  }, [basemap, ready]);

  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;
    try {
      instance.setProjection({ type: projection } as never);
    } catch {
      // Older renderers only do mercator.
    }
  }, [projection, ready]);

  useEffect(() => {
    const instance = map.current;
    if (instance === null || flyTo === null) return;
    instance.flyTo({
      center: [flyTo.lon, flyTo.lat],
      zoom: flyTo.zoom ?? instance.getZoom(),
      speed: 1.4,
    });
  }, [flyTo]);

  // ── Draw and update layers ───────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    let cancelled = false;

    const ensureSource = (id: string, data: GeoJSON.FeatureCollection) => {
      const existing = instance.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (existing === undefined) {
        instance.addSource(id, { type: "geojson", data });
      } else {
        existing.setData(data);
      }
    };

    const paintFor = (layerId: string) => {
      const def = LAYER_BY_ID.get(layerId);
      const colour = def?.colour ?? "#ffffff";

      if (def?.draw === "line") {
        return {
          type: "line" as const,
          paint: { "line-color": colour, "line-width": 1.1, "line-opacity": 0.6 },
        };
      }

      // Aurora is a probability field sampled on a grid, so it reads as a
      // haze rather than a set of events: soft, large, and unstroked.
      if (layerId === "aurora") {
        return {
          type: "circle" as const,
          paint: {
            "circle-radius": 7,
            "circle-color": colour,
            "circle-opacity": 0.16,
            "circle-blur": 1,
          },
        };
      }

      return {
        type: "circle" as const,
        paint: {
          // Earthquakes size by magnitude; everything else is a fixed dot.
          "circle-radius":
            layerId === "earthquakes"
              ? ([
                  "interpolate",
                  ["linear"],
                  ["coalesce", ["get", "magnitude"], 1],
                  0,
                  2,
                  8,
                  14,
                ] as unknown as number)
              : 3.6,
          "circle-color": colour,
          "circle-opacity": 0.85,
          "circle-stroke-color": "#05050a",
          "circle-stroke-width": 0.6,
        },
      };
    };

    const drawFeed = async (layerId: string) => {
      const def = LAYER_BY_ID.get(layerId);
      if (def === undefined) return;

      let url = `/api/live/${layerId}`;
      if (def.needsBbox === true) {
        const b = instance.getBounds();
        url += `?bbox=${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`;
      }

      try {
        const response = await fetch(url, { cache: "no-store" });
        const data = (await response.json()) as GeoJSON.FeatureCollection & {
          error?: string;
        };
        if (cancelled) return;

        ensureSource(layerId, data);
        if (instance.getLayer(layerId) === undefined) {
          const paint = paintFor(layerId);
          instance.addLayer({
            id: layerId,
            source: layerId,
            ...paint,
          } as never);
        }
        onStatus({ [layerId]: data.error ?? data.features.length });
      } catch {
        // A layer that cannot load must not take the map down. It reports zero
        // and every other layer keeps drawing.
        if (!cancelled) onStatus({ [layerId]: "unavailable" });
      }
    };

    // Remove anything switched off, so toggling actually clears the map.
    for (const def of LAYERS) {
      const isOn = active.includes(def.id);
      if (!isOn && instance.getLayer(def.id) !== undefined) {
        instance.removeLayer(def.id);
        if (instance.getSource(def.id) !== undefined) {
          instance.removeSource(def.id);
        }
      }
    }

    // Day/night first, so the feeds that follow are drawn on top of it. Night
    // shading over the marks would dim exactly what the operator is reading.
    // Day/night is local maths rather than a fetch.
    if (active.includes("day_night")) {
      const data: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { layer: "day_night", label: "Night" },
            geometry: { type: "Polygon", coordinates: [nightPolygon()] },
          },
        ],
      };
      ensureSource("day_night", data);
      if (instance.getLayer("day_night") === undefined) {
        instance.addLayer({
          id: "day_night",
          type: "fill",
          source: "day_night",
          paint: { "fill-color": "#000010", "fill-opacity": 0.42 },
        });
      }
    }

    for (const def of FEED_LAYERS) {
      if (active.includes(def.id)) void drawFeed(def.id);
    }

    return () => {
      cancelled = true;
    };
  }, [active, ready, onStatus, redraw]);

  // ── OSINT results as a layer ─────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: osintFeatures,
    };

    const source = instance.getSource("osint") as maplibregl.GeoJSONSource | undefined;
    if (source === undefined) {
      instance.addSource("osint", { type: "geojson", data });
      instance.addLayer({
        id: "osint",
        type: "circle",
        source: "osint",
        paint: {
          "circle-radius": 6,
          "circle-color": "#35c46a",
          "circle-opacity": 0.9,
          "circle-stroke-color": "#05050a",
          "circle-stroke-width": 1.2,
        },
      });
    } else {
      source.setData(data);
    }
  }, [osintFeatures, ready, redraw]);

  // ── Refresh on a timer and on pan ────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    // Bounded feeds need re-fetching when the viewport moves; unbounded ones
    // do not, so panning does not re-request the whole world.
    const onMoveEnd = () => {
      for (const def of FEED_LAYERS) {
        if (def.needsBbox === true && active.includes(def.id)) {
          void (async () => {
            const b = instance.getBounds();
            const response = await fetch(
              `/api/live/${def.id}?bbox=${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`,
              { cache: "no-store" },
            );
            const data = (await response.json()) as GeoJSON.FeatureCollection;
            const source = instance.getSource(def.id) as
              | maplibregl.GeoJSONSource
              | undefined;
            source?.setData(data);
            onStatus({ [def.id]: data.features.length });
          })().catch(() => undefined);
        }
      }
    };

    instance.on("moveend", onMoveEnd);
    return () => {
      instance.off("moveend", onMoveEnd);
    };
  }, [active, ready, onStatus]);

  // ── Clicking a feature ───────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const drawn = [...LAYERS.map((l) => l.id), "osint"].filter(
        (id) => instance.getLayer(id) !== undefined,
      );
      const hits = instance.queryRenderedFeatures(event.point, { layers: drawn });
      const hit = hits[0];

      if (hit === undefined) {
        onSelect(null);
        return;
      }

      const properties = hit.properties ?? {};
      onSelect({
        layer: String(properties["layer"] ?? hit.layer.id),
        label: String(properties["label"] ?? "Feature"),
        properties: properties as Record<string, unknown>,
      });
    };

    instance.on("click", onClick);
    return () => {
      instance.off("click", onClick);
    };
  }, [ready, onSelect]);

  return <div ref={container} className="globe" />;
}
