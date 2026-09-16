"use client";

import { useCallback, useState } from "react";

export interface Place {
  label: string;
  lat: number;
  lon: number;
  kind: string | null;
}

/**
 * The main search bar: investigate anything.
 *
 * Whatever is typed — a name, a company, a domain, a hash, an address — is run
 * across every source and shown in the Investigate panel. The one exception is
 * a bare coordinate pair, which flies the map there, because that is
 * unambiguously a place rather than an artifact to look up.
 *
 * There is deliberately no geocoder here any more. Routing a person's name to
 * OpenStreetMap only ever produced "No Results", which is the opposite of what
 * a search for a person should do.
 */

const COORDINATES = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function Search({
  onFly,
  onInvestigate,
}: {
  onFly: (place: { lat: number; lon: number; zoom?: number }) => void;
  /** Run the term across every source in the Investigate panel. */
  onInvestigate: (value: string) => void;
}) {
  const [term, setTerm] = useState("");

  const submit = useCallback(
    (event?: React.FormEvent) => {
      event?.preventDefault();
      const value = term.trim();
      if (value.length === 0) return;

      const coordinates = COORDINATES.exec(value);
      if (coordinates !== null) {
        const lat = Number(coordinates[1]);
        const lon = Number(coordinates[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
          onFly({ lat, lon, zoom: 9 });
          return;
        }
      }

      onInvestigate(value);
    },
    [term, onFly, onInvestigate],
  );

  return (
    <form className="search" onSubmit={submit}>
      <div className="search-box">
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Investigate anything — name, company, domain, place…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Search"
        />
        <button type="submit" aria-label="Investigate">
          ⌕
        </button>
      </div>
    </form>
  );
}
