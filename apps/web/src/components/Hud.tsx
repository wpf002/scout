"use client";

import { useEffect, useState } from "react";

/**
 * The Zulu clock.
 *
 * Rendered client-side only and started from an effect rather than from the
 * first render. A UTC clock rendered on the server and hydrated on the client
 * disagrees with itself by however long the request took, and React reports it
 * as a hydration mismatch.
 */
export function ZuluClock() {
  const [now, setNow] = useState<string>("--:--:--");

  useEffect(() => {
    const tick = () =>
      setNow(new Date().toISOString().slice(11, 19));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return <span className="hud-clock">ZULU {now}Z</span>;
}

export interface TickerItem {
  id: string;
  label: string;
  tone?: "warn" | "deny" | "ok";
}

/**
 * The bottom ticker.
 *
 * Duplicated once so the marquee can loop without a visible seam — the second
 * copy is hidden from assistive technology because it is the same content.
 */
export function Ticker({ items }: { items: TickerItem[] }) {
  if (items.length === 0) return null;

  const row = (ariaHidden: boolean) => (
    <div className="ticker-row" aria-hidden={ariaHidden || undefined}>
      {items.map((item, index) => (
        <span key={`${item.id}-${index}`} className={`tick ${item.tone ?? ""}`}>
          <span className="tick-dot" />
          {item.label}
        </span>
      ))}
    </div>
  );

  return (
    <div className="ticker">
      {row(false)}
      {row(true)}
    </div>
  );
}
