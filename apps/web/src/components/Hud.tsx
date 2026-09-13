"use client";

import { useEffect, useState } from "react";

import { clock, type Reading } from "@/lib/clock";

/**
 * The wall clock, in the viewer's own time zone.
 *
 * Rendered client-side only and started from an effect rather than from the
 * first render. The server has no idea what zone the browser is in, so a clock
 * rendered there and hydrated here disagrees with itself — by the whole UTC
 * offset, not just the request time — and React reports it as a hydration
 * mismatch. The dashes are what the server renders, and what the first client
 * frame renders too; the effect replaces them a moment later.
 */
export function LocalClock() {
  const [reading, setReading] = useState<Reading>({
    time: "--:--:--",
    zone: "",
  });

  useEffect(() => {
    const read = clock();
    const tick = () => setReading(read(new Date()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <span className="hud-clock">
      {reading.time}
      {reading.zone ? ` ${reading.zone}` : ""}
    </span>
  );
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
