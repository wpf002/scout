import { z } from "zod";
import { cached } from "../cache.js";
import { getJson, getText } from "../http.js";

/**
 * The markets ticker.
 *
 * Not a map layer — it feeds the crawl at the bottom of the screen, so it is a
 * plain reading rather than GeoJSON.
 *
 * Yahoo's chart endpoint rate limits hard and inconsistently from a single
 * address, so it is not depended on. Stooq serves a CSV quote per symbol with
 * no key and no limit worth worrying about, and CoinGecko covers crypto. Where
 * a symbol cannot be had, it is left out rather than shown stale.
 */

export interface Quote {
  symbol: string;
  name: string;
  group: "index" | "commodity" | "crypto" | "rate";
  price: number;
  changePercent: number | null;
  currency: string;
}

interface Instrument {
  stooq: string | null;
  name: string;
  group: Quote["group"];
  currency: string;
}

const INSTRUMENTS: Instrument[] = [
  { stooq: "^spx", name: "S&P 500", group: "index", currency: "USD" },
  { stooq: "^ndq", name: "Nasdaq 100", group: "index", currency: "USD" },
  { stooq: "^dji", name: "Dow Jones", group: "index", currency: "USD" },
  { stooq: "^vix", name: "VIX", group: "index", currency: "USD" },
  { stooq: "^ftm", name: "FTSE 100", group: "index", currency: "GBP" },
  { stooq: "^dax", name: "DAX", group: "index", currency: "EUR" },
  { stooq: "^nkx", name: "Nikkei 225", group: "index", currency: "JPY" },
  { stooq: "cl.f", name: "Crude Oil (WTI)", group: "commodity", currency: "USD" },
  { stooq: "cb.f", name: "Brent Crude", group: "commodity", currency: "USD" },
  { stooq: "gc.f", name: "Gold", group: "commodity", currency: "USD" },
  { stooq: "si.f", name: "Silver", group: "commodity", currency: "USD" },
  { stooq: "ng.f", name: "Natural Gas", group: "commodity", currency: "USD" },
  { stooq: "eurusd", name: "EUR / USD", group: "rate", currency: "USD" },
  { stooq: "usdjpy", name: "USD / JPY", group: "rate", currency: "JPY" },
];

/**
 * Stooq's CSV quote. Symbol, date, time, open, high, low, close, volume — and
 * "N/D" in every numeric column when it does not know the symbol, which is why
 * the close is checked for a number rather than for presence.
 */
async function stooq(instrument: Instrument): Promise<Quote | null> {
  if (instrument.stooq === null) return null;

  const csv = await getText(
    `https://stooq.com/q/l/?s=${encodeURIComponent(instrument.stooq)}&f=sd2t2ohlcv&h&e=csv`,
    { timeoutMs: 15_000 },
  );

  const row = csv.trim().split("\n")[1];
  if (row === undefined) return null;
  const cells = row.split(",");
  const open = Number(cells[3]);
  const close = Number(cells[6]);
  if (!Number.isFinite(close)) return null;

  return {
    symbol: instrument.stooq.toUpperCase(),
    name: instrument.name,
    group: instrument.group,
    price: close,
    // Stooq's daily quote carries no previous close, so the move shown is the
    // session's — open to last — which is what it actually is.
    changePercent: Number.isFinite(open) && open !== 0
      ? ((close - open) / open) * 100
      : null,
    currency: instrument.currency,
  };
}

const COINGECKO_SCHEMA = z.record(
  z.string(),
  z.object({ usd: z.number(), usd_24h_change: z.number().optional() }),
);

const COINS: Array<[string, string]> = [
  ["bitcoin", "Bitcoin"],
  ["ethereum", "Ethereum"],
];

async function crypto(): Promise<Quote[]> {
  const parsed = COINGECKO_SCHEMA.parse(
    await getJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${COINS.map(([id]) => id).join(",")}&vs_currencies=usd&include_24hr_change=true`,
      { timeoutMs: 15_000 },
    ),
  );

  return COINS.flatMap(([id, name]) => {
    const row = parsed[id];
    if (row === undefined) return [];
    return [
      {
        symbol: name.toUpperCase(),
        name,
        group: "crypto" as const,
        price: row.usd,
        changePercent: row.usd_24h_change ?? null,
        currency: "USD",
      },
    ];
  });
}

const TTL_MS = 5 * 60_000;

export async function markets(): Promise<{ quotes: Quote[] }> {
  return cached("markets", TTL_MS, async () => {
    const settled = await Promise.allSettled([
      ...INSTRUMENTS.map((i) => stooq(i)),
      crypto(),
    ]);

    const quotes = settled.flatMap((result) => {
      if (result.status !== "fulfilled" || result.value === null) return [];
      return Array.isArray(result.value) ? result.value : [result.value];
    });

    return { quotes };
  });
}
