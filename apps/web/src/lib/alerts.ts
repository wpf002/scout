"use client";

import { useEffect, useState } from "react";

/**
 * The alert stream.
 *
 * Built from the same feeds the map draws, so the list and the dots can never
 * disagree about what is happening. It reads only layers that are actually
 * switched on: an alert for something invisible sends an operator looking for
 * a mark that is not there.
 *
 * Severity is derived from what each feed measures rather than asserted.
 * Magnitude is a real scale. GDELT's tone is a real number. Nothing here
 * invents a threat level, and nothing is described as more urgent than the
 * source says it is.
 */

export type Severity = "high" | "medium" | "low";

export interface Alert {
  id: string;
  label: string;
  detail: string;
  severity: Severity;
  at: number | null;
  lat: number;
  lon: number;
  layer: string;
  url: string | null;
}

/*
 * `gdelt_events`, not `live_news`.
 *
 * These were the same layer once. `live_news` is now the curated list of
 * broadcasters — eighteen newsrooms with no tone and no timestamp — so every
 * one of them was silently dropped by the tone filter and the alert stream
 * quietly lost its entire news dimension while still looking like it had one.
 */
const FEEDS = ["earthquakes", "global_incidents", "gdelt_events"] as const;

/** Quakes below this are constant background and would drown everything else. */
const MIN_MAGNITUDE = 2.5;

/** GDELT tone runs about -20..+20; well below zero is what an alert means. */
const MAX_TONE = -5;

function timestamp(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toAlert(
  layer: string,
  feature: GeoJSON.Feature,
): Alert | null {
  if (feature.geometry.type !== "Point") return null;
  const [lon, lat] = feature.geometry.coordinates;
  if (typeof lon !== "number" || typeof lat !== "number") return null;

  const p = (feature.properties ?? {}) as Record<string, unknown>;
  const label = typeof p["label"] === "string" ? p["label"] : layer;
  const id = typeof p["id"] === "string" ? p["id"] : `${lon},${lat}`;
  const url = typeof p["url"] === "string" ? p["url"] : null;
  const at = timestamp(p["at"]);

  if (layer === "earthquakes") {
    const magnitude = typeof p["magnitude"] === "number" ? p["magnitude"] : 0;
    if (magnitude < MIN_MAGNITUDE) return null;
    return {
      id,
      label,
      detail: `M${magnitude.toFixed(1)}`,
      severity: magnitude >= 5 ? "high" : magnitude >= 4 ? "medium" : "low",
      at,
      lat,
      lon,
      layer,
      url,
    };
  }

  if (layer === "global_incidents") {
    const category = typeof p["category"] === "string" ? p["category"] : "Event";
    return {
      id,
      label,
      detail: category,
      // EONET publishes open natural events without ranking them, so ranking
      // them here would be inventing a number the source does not have.
      severity: "medium",
      at,
      lat,
      lon,
      layer,
      url,
    };
  }

  const tone = typeof p["tone"] === "number" ? p["tone"] : 0;
  if (tone > MAX_TONE) return null;
  const theme = typeof p["theme"] === "string" ? p["theme"] : "News";
  return {
    id,
    label,
    detail: theme,
    severity: tone <= -10 ? "high" : "medium",
    at,
    lat,
    lon,
    layer,
    url,
  };
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function useAlerts(active: string[], limit = 60): Alert[] {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const wanted = FEEDS.filter((feed) => active.includes(feed));
  const key = wanted.join(",");

  useEffect(() => {
    if (key.length === 0) {
      setAlerts([]);
      return;
    }

    let cancelled = false;

    const load = async () => {
      const results = await Promise.all(
        key.split(",").map(async (layer) => {
          try {
            const response = await fetch(`/api/live/${layer}`, {
              cache: "no-store",
            });
            const data = (await response.json()) as GeoJSON.FeatureCollection;
            return data.features.flatMap((feature) => {
              const alert = toAlert(layer, feature);
              return alert === null ? [] : [alert];
            });
          } catch {
            // One quiet feed, not an empty panel.
            return [];
          }
        }),
      );
      if (cancelled) return;

      const merged = results
        .flat()
        .sort(
          (a, b) =>
            RANK[a.severity] - RANK[b.severity] || (b.at ?? 0) - (a.at ?? 0),
        )
        .slice(0, limit);
      setAlerts(merged);
    };

    void load();
    const timer = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key, limit]);

  return alerts;
}

export function ago(at: number | null): string {
  if (at === null) return "";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
