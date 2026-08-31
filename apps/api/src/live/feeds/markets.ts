import { z } from "zod";
import { cached } from "../cache.js";
import { getJson, getText } from "../http.js";

/**
 * The markets ticker.
 *
 * Not a map layer — it feeds the crawl at the bottom of the screen, so it is a
 * plain reading rather than GeoJSON.
 *
 * One request for everything. CNBC's quote service takes a pipe-separated
 * symbol list and answers with the lot, which is both faster and far politer
 * than a request per instrument. Yahoo rate limits a server address almost
 * immediately and Stooq refuses one outright, so neither is depended on;
 * CoinGecko covers crypto and needs no key.
 *
 * This is fetched here rather than from the browser because none of these
 * services send CORS headers, and because one process asking once a minute is
 * the difference between it working and every viewer being rate limited
 * individually.
 */

export interface Quote {
  symbol: string;
  name: string;
  group: "index" | "commodity" | "crypto" | "rate" | "equity";
  price: number;
  changePercent: number | null;
  currency: string;
  marketOpen: boolean;
}

interface Instrument {
  symbol: string;
  name: string;
  group: Quote["group"];
}

/**
 * CNBC's own symbols. The leading dot marks an index, `@` a futures contract,
 * and `US10Y` the benchmark yield.
 */
const INSTRUMENTS: Instrument[] = [
  { symbol: ".SPX", name: "S&P 500", group: "index" },
  { symbol: ".NDX", name: "Nasdaq 100", group: "index" },
  { symbol: ".DJI", name: "Dow Jones", group: "index" },
  { symbol: ".VIX", name: "VIX", group: "index" },
  { symbol: ".FTSE", name: "FTSE 100", group: "index" },
  { symbol: ".GDAXI", name: "DAX", group: "index" },
  { symbol: ".N225", name: "Nikkei 225", group: "index" },
  { symbol: ".DXY", name: "Dollar Index", group: "rate" },
  { symbol: "US10Y", name: "US 10-Year", group: "rate" },
  { symbol: "@CL.1", name: "Crude Oil (WTI)", group: "commodity" },
  { symbol: "@LCO.1", name: "Brent Crude", group: "commodity" },
  { symbol: "@GC.1", name: "Gold", group: "commodity" },
  { symbol: "@NG.1", name: "Natural Gas", group: "commodity" },
  { symbol: "RTX", name: "RTX", group: "equity" },
  { symbol: "LMT", name: "Lockheed Martin", group: "equity" },
  { symbol: "NOC", name: "Northrop Grumman", group: "equity" },
  { symbol: "BA", name: "Boeing", group: "equity" },
];

const CNBC_SCHEMA = z.object({
  FormattedQuoteResult: z.object({
    FormattedQuote: z
      .union([
        z.array(z.record(z.string(), z.unknown())),
        z.record(z.string(), z.unknown()),
      ])
      .optional(),
  }),
});

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // Every number arrives as a formatted string: thousands separators, a
  // trailing percent sign, and a leading plus on a positive move.
  const parsed = Number(value.replace(/[,%+\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function cnbc(): Promise<Quote[]> {
  const symbols = INSTRUMENTS.map((i) => i.symbol).join("|");
  const parsed = CNBC_SCHEMA.parse(
    await getJson(
      `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(symbols)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`,
      {
        // Answered only to something that looks like a browser.
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
        timeoutMs: 20_000,
      },
    ),
  );

  const raw = parsed.FormattedQuoteResult.FormattedQuote;
  // A single symbol comes back as an object rather than a one-element array.
  const rows = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const byInstrument = new Map(INSTRUMENTS.map((i) => [i.symbol, i]));

  return rows.flatMap((row): Quote[] => {
    const symbol = String(row["symbol"] ?? "");
    const instrument = byInstrument.get(symbol);
    const price = num(row["last"]);
    if (instrument === undefined || price === null) return [];

    return [
      {
        symbol,
        name: instrument.name,
        group: instrument.group,
        price,
        changePercent: num(row["change_pct"]),
        currency: String(row["currencyCode"] ?? "USD"),
        marketOpen: String(row["curmktstatus"] ?? "") === "REG_MKT",
      },
    ];
  });
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
        // Crypto never closes.
        marketOpen: true,
      },
    ];
  });
}

const TTL_MS = 5 * 60_000;

export async function markets(): Promise<{ quotes: Quote[] }> {
  return cached("markets", TTL_MS, async () => {
    const settled = await Promise.allSettled([cnbc(), crypto()]);

    // A provider that fails costs its instruments, not the ticker.
    const quotes = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );

    return { quotes };
  });
}
