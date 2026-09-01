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
import { ensureSymbols } from "@/lib/symbols";
import { IMAGERY_BY_ID, imageryTiles } from "@/lib/imagery";
import { compileAll, type Predicate } from "@/lib/filters";

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
  /** Per-layer attribute predicates, applied in the style. */
  filters: Record<string, Predicate[]>;
  /** The planned route, drawn under everything else. */
  route: { coordinates: [number, number][] } | null;
  /** Stops placed so far, drawn as lettered pins. */
  stops: Array<{ label: string; lat: number; lon: number } | null>;
  /** Which stop the next map click should fill, if any. */
  picking: number | null;
  onPick: (index: number, lngLat: { lat: number; lon: number }) => void;
  /** Everything each layer returned, so a filter can report a real denominator. */
  onHeld?: (held: Map<string, GeoJSON.Feature[]>) => void;
  /** The drawn area of interest, and whether the next clicks define one. */
  aoi: { south: number; west: number; north: number; east: number } | null;
  drawingAoi: boolean;
  onAoi: (box: { south: number; west: number; north: number; east: number }) => void;
  /** Fixed infrastructure found inside the area. */
  aoiFeatures: GeoJSON.Feature[];
  /** The selected aircraft's recorded track and filed route. */
  track: {
    path: [number, number][];
    altitudes: Array<number | null>;
    route: {
      from: { code: string | null; place: string | null; lon: number; lat: number };
      to: { code: string | null; place: string | null; lon: number; lat: number };
    } | null;
  } | null;
}

const FEED_LAYERS = LAYERS.filter((layer) => layer.kind === "feed");

/**
 * Below this zoom a heavy layer aggregates into counted bubbles; above it,
 * individual marks. Around seven is where a continent stops being a wall of
 * overlapping dots and individual events become worth reading.
 */
const CLUSTER_MAX_ZOOM = 7;

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
  filters,
  route,
  stops,
  picking,
  onPick,
  onHeld,
  track,
  aoi,
  drawingAoi,
  onAoi,
  aoiFeatures,
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

    /**
     * Ready means "the style is parsed", not "the first frame is painted".
     *
     * MapLibre's `load` waits for both, and the second half never happens in a
     * background tab: browsers throttle `requestAnimationFrame` to nothing
     * there, `_render` does not complete, and `load` simply never fires. An
     * app that gates on it shows a basemap and no data until the tab is
     * focused — and reports every feed as empty in the meantime.
     *
     * Adding sources and layers only needs the style. So readiness is taken
     * from `styledata`, which fires on parse, and `load` is kept as a
     * belt-and-braces second trigger.
     *
     * Everything after `setReady` is wrapped. Anything that throws in here
     * takes the rest of the handler with it, which has now cost this file two
     * separate outages — one to `setProjection`, one to the symbol atlas.
     */
    const becomeReady = () => {
      if (!instance.isStyleLoaded()) return;
      setReady(true);

      try {
        ensureSymbols(instance);
      } catch {
        // Circles instead of silhouettes. Still a map.
      }
      try {
        instance.setProjection({ type: projection } as never);
      } catch {
        // Flat map. Still a map.
      }
    };

    instance.on("styledata", becomeReady);
    instance.on("load", becomeReady);

    /*
     * And a poll, because both events can be missed.
     *
     * `styledata` fires while the Map constructor is still running — before
     * the line above has had a chance to subscribe — and `load` never fires at
     * all in a background tab. Between them it is entirely possible for the
     * style to be parsed and ready with nothing left to announce it, which
     * leaves the map showing a basemap and no data forever.
     *
     * Asking is cheap and stops the moment the answer is yes.
     */
    const poll = setInterval(() => {
      if (instance.isStyleLoaded()) {
        becomeReady();
        clearInterval(poll);
      }
    }, 250);
    becomeReady();

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
      clearInterval(poll);
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
      instance.once("styledata", () => {
        // setStyle discards the image atlas along with everything else, so
        // every symbol layer would otherwise point at an image that no longer
        // exists.
        try {
          ensureSymbols(instance);
        } catch {
          // Redraw regardless — the layers matter more than their icons.
        }
        setRedraw((n) => n + 1);
      });
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

  /**
   * Satellite imagery overlays.
   *
   * These are rasters, not marks, so they belong under everything the map
   * draws on top — inserted before the first data layer rather than appended,
   * or a storm would hide the aircraft flying round it.
   */
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const beneath = instance
      .getStyle()
      ?.layers.find(
        (layer) =>
          !["space", "base", "labels"].includes(layer.id) &&
          !layer.id.startsWith("imagery:"),
      )?.id;

    for (const def of LAYERS) {
      if (def.kind !== "imagery") continue;
      const id = `imagery:${def.id}`;
      const on = active.includes(def.id);
      const image = IMAGERY_BY_ID.get(def.id);

      try {
        if (on && image !== undefined) {
          if (instance.getSource(id) === undefined) {
            instance.addSource(id, {
              type: "raster",
              tiles: [imageryTiles(image)],
              tileSize: 256,
              maxzoom: image.maxzoom,
              attribution: "NASA GIBS / Worldview",
            });
          }
          if (instance.getLayer(id) === undefined) {
            instance.addLayer(
              {
                id,
                type: "raster",
                source: id,
                paint: { "raster-opacity": image.opacity },
              },
              beneath,
            );
          }
        } else {
          if (instance.getLayer(id) !== undefined) instance.removeLayer(id);
          if (instance.getSource(id) !== undefined) instance.removeSource(id);
        }
      } catch {
        // A style mid-swap. The next redraw picks it up.
      }
    }
  }, [active, ready, redraw]);

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

  /**
   * The selected aircraft's history and intent.
   *
   * The trail is coloured by the altitude recorded at each point, which is
   * what makes it read as a climb, a descent or a hold rather than as a
   * squiggle. `line-gradient` needs `lineMetrics` on the source, and it only
   * works on a single LineString — so the trail is one feature and the route
   * is another.
   */
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const features: GeoJSON.Feature[] = [];

    if (track !== null && track.path.length > 1) {
      features.push({
        type: "Feature",
        properties: { role: "trail" },
        geometry: { type: "LineString", coordinates: track.path },
      });
    }

    /*
     * The filed route as a great circle through the aircraft's current
     * position: where it came from, where it is, where it says it is going.
     * Drawn dashed, because unlike the trail it is a plan rather than a
     * record.
     */
    if (track?.route != null && track.path.length > 0) {
      const now = track.path[track.path.length - 1];
      if (now !== undefined) {
        features.push({
          type: "Feature",
          properties: { role: "route" },
          geometry: {
            type: "LineString",
            coordinates: [
              [track.route.from.lon, track.route.from.lat],
              now,
              [track.route.to.lon, track.route.to.lat],
            ],
          },
        });
        for (const [end, point] of [
          ["from", track.route.from],
          ["to", track.route.to],
        ] as const) {
          features.push({
            type: "Feature",
            properties: {
              role: "airport",
              label: `${point.code ?? ""} ${point.place ?? ""}`.trim(),
              end,
            },
            geometry: { type: "Point", coordinates: [point.lon, point.lat] },
          });
        }
      }
    }

    const data: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features,
    };

    const source = instance.getSource("track") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (source === undefined) {
      instance.addSource("track", { type: "geojson", data, lineMetrics: true });
      instance.addLayer({
        id: "track-route",
        type: "line",
        source: "track",
        filter: ["==", ["get", "role"], "route"],
        paint: {
          "line-color": "#8e8e93",
          "line-width": 1.2,
          "line-dasharray": [3, 3],
          "line-opacity": 0.7,
        },
      });
      instance.addLayer({
        id: "track-trail",
        type: "line",
        source: "track",
        filter: ["==", ["get", "role"], "trail"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-width": 2.4,
          // Along the line rather than by feature: the far end is where the
          // aircraft was, the near end is where it is.
          "line-gradient": [
            "interpolate",
            ["linear"],
            ["line-progress"],
            0, "rgba(90,200,250,0.15)",
            1, "#5ac8fa",
          ],
        },
      });
      instance.addLayer({
        id: "track-airports",
        type: "circle",
        source: "track",
        filter: ["==", ["get", "role"], "airport"],
        paint: {
          "circle-radius": 4,
          "circle-color": "#8e8e93",
          "circle-stroke-color": "#05050a",
          "circle-stroke-width": 1,
        },
      });
    } else {
      source.setData(data);
    }
  }, [track, ready, redraw]);

  /**
   * Drawing the area of interest.
   *
   * Two clicks, and like every other click mode this one is registered only
   * while it is on — a capture that outlives its panel silently eats clicks
   * meant for features.
   */
  const corner = useRef<[number, number] | null>(null);

  useEffect(() => {
    corner.current = null;
    const instance = map.current;
    if (instance === null || !ready || !drawingAoi) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const point: [number, number] = [event.lngLat.lng, event.lngLat.lat];
      const first = corner.current;
      if (first === null) {
        corner.current = point;
        return;
      }
      corner.current = null;
      onAoi({
        south: Math.min(first[1], point[1]),
        north: Math.max(first[1], point[1]),
        west: Math.min(first[0], point[0]),
        east: Math.max(first[0], point[0]),
      });
    };

    instance.getCanvas().style.cursor = "crosshair";
    instance.on("click", onClick);
    return () => {
      instance.off("click", onClick);
      instance.getCanvas().style.cursor = "";
    };
  }, [drawingAoi, ready, onAoi]);

  // The box itself, and whatever was found inside it.
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    const features: GeoJSON.Feature[] = [];
    if (aoi !== null) {
      features.push({
        type: "Feature",
        properties: { role: "aoi" },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [aoi.west, aoi.south],
              [aoi.east, aoi.south],
              [aoi.east, aoi.north],
              [aoi.west, aoi.north],
              [aoi.west, aoi.south],
            ],
          ],
        },
      });
    }

    const boxData: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features,
    };
    const infraData: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: aoiFeatures,
    };

    const boxSource = instance.getSource("aoi") as maplibregl.GeoJSONSource | undefined;
    if (boxSource === undefined) {
      instance.addSource("aoi", { type: "geojson", data: boxData });
      instance.addLayer({
        id: "aoi-fill",
        type: "fill",
        source: "aoi",
        paint: { "fill-color": "#35c46a", "fill-opacity": 0.08 },
      });
      instance.addLayer({
        id: "aoi-line",
        type: "line",
        source: "aoi",
        paint: {
          "line-color": "#35c46a",
          "line-width": 1.6,
          "line-dasharray": [2, 2],
        },
      });
    } else {
      boxSource.setData(boxData);
    }

    const infraSource = instance.getSource("aoi-infra") as
      | maplibregl.GeoJSONSource
      | undefined;
    if (infraSource === undefined) {
      instance.addSource("aoi-infra", { type: "geojson", data: infraData });
      instance.addLayer({
        id: "aoi-infra",
        type: "circle",
        source: "aoi-infra",
        paint: {
          "circle-radius": 5,
          "circle-color": ["coalesce", ["get", "colour"], "#ffd60a"],
          "circle-opacity": 0.9,
          "circle-stroke-color": "#05050a",
          "circle-stroke-width": 1,
        },
      });
    } else {
      infraSource.setData(infraData);
    }
  }, [aoi, aoiFeatures, ready, redraw]);

  // ── Layer painting ───────────────────────────────────────────────────────

  const paintFor = useCallback(
    (layerId: string): maplibregl.AddLayerObject => {
      const def = LAYER_BY_ID.get(layerId);
      const colour = def?.colour ?? "#ffffff";
      const base = { id: layerId, source: layerId } as const;

      /**
       * Anything that moves is drawn as a heading-rotated silhouette rather
       * than a dot.
       *
       * `icon-rotation-alignment: "map"` is the load-bearing option: it makes
       * the symbol turn with the globe, so a northbound aircraft points north
       * on screen at every bearing and projection. Screen alignment would
       * leave every heading wrong the moment the map rotated.
       *
       * Overlap and placement checks are both disabled. They are what makes
       * symbol layers expensive, and label collision is meaningless for
       * traffic — two aircraft close together should both be drawn, not
       * silently deconflicted.
       */
      if (def?.draw === "aircraft" || def?.draw === "vessel") {
        return {
          ...base,
          type: "symbol",
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            // A stationary object has no meaningful heading, so it keeps the
            // dot rather than pointing somewhere arbitrary.
            "icon-image": [
              "case",
              [
                "any",
                // `to-boolean`, because vessels carry no `grounded` property
                // at all and `any` rejects the null that `get` returns for a
                // missing key — which invalidates the whole layout and drops
                // the layer silently.
                ["to-boolean", ["get", "grounded"]],
                ["==", ["coalesce", ["get", "heading"], 0], 0],
              ],
              "dot",
              def.draw,
            ],
            "icon-rotate": ["coalesce", ["get", "heading"], 0],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
            "icon-size": [
              "interpolate",
              ["linear"],
              ["zoom"],
              2, 0.22,
              6, 0.34,
              11, 0.6,
            ],
            // Military and anything squawking an emergency draw over the top.
            "symbol-sort-key": [
              "case",
              ["!=", ["coalesce", ["get", "emergency"], ""], ""], 0,
              ["==", ["get", "tier"], "military"], 1,
              2,
            ],
          },
          paint: {
            "icon-color": ["coalesce", ["get", "colour"], colour],
            "icon-halo-color": "#05050a",
            "icon-halo-width": 1,
            "icon-opacity": 0.95,
          },
        } as maplibregl.AddLayerObject;
      }

      /**
       * Hazard areas: a translucent fill so the traffic and terrain under
       * them stay readable, and a firm edge so the boundary is exact. A solid
       * fill would hide the very thing the polygon is there to qualify.
       */
      if (def?.draw === "area") {
        return {
          ...base,
          type: "fill",
          filter: ["!=", ["geometry-type"], "Point"],
          paint: {
            "fill-color": ["coalesce", ["get", "colour"], colour],
            "fill-opacity": 0.18,
            "fill-outline-color": ["coalesce", ["get", "colour"], colour],
          },
        };
      }

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
        filter:
          def?.heavy === true
            ? ["all", ["==", ["geometry-type"], "Point"], ["!", ["has", "point_count"]]]
            : ["==", ["geometry-type"], "Point"],
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
      const def = LAYER_BY_ID.get(layerId);
      const clustered = def?.heavy === true;

      const source = instance.getSource(layerId) as
        | maplibregl.GeoJSONSource
        | undefined;
      if (source === undefined) {
        instance.addSource(layerId, {
          type: "geojson",
          data,
          ...(clustered
            ? {
                cluster: true,
                clusterRadius: 48,
                clusterMaxZoom: CLUSTER_MAX_ZOOM,
                clusterMinPoints: 4,
                /*
                 * Summed into each bubble so the aggregate can say something
                 * beyond "how many". Only fields the feed actually measures —
                 * a total of an invented number would be an invented total.
                 */
                ...(def?.weight !== undefined
                  ? {
                      clusterProperties: {
                        weight: ["+", ["coalesce", ["get", def.weight], 0]],
                      },
                    }
                  : {}),
              }
            : {}),
        });
      } else {
        source.setData(data);
      }

      if (instance.getLayer(layerId) === undefined) {
        try {
          ensureSymbols(instance);
        } catch {
          // The symbol layer falls back to MapLibre's missing-image
          // behaviour rather than taking the layer down.
        }
        instance.addLayer(paintFor(layerId));

        if (clustered) {
          // The bubble, sized by how many it stands for.
          instance.addLayer({
            id: `${layerId}-cluster`,
            type: "circle",
            source: layerId,
            filter: ["has", "point_count"],
            paint: {
              // Where the feed publishes an intensity, the bubble is coloured
              // by the summed value rather than by count alone — a hundred
              // smouldering detections and a hundred conflagrations are the
              // same count and very different events.
              "circle-color":
                def?.weight !== undefined
                  ? ([
                      "interpolate",
                      ["linear"],
                      ["coalesce", ["get", "weight"], 0],
                      0, "#ffd60a",
                      500, "#ff9f0a",
                      5000, "#ff3b52",
                    ] as unknown as string)
                  : ["coalesce", ["get", "colour"], def?.colour ?? "#8e8e93"],
              "circle-opacity": 0.55,
              "circle-radius": [
                "step",
                ["get", "point_count"],
                12, 50, 17, 500, 23, 5000, 30,
              ],
              "circle-stroke-color": "#05050a",
              "circle-stroke-width": 1,
            },
          });
          // And the count itself. A bubble without its number is just a
          // bigger dot, which is the problem thinning had.
          instance.addLayer({
            id: `${layerId}-count`,
            type: "symbol",
            source: layerId,
            filter: ["has", "point_count"],
            layout: {
              "text-field": ["get", "point_count_abbreviated"],
              "text-size": 11,
              "text-allow-overlap": true,
              "text-ignore-placement": true,
            },
            paint: {
              "text-color": "#05050a",
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.2,
            },
          });
        }

        // An area layer draws polygons; a cyclone's centre point needs its
        // own circle layer or the storm itself would be invisible inside its
        // own cone.
        if (LAYER_BY_ID.get(layerId)?.draw === "area") {
          instance.addLayer({
            id: endpointLayerId(layerId),
            source: layerId,
            type: "circle",
            filter: ["==", ["geometry-type"], "Point"],
            paint: {
              "circle-radius": 5,
              "circle-color": ["coalesce", ["get", "colour"], "#5ac8fa"],
              "circle-stroke-color": "#05050a",
              "circle-stroke-width": 1,
            },
          });
        }

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

  /**
   * Everything in view, unthinned.
   *
   * This used to sample heavy layers down to a ceiling, which meant an
   * operator looking at global fire activity saw about three per cent of it
   * presented as if it were the picture — and the map never said so. Worse,
   * the sampler took every nth feature by array position, so it discarded an
   * emergency squawk exactly as readily as a parked light aircraft.
   *
   * Clustering replaces it: the source aggregates, the bubbles carry the true
   * count, and nothing is thrown away. The viewport filter stays, because
   * there is no reason to hand the renderer the other hemisphere.
   */
  const inView = useCallback(
    (instance: maplibregl.Map, features: GeoJSON.Feature[]) => {
      const bounds = instance.getBounds();
      return features.filter((feature) => {
        if (feature.geometry.type !== "Point") return true;
        const [lon, lat] = feature.geometry.coordinates;
        return (
          typeof lon === "number" &&
          typeof lat === "number" &&
          bounds.contains([lon, lat])
        );
      });
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
        onHeld?.(new Map(raw.current));
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
      for (const id of [def.id, endpointLayerId(def.id), `${def.id}-cluster`, `${def.id}-count`]) {
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
  }, [active, ready, onStatus, redraw, ensure, inView, alive, onHeld]);

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

  /**
   * Attribute filters, applied to the style rather than to the data.
   *
   * The source keeps every feature; the filter decides what is drawn. That
   * makes filtering instant and reversible, and it is why the source has to
   * hold the unfiltered set — the other reason clustering replaced
   * destructive thinning.
   *
   * The filter is composed with each layer's own geometry predicate rather
   * than replacing it, or a point-only layer would start drawing its polygons.
   */
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready) return;

    for (const def of FEED_LAYERS) {
      if (instance.getLayer(def.id) === undefined) continue;

      const predicates = filters[def.id] ?? [];
      const compiled = compileAll(predicates);
      const base = paintFor(def.id) as { filter?: unknown };

      try {
        instance.setFilter(
          def.id,
          (compiled === null
            ? base.filter
            : base.filter === undefined
              ? compiled
              : ["all", base.filter, compiled]) as never,
        );

        // The cluster has to agree with the marks, or a bubble counts
        // features the map is no longer drawing.
        const clusterId = `${def.id}-cluster`;
        if (instance.getLayer(clusterId) !== undefined) {
          instance.setFilter(clusterId, ["has", "point_count"] as never);
        }
      } catch {
        // A layer mid-swap. The next redraw applies it.
      }
    }
    /*
     * `dataVersion` is in the dependencies because a layer does not exist
     * until its first fetch resolves. Without it this effect runs once
     * against an empty style and never again, so a filter arriving in the URL
     * is parsed, stored, shown in the panel — and silently never applied.
     */
  }, [filters, ready, redraw, active, paintFor, dataVersion]);

  // ── Selection ────────────────────────────────────────────────────────────
  useEffect(() => {
    const instance = map.current;
    if (instance === null || !ready || measure !== null || picking !== null || drawingAoi)
      return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      /*
       * A cluster is checked first and separately. Clicking one has to zoom
       * into it — a bubble that opens a detail card saying "1,204" would be
       * a dead end where the obvious gesture does nothing.
       */
      const clusterLayers = FEED_LAYERS.filter((l) => l.heavy === true)
        .map((l) => `${l.id}-cluster`)
        .filter((id) => instance.getLayer(id) !== undefined);

      if (clusterLayers.length > 0) {
        const cluster = instance.queryRenderedFeatures(event.point, {
          layers: clusterLayers,
        })[0];
        if (cluster !== undefined) {
          const layerId = cluster.layer.id.replace(/-cluster$/, "");
          const source = instance.getSource(layerId) as
            | maplibregl.GeoJSONSource
            | undefined;
          const clusterId = cluster.properties?.["cluster_id"];
          const [lon, lat] =
            cluster.geometry.type === "Point"
              ? cluster.geometry.coordinates
              : [event.lngLat.lng, event.lngLat.lat];

          if (source !== undefined && typeof clusterId === "number") {
            void source
              .getClusterExpansionZoom(clusterId)
              .then((zoom) => {
                instance.easeTo({
                  center: [lon as number, lat as number],
                  zoom,
                  duration: 500,
                });
              })
              .catch(() => {
                instance.easeTo({ center: [lon as number, lat as number], zoom: instance.getZoom() + 2 });
              });
          }
          return;
        }
      }

      const clickable = [...FEED_LAYERS.map((l) => l.id), "osint", "aoi-infra"].filter(
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
  }, [ready, onSelect, measure, picking, drawingAoi, active, redraw]);

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
