"use client";

import { useCallback, useEffect, useState } from "react";
import type { Place } from "./Search";

/**
 * Route planning.
 *
 * Two or more stops, one of three profiles, and a line on the map. Everything
 * goes through Scout's API for the same reason the geocoder does: the routing
 * service is a shared public courtesy with no uptime promise, and one process
 * holding to a sane rate is the difference between it working and the
 * operator's address being the one that gets blocked.
 *
 * A stop can be typed as a place name, pasted as coordinates, or picked off
 * the map. The pick mode is deliberately explicit rather than always-on —
 * a panel that silently captures the next map click is a panel that eats
 * clicks meant for features.
 */

export interface Stop {
  label: string;
  lat: number;
  lon: number;
}

export interface Route {
  distanceM: number;
  durationS: number;
  coordinates: [number, number][];
  steps: Array<{ name: string; distanceM: number; maneuver: string }>;
}

const PROFILES = [
  { id: "driving", name: "Drive" },
  { id: "bike", name: "Bike" },
  { id: "foot", name: "Walk" },
] as const;

const COORDINATES = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function formatDistance(metres: number): string {
  return metres < 1000
    ? `${Math.round(metres)} m`
    : `${(metres / 1000).toFixed(metres < 100_000 ? 1 : 0)} km`;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return hours === 0 ? `${minutes} min` : `${hours} h ${minutes} min`;
}

export function Directions({
  stops,
  setStops,
  picking,
  setPicking,
  onRoute,
  onFly,
}: {
  stops: Array<Stop | null>;
  setStops: (stops: Array<Stop | null>) => void;
  picking: number | null;
  setPicking: (index: number | null) => void;
  onRoute: (route: Route | null) => void;
  onFly: (place: { lat: number; lon: number; zoom?: number }) => void;
}) {
  const [profile, setProfile] = useState<(typeof PROFILES)[number]["id"]>("driving");
  const [route, setRoute] = useState<Route | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<string[]>(["", ""]);

  useEffect(() => {
    setDrafts((current) =>
      stops.map((stop, index) => stop?.label ?? current[index] ?? ""),
    );
  }, [stops]);

  const resolve = useCallback(
    async (index: number, term: string) => {
      const value = term.trim();
      if (value.length === 0) return;

      const coordinates = COORDINATES.exec(value);
      if (coordinates !== null) {
        const lat = Number(coordinates[1]);
        const lon = Number(coordinates[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          const next = [...stops];
          next[index] = { label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`, lat, lon };
          setStops(next);
          return;
        }
      }

      try {
        const response = await fetch(
          `/api/geo/search?q=${encodeURIComponent(value)}`,
          { cache: "no-store" },
        );
        const data = (await response.json()) as { results?: Place[] };
        const first = data.results?.[0];
        if (first === undefined) {
          setError(`Could not find "${value}".`);
          return;
        }
        setError(null);
        const next = [...stops];
        next[index] = { label: first.label, lat: first.lat, lon: first.lon };
        setStops(next);
      } catch {
        setError("Place lookup failed.");
      }
    },
    [stops, setStops],
  );

  const plan = useCallback(async () => {
    const placed = stops.filter((s): s is Stop => s !== null);
    if (placed.length < 2) {
      setError("Two stops are needed to plan a route.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const waypoints = placed.map((s) => `${s.lon},${s.lat}`).join(";");
      const response = await fetch(
        `/api/geo/route?profile=${profile}&waypoints=${encodeURIComponent(waypoints)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        route?: Route | null;
        error?: string;
      };
      if (data.route == null) {
        setError(data.error ?? "No route between those points.");
        setRoute(null);
        onRoute(null);
        return;
      }
      setRoute(data.route);
      onRoute(data.route);
    } catch {
      setError("The router did not answer.");
    } finally {
      setBusy(false);
    }
  }, [stops, profile, onRoute]);

  const clear = () => {
    setStops([null, null]);
    setDrafts(["", ""]);
    setRoute(null);
    setError(null);
    setPicking(null);
    onRoute(null);
  };

  return (
    <div className="directions">
      <div className="measure-shapes">
        {PROFILES.map((p) => (
          <button
            key={p.id}
            className={profile === p.id ? "on" : undefined}
            onClick={() => setProfile(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>

      <ol className="stops">
        {stops.map((stop, index) => (
          <li key={index}>
            <span className="stop-pin">
              {index === 0 ? "A" : index === stops.length - 1 ? "B" : index}
            </span>
            <input
              value={drafts[index] ?? ""}
              placeholder={
                index === 0 ? "Choose starting point" : "Choose destination"
              }
              spellCheck={false}
              onChange={(event) => {
                const next = [...drafts];
                next[index] = event.target.value;
                setDrafts(next);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void resolve(index, drafts[index] ?? "");
                }
              }}
              onBlur={() => {
                if (stop === null) void resolve(index, drafts[index] ?? "");
              }}
            />
            <button
              className={`pick${picking === index ? " on" : ""}`}
              title="Pick this stop on the map"
              onClick={() => setPicking(picking === index ? null : index)}
            >
              ⌖
            </button>
            {stops.length > 2 ? (
              <button
                className="pick"
                title="Remove this stop"
                onClick={() => {
                  setStops(stops.filter((_, i) => i !== index));
                  setDrafts(drafts.filter((_, i) => i !== index));
                }}
              >
                −
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="directions-actions">
        <button
          onClick={() => {
            // A stop is inserted before the destination, which is where an
            // added stop actually belongs.
            const next = [...stops];
            next.splice(next.length - 1, 0, null);
            setStops(next);
            const nextDrafts = [...drafts];
            nextDrafts.splice(nextDrafts.length - 1, 0, "");
            setDrafts(nextDrafts);
          }}
          disabled={stops.length >= 12}
        >
          Add a stop
        </button>
        <button className="primary" onClick={() => void plan()} disabled={busy}>
          {busy ? "Planning…" : "Get directions"}
        </button>
        <button onClick={clear}>Clear</button>
      </div>

      {picking !== null ? (
        <p className="measure-hint">Click the map to place stop {picking + 1}.</p>
      ) : null}
      {error !== null ? <p className="directions-error">{error}</p> : null}

      {route !== null ? (
        <>
          <p className="measure-reading">
            {formatDistance(route.distanceM)} · {formatDuration(route.durationS)}
          </p>
          <ol className="route-steps">
            {route.steps.slice(0, 60).map((step, index) => (
              <li key={index}>
                <span className="step-manoeuvre">{step.maneuver}</span>
                <span className="step-name">{step.name}</span>
                <span className="step-distance">
                  {formatDistance(step.distanceM)}
                </span>
              </li>
            ))}
          </ol>
          {route.steps.length > 60 ? (
            <p className="measure-hint">
              Showing the first 60 of {route.steps.length} steps.
            </p>
          ) : null}
          <div className="directions-actions">
            <button
              onClick={() => {
                const first = stops.find((s): s is Stop => s !== null);
                if (first !== undefined) {
                  onFly({ lat: first.lat, lon: first.lon, zoom: 11 });
                }
              }}
            >
              Go to start
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
