"use client";

import { useEffect, useState } from "react";

/**
 * Markets & Intel — the /api/live/markets quotes, grouped.
 *
 * The feed carries a current price and day change per symbol, not a time
 * series, so rows show price and change rather than a sparkline that would have
 * to be invented. Refetches every 60s while the panel is open.
 */
interface Quote {
  symbol: string;
  name: string;
  group: string;
  price: number | null;
  changePercent: number | null;
  currency: string;
  marketOpen: boolean;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const GROUPS: [string, string][] = [
  ["index", "Indices"],
  ["equity", "Defense"],
  ["commodity", "Commodities"],
  ["rate", "Rates"],
  ["crypto", "Crypto"],
];

function fmtPrice(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function MarketsPanel({ kp }: { kp?: { kp: number | null; level: string } | null }) {
  const [quotes, setQuotes] = useState<Quote[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/live/markets", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ quotes?: Quote[] }>)
        .then((d) => {
          if (!cancelled) setQuotes(d.quotes ?? []);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (quotes === null) return <p className="panel-empty">Loading markets…</p>;

  const up = quotes.filter((q) => (num(q.changePercent) ?? 0) > 0).length;
  const down = quotes.filter((q) => (num(q.changePercent) ?? 0) < 0).length;
  const vix = quotes.find((q) => q.symbol === ".VIX");
  const vixPrice = num(vix?.price);
  const vixChg = num(vix?.changePercent);

  return (
    <div className="markets-panel">
      <div className="markets-summary">
        <span>
          BREADTH <b className="up">{up}▲</b> / <b className="down">{down}▼</b>
        </span>
        {vixPrice !== null ? (
          <span>
            VIX <b>{vixPrice.toFixed(2)}</b>{" "}
            {vixChg !== null ? (
              <em className={vixChg >= 0 ? "up" : "down"}>
                {vixChg >= 0 ? "+" : ""}
                {vixChg.toFixed(2)}%
              </em>
            ) : null}
          </span>
        ) : null}
        {kp ? (
          <span>
            SOLAR <b>Kp {kp.kp ?? "?"}</b>
          </span>
        ) : null}
      </div>

      {GROUPS.map(([group, label]) => {
        const rows = quotes.filter((q) => q.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group} className="markets-group">
            <h3>{label}</h3>
            <ul>
              {rows.map((q) => {
                const price = num(q.price);
                const chg = num(q.changePercent);
                return (
                  <li key={q.symbol}>
                    <span className="mk-name">{q.name}</span>
                    <span className="mk-price">{price !== null ? fmtPrice(price) : "—"}</span>
                    <span className={`mk-chg ${chg !== null && chg < 0 ? "down" : "up"}`}>
                      {chg !== null ? `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
