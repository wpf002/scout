/**
 * Maritime reference geography.
 *
 * Ports and chokepoints are not a feed — they are where the world's shipping
 * physically has to go, and that changes on a scale of decades. Throughput
 * figures are the most recent published annual volumes and are labelled with
 * their year rather than presented as live, because a number that moves once a
 * year should not sit next to a number that moves once a minute without
 * saying so.
 */

export interface Port {
  name: string;
  country: string;
  lat: number;
  lon: number;
  rank: number;
  teuMillions: number;
}

/** Container throughput, million TEU, 2023 published figures. */
export const PORTS: Port[] = [
  { name: "Shanghai", country: "China", lat: 31.23, lon: 121.47, rank: 1, teuMillions: 49.2 },
  { name: "Singapore", country: "Singapore", lat: 1.264, lon: 103.822, rank: 2, teuMillions: 39.0 },
  { name: "Ningbo-Zhoushan", country: "China", lat: 29.87, lon: 121.55, rank: 3, teuMillions: 35.3 },
  { name: "Shenzhen", country: "China", lat: 22.49, lon: 113.89, rank: 4, teuMillions: 29.9 },
  { name: "Qingdao", country: "China", lat: 36.09, lon: 120.32, rank: 5, teuMillions: 28.8 },
  { name: "Guangzhou", country: "China", lat: 23.09, lon: 113.44, rank: 6, teuMillions: 25.4 },
  { name: "Busan", country: "South Korea", lat: 35.1, lon: 129.04, rank: 7, teuMillions: 23.0 },
  { name: "Tianjin", country: "China", lat: 38.98, lon: 117.78, rank: 8, teuMillions: 22.2 },
  { name: "Jebel Ali", country: "United Arab Emirates", lat: 25.01, lon: 55.06, rank: 9, teuMillions: 14.5 },
  { name: "Rotterdam", country: "Netherlands", lat: 51.95, lon: 4.14, rank: 10, teuMillions: 13.4 },
  { name: "Port Klang", country: "Malaysia", lat: 3.0, lon: 101.39, rank: 11, teuMillions: 14.1 },
  { name: "Antwerp-Bruges", country: "Belgium", lat: 51.26, lon: 4.4, rank: 12, teuMillions: 12.5 },
  { name: "Xiamen", country: "China", lat: 24.48, lon: 118.07, rank: 13, teuMillions: 12.5 },
  { name: "Tanjung Pelepas", country: "Malaysia", lat: 1.36, lon: 103.55, rank: 14, teuMillions: 10.5 },
  { name: "Hong Kong", country: "Hong Kong", lat: 22.34, lon: 114.11, rank: 15, teuMillions: 14.4 },
  { name: "Los Angeles", country: "United States", lat: 33.73, lon: -118.26, rank: 16, teuMillions: 8.6 },
  { name: "Long Beach", country: "United States", lat: 33.75, lon: -118.21, rank: 17, teuMillions: 8.0 },
  { name: "Laem Chabang", country: "Thailand", lat: 13.08, lon: 100.89, rank: 18, teuMillions: 8.7 },
  { name: "New York / New Jersey", country: "United States", lat: 40.67, lon: -74.13, rank: 19, teuMillions: 7.8 },
  { name: "Hamburg", country: "Germany", lat: 53.54, lon: 9.93, rank: 20, teuMillions: 7.7 },
  { name: "Colombo", country: "Sri Lanka", lat: 6.95, lon: 79.84, rank: 21, teuMillions: 6.9 },
  { name: "Piraeus", country: "Greece", lat: 37.94, lon: 23.63, rank: 22, teuMillions: 5.0 },
  { name: "Valencia", country: "Spain", lat: 39.44, lon: -0.32, rank: 23, teuMillions: 4.8 },
  { name: "Algeciras", country: "Spain", lat: 36.13, lon: -5.44, rank: 24, teuMillions: 4.8 },
  { name: "Santos", country: "Brazil", lat: -23.96, lon: -46.31, rank: 25, teuMillions: 4.9 },
  { name: "Jawaharlal Nehru", country: "India", lat: 18.95, lon: 72.95, rank: 26, teuMillions: 6.4 },
  { name: "Mundra", country: "India", lat: 22.74, lon: 69.7, rank: 27, teuMillions: 7.4 },
  { name: "Salalah", country: "Oman", lat: 16.94, lon: 54.0, rank: 28, teuMillions: 4.5 },
  { name: "Manila", country: "Philippines", lat: 14.6, lon: 120.95, rank: 29, teuMillions: 5.2 },
  { name: "Tokyo", country: "Japan", lat: 35.62, lon: 139.79, rank: 30, teuMillions: 4.3 },
  { name: "Savannah", country: "United States", lat: 32.13, lon: -81.14, rank: 31, teuMillions: 5.0 },
  { name: "Vancouver", country: "Canada", lat: 49.29, lon: -123.09, rank: 32, teuMillions: 3.5 },
  { name: "Durban", country: "South Africa", lat: -29.87, lon: 31.02, rank: 33, teuMillions: 2.6 },
  { name: "Felixstowe", country: "United Kingdom", lat: 51.95, lon: 1.31, rank: 34, teuMillions: 3.5 },
  { name: "Le Havre", country: "France", lat: 49.47, lon: 0.11, rank: 35, teuMillions: 2.9 },
  { name: "Gdansk", country: "Poland", lat: 54.4, lon: 18.68, rank: 36, teuMillions: 2.1 },
  { name: "Novorossiysk", country: "Russia", lat: 44.72, lon: 37.78, rank: 37, teuMillions: 0.8 },
  { name: "Alexandria", country: "Egypt", lat: 31.19, lon: 29.87, rank: 38, teuMillions: 1.7 },
  { name: "Lagos (Apapa)", country: "Nigeria", lat: 6.44, lon: 3.37, rank: 39, teuMillions: 1.2 },
  { name: "Callao", country: "Peru", lat: -12.05, lon: -77.14, rank: 40, teuMillions: 2.6 },
];

export interface Chokepoint {
  name: string;
  lat: number;
  lon: number;
  /** Published daily oil transit, million barrels per day (EIA). */
  oilTransitMbd: number | null;
  note: string;
}

/**
 * The passages world trade cannot route around.
 *
 * Oil transit volumes are the US Energy Information Administration's published
 * figures. Where a chokepoint matters for reasons other than oil — Taiwan,
 * the Danish Straits — that is said in words rather than forced into a number.
 */
export const CHOKEPOINTS: Chokepoint[] = [
  { name: "Strait of Hormuz", lat: 26.57, lon: 56.25, oilTransitMbd: 20.9, note: "The single largest oil transit chokepoint." },
  { name: "Strait of Malacca", lat: 2.5, lon: 101.5, oilTransitMbd: 23.7, note: "Principal route between the Indian and Pacific oceans." },
  { name: "Suez Canal", lat: 30.02, lon: 32.56, oilTransitMbd: 5.5, note: "Links the Mediterranean to the Red Sea." },
  { name: "Bab el-Mandeb", lat: 12.58, lon: 43.33, oilTransitMbd: 6.2, note: "Southern gate of the Red Sea." },
  { name: "Panama Canal", lat: 9.08, lon: -79.68, oilTransitMbd: 0.9, note: "Draught limited by Gatun Lake levels." },
  { name: "Strait of Gibraltar", lat: 35.95, lon: -5.6, oilTransitMbd: null, note: "Sole Atlantic entrance to the Mediterranean." },
  { name: "Turkish Straits", lat: 41.12, lon: 29.07, oilTransitMbd: 3.2, note: "Bosphorus and Dardanelles; Black Sea access." },
  { name: "Danish Straits", lat: 55.75, lon: 11.0, oilTransitMbd: 3.2, note: "Russian Baltic exports pass here." },
  { name: "Cape of Good Hope", lat: -34.36, lon: 18.47, oilTransitMbd: 5.8, note: "The route used when Suez is avoided." },
  { name: "Taiwan Strait", lat: 24.5, lon: 119.5, oilTransitMbd: null, note: "Roughly a fifth of global container traffic transits here." },
];

export interface NewsFeed {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  url: string;
  language: string;
  category: "mainstream" | "regional" | "business" | "state";
}

/**
 * Continuous news broadcasts, placed at the newsroom that produces them.
 *
 * No public API lists these, so this is a curated set rather than a feed —
 * which is the honest answer, and the reference implementation's equivalent is
 * the same. Each entry links to the broadcaster's own live page.
 */
export const NEWS_FEEDS: NewsFeed[] = [
  { id: "aljazeera-en", name: "Al Jazeera English", city: "Doha", country: "Qatar", lat: 25.32, lon: 51.53, url: "https://www.aljazeera.com/live/", language: "en", category: "mainstream" },
  { id: "france24-en", name: "France 24 English", city: "Paris", country: "France", lat: 48.83, lon: 2.24, url: "https://www.france24.com/en/live", language: "en", category: "mainstream" },
  { id: "dw-news", name: "DW News", city: "Berlin", country: "Germany", lat: 52.51, lon: 13.35, url: "https://www.dw.com/en/live-tv/channel-english", language: "en", category: "mainstream" },
  { id: "euronews", name: "Euronews", city: "Lyon", country: "France", lat: 45.76, lon: 4.83, url: "https://www.euronews.com/live", language: "en", category: "mainstream" },
  { id: "sky-news", name: "Sky News", city: "London", country: "United Kingdom", lat: 51.49, lon: -0.31, url: "https://news.sky.com/watch-live", language: "en", category: "mainstream" },
  { id: "nbc-news", name: "NBC News NOW", city: "New York", country: "United States", lat: 40.759, lon: -73.98, url: "https://www.nbcnews.com/now", language: "en", category: "mainstream" },
  { id: "cbs-news", name: "CBS News 24/7", city: "New York", country: "United States", lat: 40.764, lon: -73.973, url: "https://www.cbsnews.com/live/", language: "en", category: "mainstream" },
  { id: "abc-news-au", name: "ABC News Australia", city: "Sydney", country: "Australia", lat: -33.87, lon: 151.2, url: "https://www.abc.net.au/news/newschannel", language: "en", category: "mainstream" },
  { id: "cbc-news", name: "CBC News", city: "Toronto", country: "Canada", lat: 43.64, lon: -79.39, url: "https://www.cbc.ca/player/news/TV%20Shows/CBC%20News%20Network", language: "en", category: "mainstream" },
  { id: "cna", name: "CNA", city: "Singapore", country: "Singapore", lat: 1.33, lon: 103.85, url: "https://www.channelnewsasia.com/watch", language: "en", category: "regional" },
  { id: "arirang", name: "Arirang TV", city: "Seoul", country: "South Korea", lat: 37.55, lon: 126.99, url: "https://www.arirang.com/player/live", language: "en", category: "state" },
  { id: "africanews", name: "Africanews", city: "Pointe-Noire", country: "Republic of the Congo", lat: -4.78, lon: 11.86, url: "https://www.africanews.com/live/", language: "en", category: "regional" },
  { id: "ndtv", name: "NDTV 24x7", city: "New Delhi", country: "India", lat: 28.61, lon: 77.21, url: "https://www.ndtv.com/livetv-ndtv24x7", language: "en", category: "regional" },
  { id: "trt-world", name: "TRT World", city: "Istanbul", country: "Turkey", lat: 41.01, lon: 28.98, url: "https://www.trtworld.com/live", language: "en", category: "state" },
  { id: "bloomberg-tv", name: "Bloomberg TV", city: "New York", country: "United States", lat: 40.759, lon: -73.97, url: "https://www.bloomberg.com/live", language: "en", category: "business" },
  { id: "cspan", name: "C-SPAN", city: "Washington", country: "United States", lat: 38.9, lon: -77.03, url: "https://www.c-span.org/networks/", language: "en", category: "state" },
  { id: "kyiv-independent", name: "Kyiv Independent", city: "Kyiv", country: "Ukraine", lat: 50.45, lon: 30.52, url: "https://kyivindependent.com/", language: "en", category: "regional" },
  { id: "lbci", name: "LBCI Lebanon", city: "Beirut", country: "Lebanon", lat: 33.89, lon: 35.5, url: "https://www.lbcgroup.tv/live", language: "ar", category: "regional" },
];
