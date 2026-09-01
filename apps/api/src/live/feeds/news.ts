import { cached } from "../cache.js";
import { getText } from "../http.js";

/**
 * The intel feed.
 *
 * Wire headlines from a handful of broadcasters that publish RSS, plus CISA's
 * cybersecurity advisories. Not a map layer — it has no coordinates, and
 * geocoding a headline by guessing at place names in it is exactly the kind of
 * invention this tool should not do. The map already has GDELT for geocoded
 * coverage; this is the reading-list version.
 *
 * Nothing here is scored, ranked or summarised. Every item is a headline, its
 * publisher and its time, in the order the publishers put them out. An
 * "importance" number computed from keywords would look authoritative and
 * mean nothing.
 */

interface Source {
  id: string;
  name: string;
  url: string;
  category: "world" | "security";
}

const SOURCES: Source[] = [
  {
    id: "bbc",
    name: "BBC World",
    url: "https://feeds.bbci.co.uk/news/world/rss.xml",
    category: "world",
  },
  {
    id: "aljazeera",
    name: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    category: "world",
  },
  {
    id: "france24",
    name: "France 24",
    url: "https://www.france24.com/en/rss",
    category: "world",
  },
  {
    id: "dw",
    name: "Deutsche Welle",
    url: "https://rss.dw.com/rdf/rss-en-world",
    category: "world",
  },
  {
    id: "npr",
    name: "NPR World",
    url: "https://feeds.npr.org/1004/rss.xml",
    category: "world",
  },
  {
    id: "cisa",
    name: "CISA Advisories",
    url: "https://www.cisa.gov/cybersecurity-advisories/all.xml",
    category: "security",
  },
];

export interface Headline {
  id: string;
  title: string;
  url: string | null;
  source: string;
  category: Source["category"];
  at: number | null;
}

/** Undo the five XML entities that appear in feed titles. */
function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function tag(item: string, name: string): string | null {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(item);
  return match?.[1] === undefined ? null : decode(match[1]);
}

/**
 * A deliberately small RSS reader.
 *
 * These feeds are RSS 2.0 and RDF, both of which put each story in an `<item>`
 * with a title, a link and a date. Pulling in a parser to read three fields
 * out of six well-formed documents is not a trade worth making, and a regex
 * that only ever sees these six feeds is a smaller surface than one that has
 * to handle arbitrary XML.
 */
function parseFeed(xml: string, source: Source): Headline[] {
  const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) ?? [];

  return items.flatMap((item, index) => {
    const title = tag(item, "title");
    if (title === null || title.length === 0) return [];

    // RDF feeds put the link in an attribute-free element; RSS sometimes uses
    // <guid> as the canonical URL.
    const link = tag(item, "link") ?? tag(item, "guid");
    const published =
      tag(item, "pubDate") ?? tag(item, "dc:date") ?? tag(item, "published");
    const at = published === null ? null : Date.parse(published);

    return [
      {
        id: `${source.id}-${link ?? index}`,
        title,
        url: link !== null && link.startsWith("http") ? link : null,
        source: source.name,
        category: source.category,
        at: at === null || Number.isNaN(at) ? null : at,
      },
    ];
  });
}

const TTL_MS = 5 * 60_000;

export async function news(): Promise<{ headlines: Headline[] }> {
  return cached("news", TTL_MS, async () => {
    const settled = await Promise.allSettled(
      SOURCES.map(async (source) => {
        const xml = await getText(source.url, { timeoutMs: 20_000 });
        // A publisher that stops answering thins the feed rather than
        // emptying it.
        return parseFeed(xml, source).slice(0, 25);
      }),
    );

    /*
     * Deduplicated by URL.
     *
     * Publishers list the same article under several sections — France 24 puts
     * one story in both its topic feed and its regional one — so the same link
     * arrives twice with the same id. That is a duplicate in the data, not a
     * rendering problem, and fixing it here rather than in a React key means
     * the feed shows one entry instead of two identical ones.
     */
    const seen = new Set<string>();
    const headlines = settled
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((headline) => {
        const key = headline.url ?? headline.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));

    return { headlines };
  });
}
