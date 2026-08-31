"use client";

import { useCallback, useRef, useState } from "react";

export interface Place {
  label: string;
  lat: number;
  lon: number;
  kind: string | null;
}

/**
 * One box, three kinds of input.
 *
 * A coordinate pair flies there. An indicator — an address, a domain, an email
 * — opens the OSINT panel with it, because that is Scout's own answer and
 * routing it to a geocoder would be absurd. Anything else is a place name.
 *
 * The split happens here rather than on the server so a coordinate never
 * leaves the machine to be told it is a coordinate, and so pasting an email
 * address does not hand it to OpenStreetMap on the way to deciding it is not
 * a town.
 */

const COORDINATES = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/**
 * Deliberately narrow. This only has to catch the things that are obviously
 * not places; the detector behind the OSINT panel does the real work, and a
 * place name that reaches it is corrected there rather than run blind.
 */
const INDICATOR =
  /^(?:\S+@\S+\.\S+|(?:\d{1,3}\.){3}\d{1,3}|[a-f0-9]{32,128}|(?:[a-z0-9-]+\.)+[a-z]{2,})$/i;

export function Search({
  onFly,
  onIndicator,
}: {
  onFly: (place: { lat: number; lon: number; zoom?: number }) => void;
  onIndicator: (value: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const value = term.trim();
      if (value.length === 0) return;

      const coordinates = COORDINATES.exec(value);
      if (coordinates !== null) {
        const lat = Number(coordinates[1]);
        const lon = Number(coordinates[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          setResults(null);
          onFly({ lat, lon, zoom: 9 });
          return;
        }
      }

      if (INDICATOR.test(value)) {
        setResults(null);
        onIndicator(value);
        return;
      }

      const id = ++request.current;
      setBusy(true);
      try {
        const response = await fetch(
          `/api/geo/search?q=${encodeURIComponent(value)}`,
          { cache: "no-store" },
        );
        const data = (await response.json()) as { results?: Place[] };
        // A slower earlier search must not overwrite a faster later one.
        if (id !== request.current) return;
        setResults(data.results ?? []);
      } catch {
        if (id === request.current) setResults([]);
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [term, onFly, onIndicator],
  );

  return (
    <form className="search" onSubmit={submit}>
      <input
        value={term}
        onChange={(event) => {
          setTerm(event.target.value);
          if (results !== null) setResults(null);
        }}
        placeholder="Place, coordinates, or indicator"
        spellCheck={false}
        autoComplete="off"
        aria-label="Search"
      />
      {busy ? <span className="search-busy" aria-hidden /> : null}

      {results !== null ? (
        <ul className="search-results">
          {results.length === 0 ? (
            <li className="search-empty">No Results</li>
          ) : (
            results.map((place) => (
              <li key={`${place.lat},${place.lon}`}>
                <button
                  type="button"
                  onClick={() => {
                    setResults(null);
                    setTerm(place.label);
                    onFly({ lat: place.lat, lon: place.lon, zoom: 8 });
                  }}
                >
                  {place.label}
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </form>
  );
}
