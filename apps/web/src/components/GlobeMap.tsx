"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import { LAYERS, LAYER_BY_ID } from "@/lib/layers";
import { nightPolygon } from "@/lib/terminator";
import {
  BASEMAPS,
  rewriteStyle,
  terrainSource,
  type BasemapId,
} from "@/lib/basemap";
import { build, type Point as MeasurePoint, type Shape } from "@/lib/measure";

/*
 * Point MapLibre at the worker copied into `public/` — see
 * scripts/copy-map-worker.mjs for why its own resolution does not survive
 * bundling. This has to happen before the first Map is constructed, because
 * the pool is created lazily on that call and the URL is read then.
 */
maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");

export interface Selection {
  layer: string;
  label: string;
  properties: Record<string, unknown>;
  lngLat: { lng: number; lat: number };
}

export interface Props {
  active: string[];
  basemap: BasemapId;
  projection: "globe" | "mercator";
  osintFeatures: GeoJSON.Feature[];
  onSelect: (selection: Selection | null) => void;
  onStatus: (status: Record<string, number | string>) => void;
  onCursor: (position: { lat: number; lon: number; zoom: number }) => void;
  flyTo: { lat: number; lon: number; zoom?: number } | null;
  onCentre: (centre: { lat: number; lon: number }) => void;
  measure: Shape | null;
  onMeasure: (reading: string | null) => void;
  /** The planned route, drawn under everything else. */
  route: { coordinates: [number, number][] } | null;
  /** Stops placed so far, drawn as lettered pins. */
  stops: Array<{ label: string; lat: number; lon: number } | null>;
  /** Which stop the next map click should fill, if any. */
  picking: number | null;
  onPick: (index: number, lngLat: { lat: number; lon: number }) => void;
}

const FEED_LAYERS = LAYERS.filter((layer) => layer.kind === "feed");

/**
 * How many features a heavy layer draws at once.
 *
 * Some of these feeds are tens of thousands of points. MapLibre will render
 * that, but it stops being a map and becomes a texture — and every one of
 * those points had to cross the wire. Heavy layers are therefore drawn from
 * what is in view, thinned to this ceiling, and the rail reports the true
 * total rather than the drawn count so nobody mistakes the cap for the data.
 */
const HEAVY_CEILING = 6_000;

/**
 * How many camera stills to show at once.
 *
 * Each is a request to a public agency's own server. A city with six hundred
 * cameras in view must not become six hundred requests because someone
 * toggled a switch.
 */
const PREVIEW_CEILING = 12;

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
  measure,
  onMeasure,
  route,
  stops,
  picking,
  onPick,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  /**
   * Is this map still the live one?
   *
   * React runs effects twice in development, so the map is built, torn down
   * and built again. Anything asynchronous started by the first map — a style
   * fetch, a layer fetch — can land after `remove()` has destroyed its WebGL
   * painter, and MapLibre then fails deep inside itself with errors that name
   * nothing recognisable: "undefined is not an object (evaluating
   * 'a.shaderPreludeCode')" and "Attempting to run(), but is already running".
   *
   * Every async continuation checks this before touching the map.
   */
  const alive = useCallback(
    (instance: maplibregl.Map | null): instance is maplibregl.Map =>
      instance !== null && map.current === instance,
    [],
  );
  const [ready, setReady] = useState(false);
  const [redraw, setRedraw] = useState(0);
  const [viewport, setViewport] = useState(0);

  /** Every feature a layer returned, before viewport thinning. */
  const raw = useRef(new Map<string, GeoJSON.Feature[]>());

  /**
   * Bumped when a feed's features land.
   *
   * `raw` is a ref, so writing to it does not re-render — which is correct for
   * the map itself but wrong for anything derived from it. Without this, the
   * camera previews computed once against an empty map before the first fetch
   * resolved and then waited for the operator to pan before they appeared.
   */
  const [dataVersion, setDataVersion] = useState(0);

  // ── Create the map once ──────────────────────────────────────────────────
  useEffect(() => {
    if (container.current === null || map.current !== null) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: BASEMAPS[basemap]() as StyleSpecification,
      center: [-40, 25],
      zoom: 2.2,
      attributionControl: false,
      maxPitch: 75,
      /*
       * A floor on how far out the map will go.
       *
       * MapLibre's default is -2, and on a globe the projection saturates
       * somewhere around zero: the view stops changing but the zoom level
       * keeps dropping. Scrolling out past that point spends several notches
       * doing nothing visible, and scrolling back in then appears dead until
       * they are spent again — which reads exactly like a stuck map.
       *
       * One is where the globe still fills the viewport, so every notch of the
       * wheel moves the picture.
       */
      minZoom: 1,
      // A globe reads as a world view rather than a wall chart, and it is what
      // makes polar coverage legible at all.
      ...({ projection: { type: projection } } as object),
    });

    instance.addControl(
      new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }),
      "bottom-right",
    );
    instance.addControl(
      new maplibregl.ScaleControl({ unit: "metric" }),
      "bottom-left",
    );

    /*
     * MapLibre measures the container once, at construction. This component is
     * imported dynamically, so on the first pass the div is in the document but
     * not yet laid out — MapLibre falls back to 400x300 and never revisits it.
     * The symptom is a map that loads its style and its tiles correctly and
     * paints them into the top-left corner of a full-screen div.
     */
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container.current);

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
      setViewport((n) => n + 1);
    });

    instance.on("error", (event) => {
      // MapLibre reports tile and style failures here rather than throwing.
      // Swallowing them silently is how a half-loaded basemap looks like a
      // working one.
      // eslint-disable-next-line no-console
      console.warn("map:", event.error?.message ?? event);
    });

    map.current = instance;
    (window as unknown as { __scoutMap?: unknown }).__scoutMap = instance;
    return () => {
      observer.disconnect();
      // Null first: any async work already in flight sees a dead map through
      // `alive()` and stops before `remove()` pulls the painter out from
      // under it.
      map.current = null;
      try {
        instance.remove();
      } catch {
        /*
         * A teardown that throws halfway leaves its canvas attached, and the
         * next map is then constructed over the wreckage — which is what
         * "Attempting to run(), but is already running" actually is. Clearing
         * the container by hand makes the remount clean regardless.
         */
        if (container.current !== null) container.current.innerHTML = "";
      }
    };
  }, []);

  /**
   * Switching basemap replaces the style, which discards every layer added on
   * top of it — so the layer effect has to rerun and redraw them.
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

    const style = BASEMAPS[basemap]();
    const swap = (spec: StyleSpecification) => {
      if (!alive(instance)) return;
      instance.setStyle(spec);
      instance.once("styledata", () => setRedraw((n) => n + 1));
    };

    if (typeof style === "string") {
      // A hosted vector style is a document full of absolute URLs to other
      // hosts. It is fetched here so every one of them can be pointed back
      // through the proxy before MapLibre starts requesting them.
      void fetch(style)
        .then((r) => r.json() as Promise<StyleSpecification>)
        .then((spec) => swap(rewriteStyle(spec)))
        .catch(() => {
          // Falling back to the style that has one dependency beats a black
          // map with no explanation.
          applied.current = "sat";
          swap(BASEMAPS.sat() as StyleSpecification);
        });
    } else {
      swap(style);
    }
  }, [basemap, ready, alive]);

  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;
    try {
      instance.setProjection({ type: projection } as never);
    } catch {
      // Older renderers only do mercator.
    }
  }, [projection, ready]);

  /**
   * Camera previews.
   *
   * Off by default and capped, because this is one image request per camera
   * straight to the agency that publishes it — turning it on over a city with
   * six hundred cameras would be a small denial of service against a public
   * transport authority. Only cameras in view are previewed, only the nearest
   * few, and only above a zoom where they are distinguishable at all.
   */
  const [previews, setPreviews] = useState<
    Array<{ id: string; url: string; lon: number; lat: number; label: string }>
  >([]);

  useEffect(() => {
    const instance = map.current;
    if (
      instance === null ||
      !ready ||
      !active.includes("cctv_previews") ||
      !active.includes("cctv")
    ) {
      setPreviews([]);
      return;
    }

    const update = () => {
      if (!alive(instance)) return;
      if (instance.getZoom() < 9) {
        setPreviews([]);
        return;
      }
      const bounds = instance.getBounds();
      const centre = instance.getCenter();
      const cameras = (raw.current.get("cctv") ?? []).flatMap((feature) => {
        if (feature.geometry.type !== "Point") return [];
        const [lon, lat] = feature.geometry.coordinates;
        if (typeof lon !== "number" || typeof lat !== "number") return [];
        if (!bounds.contains([lon, lat])) return [];
        const p = (feature.properties ?? {}) as Record<string, unknown>;
        // The still, never the stream. An HLS playlist is not an image and
        // would render as a broken one — which is what happened while these
        // were collapsed into a single field.
        const url = p["stillUrl"];
        if (typeof url !== "string" || url.length === 0) return [];
        return [
          {
            id: String(p["id"] ?? `${lon},${lat}`),
            url,
            lon,
            lat,
            label: String(p["label"] ?? "Camera"),
            distance: Math.abs(lon - centre.lng) + Math.abs(lat - centre.lat),
          },
        ];
      });

      cameras.sort((a, b) => a.distance - b.distance);
      setPreviews(cameras.slice(0, PREVIEW_CEILING));
    };

    update();
    instance.on("moveend", update);
    return () => {
      instance.off("moveend", update);
    };
  }, [active, ready, redraw, dataVersion, alive]);

  // ── Terrain ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;
    const on = active.includes("terrain_3d");

    try {
      if (on) {
        if (instance.getSource("terrain") === undefined) {
          instance.addSource("terrain", terrainSource());
        }
        instance.setTerrain({ source: "terrain", exaggeration: 1.4 });
      } else {
        instance.setTerrain(null);
      }
    } catch {
      // Terrain is a garnish. A renderer that cannot do it still draws a map.
    }

    /*
     * Extruded buildings, where the basemap has them.
     *
     * Only the vector style carries a `building` layer — the satellite style
     * is imagery and has no such data — so this appears with MAP and not with
     * SAT. That is a property of the basemap, not a bug, and it is why the
     * layer is not offered as if it always works.
     */
    try {
      const hasBuildings =
        instance.getSource("carto") !== undefined &&
        instance.getLayer("buildings-3d") === undefined;

      if (on && hasBuildings) {
        instance.addLayer({
          id: "buildings-3d",
          type: "fill-extrusion",
          source: "carto",
          "source-layer": "building",
          minzoom: 14,
          paint: {
            "fill-extrusion-color": "#2a2a3a",
            "fill-extrusion-height": [
              "coalesce",
              ["get", "render_height"],
              ["get", "height"],
              12,
            ],
            "fill-extrusion-base": [
              "coalesce",
              ["get", "render_min_height"],
              ["get", "min_height"],
              0,
            ],
            "fill-extrusion-opacity": 0.85,
          },
        });
      } else if (!on && instance.getLayer("buildings-3d") !== undefined) {
        instance.removeLayer("buildings-3d");
      }
    } catch {
      // A style without a building layer. The terrain still works.
    }
  }, [active, ready, redraw]);

  // ── Fly to ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || flyTo === null) return;
    instance.flyTo({
      center: [flyTo.lon, flyTo.lat],
      zoom: flyTo.zoom ?? instance.getZoom(),
      speed: 1.4,
    });
  }, [flyTo]);

  // ── Measurement ──────────────────────────────────────────────────────────
  /*
   * The click handler is registered per tool rather than always-on and
   * filtered, so with no tool selected the map has exactly the handlers it had
   * before this existed — a measurement mode that quietly eats clicks meant
   * for a feature is worse than not having one.
   *
   * Points live in a ref as well as in state: the handler is registered once
   * per tool and would otherwise close over the empty array it was created
   * with, so every click would look like the first.
   */
  const [points, setPoints] = useState<MeasurePoint[]>([]);
  const pointsRef = useRef<MeasurePoint[]>([]);

  useEffect(() => {
    pointsRef.current = [];
    setPoints([]);
    onMeasure(null);

    const instance = map.current;
    if (instance === null || !ready || measure === null) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const next = [
        ...pointsRef.current,
        { lon: event.lngLat.lng, lat: event.lngLat.lat },
      ];
      // A circle and a box are defined by two points; a third starts over
      // rather than silently ignoring the click.
      const capped = measure !== "path" && next.length > 2 ? next.slice(-1) : next;
      pointsRef.current = capped;
      setPoints(capped);
    };

    instance.getCanvas().style.cursor = "crosshair";
    instance.on("click", onClick);
    return () => {
      instance.off("click", onClick);
      instance.getCanvas().style.cursor = "";
    };
  }, [measure, ready, onMeasure]);

  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const { features, reading } = build(measure ?? "path", points);
    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: measure === null ? [] : features,
    };

    const source = instance.getSource("measure") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source === undefined) {
      instance.addSource("measure", { type: "geojson", data });
      instance.addLayer({
        id: "measure-fill",
        type: "fill",
        source: "measure",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: { "fill-color": "#e0173a", "fill-opacity": 0.12 },
      });
      instance.addLayer({
        id: "measure-line",
        type: "line",
        source: "measure",
        filter: ["!=", ["geometry-type"], "Point"],
        paint: {
          "line-color": "#e0173a",
          "line-width": 1.6,
          "line-dasharray": [2, 1.5],
        },
      });
      instance.addLayer({
        id: "measure-point",
        type: "circle",
        source: "measure",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#ffffff",
          "circle-stroke-color": "#e0173a",
          "circle-stroke-width": 2,
        },
      });
    } else {
      source.setData(data);
    }

    onMeasure(measure === null ? null : reading);
  }, [points, measure, ready, redraw, onMeasure]);

  // ── Routing ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const placed = stops.flatMap((stop, index) =>
      stop === null
        ? []
        : [
            {
              type: "Feature" as const,
              properties: {
                label:
                  index === 0
                    ? "A"
                    : index === stops.length - 1
                      ? "B"
                      : String(index),
              },
              geometry: {
                type: "Point" as const,
                coordinates: [stop.lon, stop.lat],
              },
            },
          ],
    );

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: [
        ...(route === null || route.coordinates.length === 0
          ? []
          : [
              {
                type: "Feature" as const,
                properties: { role: "route" },
                geometry: {
                  type: "LineString" as const,
                  coordinates: route.coordinates,
                },
              },
            ]),
        ...placed,
      ],
    };

    const source = instance.getSource("route") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source === undefined) {
      instance.addSource("route", { type: "geojson", data });
      // A casing under the line so the route stays readable over both the
      // satellite imagery and the dark vector style.
      instance.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#05050a", "line-width": 6, "line-opacity": 0.8 },
      });
      instance.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": "#35c46a", "line-width": 3 },
      });
      instance.addLayer({
        id: "route-stops",
        type: "circle",
        source: "route",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#35c46a",
          "circle-stroke-color": "#05050a",
          "circle-stroke-width": 2,
        },
      });
    } else {
      source.setData(data);
    }
  }, [route, stops, ready, redraw]);

  // Picking a stop off the map. Registered only while a stop is being picked,
  // so it cannot take a click meant for a feature.
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready || picking === null) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      onPick(picking, { lat: event.lngLat.lat, lon: event.lngLat.lng });
    };
    instance.getCanvas().style.cursor = "crosshair";
    instance.on("click", onClick);
    return () => {
      instance.off("click", onClick);
      instance.getCanvas().style.cursor = "";
    };
  }, [picking, ready, onPick]);

  // ── Layer painting ───────────────────────────────────────────────────────

  const paintFor = useCallback(
    (layerId: string): maplibregl.AddLayerObject => {
      const def = LAYER_BY_ID.get(layerId);
      const colour = def?.colour ?? "#ffffff";
      const base = { id: layerId, source: layerId } as const;

      if (def?.draw === "line" || def?.draw === "arc") {
        return {
          ...base,
          type: "line",
          filter: ["!=", ["geometry-type"], "Point"],
          paint: {
            "line-color": ["coalesce", ["get", "colour"], colour],
            "line-width": def.draw === "arc" ? 1.4 : 1.1,
            "line-opacity": def.draw === "arc" ? 0.55 : 0.6,
          },
        };
      }

      // Aurora is a probability field sampled on a grid, so it reads as a haze
      // rather than a set of events: soft, large, and unstroked.
      if (def?.draw === "glow") {
        return {
          ...base,
          type: "circle",
          paint: {
            "circle-radius": 7,
            "circle-color": colour,
            "circle-opacity": 0.16,
            "circle-blur": 1,
          },
        };
      }

      return {
        ...base,
        type: "circle",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          // Earthquakes size by magnitude; ports by rank; everything else is a
          // fixed dot that grows a little with zoom so it stays clickable.
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
              : ([
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  2,
                  2.4,
                  8,
                  5,
                ] as unknown as number),
          "circle-color": ["coalesce", ["get", "colour"], colour] as unknown as string,
          "circle-opacity": 0.85,
          "circle-stroke-color": "#05050a",
          "circle-stroke-width": 0.6,
        },
      };
    },
    [],
  );

  /** The extra line layer an arc layer needs for its endpoint dots. */
  const endpointLayerId = (layerId: string) => `${layerId}-endpoints`;

  const ensure = useCallback(
    (
      instance: maplibregl.Map,
      layerId: string,
      data: GeoJSON.FeatureCollection,
    ) => {
      const source = instance.getSource(layerId) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (source === undefined) {
        instance.addSource(layerId, { type: "geojson", data });
      } else {
        source.setData(data);
      }

      if (instance.getLayer(layerId) === undefined) {
        instance.addLayer(paintFor(layerId));

        // An arc layer draws lines; its endpoints need their own circle layer
        // or the C2 servers themselves would be invisible.
        if (LAYER_BY_ID.get(layerId)?.draw === "arc") {
          instance.addLayer({
            id: endpointLayerId(layerId),
            source: layerId,
            type: "circle",
            filter: ["==", ["geometry-type"], "Point"],
            paint: {
              "circle-radius": 4,
              "circle-color": ["coalesce", ["get", "colour"], "#e0173a"],
              "circle-opacity": 0.9,
              "circle-stroke-color": "#05050a",
              "circle-stroke-width": 0.8,
            },
          });
        }
      }
    },
    [paintFor],
  );

  /** Thin a heavy layer to what is in view, up to the ceiling. */
  const inView = useCallback(
    (instance: maplibregl.Map, features: GeoJSON.Feature[]) => {
      const bounds = instance.getBounds();
      const visible = features.filter((feature) => {
        if (feature.geometry.type !== "Point") return true;
        const [lon, lat] = feature.geometry.coordinates;
        return (
          typeof lon === "number" &&
          typeof lat === "number" &&
          bounds.contains([lon, lat])
        );
      });

      if (visible.length <= HEAVY_CEILING) return visible;
      // Evenly sampled rather than truncated: a truncated set is whatever the
      // feed happened to list first, which is usually one region.
      const step = Math.ceil(visible.length / HEAVY_CEILING);
      return visible.filter((_, index) => index % step === 0);
    },
    [],
  );

  // Fetch and draw.
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    let cancelled = false;

    const drawFeed = async (layerId: string) => {
      const def = LAYER_BY_ID.get(layerId);
      if (def === undefined) return;

      try {
        const response = await fetch(`/api/live/${layerId}`, { cache: "no-store" });
        const data = (await response.json()) as GeoJSON.FeatureCollection & {
          error?: string;
          meta?: Record<string, unknown>;
        };
        if (cancelled || !alive(instance)) return;

        raw.current.set(layerId, data.features);
        setDataVersion((n) => n + 1);
        const drawn =
          def.heavy === true ? inView(instance, data.features) : data.features;
        ensure(instance, layerId, { type: "FeatureCollection", features: drawn });

        // The rail reports the true total, never the drawn count — a ceiling
        // that reads as the data is worse than no number.
        onStatus({ [layerId]: data.error ?? data.features.length });
      } catch {
        // A layer that cannot load must not take the map down. It reports as
        // unavailable and every other layer keeps drawing.
        if (!cancelled && alive(instance)) onStatus({ [layerId]: "unavailable" });
      }
    };

    // Remove anything switched off, so toggling actually clears the map.
    for (const def of LAYERS) {
      if (active.includes(def.id)) continue;
      for (const id of [def.id, endpointLayerId(def.id)]) {
        if (instance.getLayer(id) !== undefined) instance.removeLayer(id);
      }
      if (instance.getSource(def.id) !== undefined) instance.removeSource(def.id);
      raw.current.delete(def.id);
    }

    // Day/night first, so the feeds that follow are drawn on top of it. Night
    // shading over the marks would dim exactly what is being read.
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
      const source = instance.getSource("day_night") as
        | maplibregl.GeoJSONSource
        | undefined;
      if (source === undefined) {
        instance.addSource("day_night", { type: "geojson", data });
        instance.addLayer({
          id: "day_night",
          type: "fill",
          source: "day_night",
          paint: { "fill-color": "#000010", "fill-opacity": 0.42 },
        });
      } else {
        source.setData(data);
      }
    }

    for (const def of FEED_LAYERS) {
      if (active.includes(def.id)) void drawFeed(def.id);
    }

    return () => {
      cancelled = true;
    };
  }, [active, ready, onStatus, redraw, ensure, inView, alive]);

  /**
   * Re-thin heavy layers when the view moves.
   *
   * This deliberately does not refetch — the whole feed is already held, so
   * panning costs a filter rather than a request.
   */
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    for (const def of FEED_LAYERS) {
      if (def.heavy !== true || !active.includes(def.id)) continue;
      const features = raw.current.get(def.id);
      if (features === undefined) continue;
      const source = instance.getSource(def.id) as
        | maplibregl.GeoJSONSource
        | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: inView(instance, features),
      });
    }
  }, [viewport, active, ready, inView, dataVersion]);

  // Refresh live feeds on a timer, so the map stays live without a reload.
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => setRedraw((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, [ready]);

  // ── OSINT results as a layer ─────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: osintFeatures,
    };

    const source = instance.getSource("osint") as
      | maplibregl.GeoJSONSource
      | undefined;
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

  // ── Selection ────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready || measure !== null || picking !== null) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const clickable = [...FEED_LAYERS.map((l) => l.id), "osint"].filter(
        (id) => instance.getLayer(id) !== undefined,
      );
      const hits = instance.queryRenderedFeatures(event.point, {
        layers: clickable,
      });
      const hit = hits[0];
      if (hit === undefined) {
        onSelect(null);
        return;
      }

      const properties = (hit.properties ?? {}) as Record<string, unknown>;
      onSelect({
        layer: String(properties["layer"] ?? hit.layer.id),
        label: String(properties["label"] ?? "Feature"),
        properties,
        lngLat: { lng: event.lngLat.lng, lat: event.lngLat.lat },
      });
    };

    const onEnter = () => {
      instance.getCanvas().style.cursor = "pointer";
    };
    const onLeave = () => {
      instance.getCanvas().style.cursor = "";
    };

    instance.on("click", onClick);
    for (const def of FEED_LAYERS) {
      if (instance.getLayer(def.id) === undefined) continue;
      instance.on("mouseenter", def.id, onEnter);
      instance.on("mouseleave", def.id, onLeave);
    }

    return () => {
      instance.off("click", onClick);
      for (const def of FEED_LAYERS) {
        instance.off("mouseenter", def.id, onEnter);
        instance.off("mouseleave", def.id, onLeave);
      }
    };
  }, [ready, onSelect, measure, picking, active, redraw]);

  return (
    <>
      <div ref={container} className="globe" />
      {previews.length > 0 ? (
        <div className="previews">
          {previews.map((preview) => {
            const instance = map.current;
            if (instance === null) return null;
            const at = instance.project([preview.lon, preview.lat]);
            return (
              <figure
                key={preview.id}
                className="preview"
                style={{ left: at.x, top: at.y }}
              >
                {/*
                  * Eager, not lazy. The count is already capped at a dozen,
                  * which is what lazy loading would otherwise be protecting
                  * against — and a deferred image in a panel the operator
                  * deliberately opened just reads as a broken preview.
                  * eslint-disable-next-line @next/next/no-img-element
                  */}
                <img
                  src={preview.url}
                  alt={preview.label}
                  onError={(event) => {
                    // A camera that is offline serves nothing. Hide the frame
                    // rather than leave a broken-image icon on the map.
                    event.currentTarget.closest("figure")?.remove();
                  }}
                />
                <figcaption>{preview.label}</figcaption>
              </figure>
            );
          })}
        </div>
      ) : null}
    </>
  );
}
