/**
 * Curated world cameras — public live city views, mostly YouTube Live.
 *
 * These are hand-picked public live streams (landmarks, crossings, harbours),
 * not agency traffic feeds. `yt` is a YouTube video id, embedded through
 * YouTube's own iframe player; `iframe` is a full embeddable player URL for the
 * few that are not on YouTube. A still preview is derived from the YouTube
 * thumbnail so the map has something to draw without a player.
 */

export interface WorldCam {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  /** YouTube video id, or... */
  yt?: string;
  /** ...a full embeddable player URL for non-YouTube sources. */
  iframe?: string;
  operator: string;
}

export const WORLD_CAMS: WorldCam[] = [
  { id: "il-israel-multicam", name: "Israel Multi-Cam (Live)", city: "Tel Aviv", country: "Israel", lat: 32.0853, lon: 34.7818, yt: "gmtlJ_m2r5A", operator: "YouTube Live" },
  { id: "il-jerusalem-live", name: "Jerusalem Western Wall", city: "Jerusalem", country: "Israel", lat: 31.7767, lon: 35.2345, yt: "77akujLn4k8", operator: "YouTube Live" },
  { id: "lb-beirut-skyline", name: "Beirut Skyline Live", city: "Beirut", country: "Lebanon", lat: 33.8938, lon: 35.5018, yt: "qJf4NqPKLjI", operator: "YouTube Live" },
  { id: "lb-me-multicam", name: "Middle East Multi-Cam (Live)", city: "Regional", country: "Middle East", lat: 33.2721, lon: 35.2033, yt: "oxT5R6I0N6E", operator: "YouTube Live" },
  { id: "gr-aodos-cam128", name: "I/C D. Plakentias", city: "Athens", country: "Greece", lat: 38.0208, lon: 23.8578, iframe: "https://ipcamlive.com/player/player.php?alias=cam128&autoplay=1", operator: "Attiki Odos" },
  { id: "gr-aodos-cam231", name: "I/C Papagou", city: "Athens", country: "Greece", lat: 37.9906, lon: 23.7947, iframe: "https://ipcamlive.com/player/player.php?alias=cam231&autoplay=1", operator: "Attiki Odos" },
  { id: "cz-prague-1", name: "Prague — Old Town Square", city: "Prague", country: "Czechia", lat: 50.0878, lon: 14.4205, yt: "IFnbDmgP69Q", operator: "YouTube Live" },
  { id: "cz-prague-2", name: "Prague — Charles Bridge", city: "Prague", country: "Czechia", lat: 50.0865, lon: 14.4114, yt: "tmlE1ct0cYk", operator: "YouTube Live" },
  { id: "cz-prague-3", name: "Prague — City View", city: "Prague", country: "Czechia", lat: 50.09, lon: 14.4, yt: "sspBOJIrNzU", operator: "YouTube Live" },
  { id: "sk-bratislava-1", name: "Bratislava — Old Town", city: "Bratislava", country: "Slovakia", lat: 48.1486, lon: 17.1077, yt: "kYDIwCLGKL0", operator: "YouTube Live" },
  { id: "sk-bratislava-3", name: "Bratislava — Danube River", city: "Bratislava", country: "Slovakia", lat: 48.145, lon: 17.1, yt: "xFdvZ4eGzPg", operator: "YouTube Live" },
  { id: "de-berlin-1", name: "Berlin — Alexanderplatz", city: "Berlin", country: "Germany", lat: 52.52, lon: 13.405, yt: "IRqboacDNFg", operator: "YouTube Live" },
  { id: "de-munich-1", name: "Munich — Marienplatz", city: "Munich", country: "Germany", lat: 48.1351, lon: 11.582, yt: "KxWuwC7R5kY", operator: "YouTube Live" },
  { id: "fr-paris-1", name: "Paris — Eiffel Tower Area", city: "Paris", country: "France", lat: 48.8584, lon: 2.2945, yt: "UMuEooW0iAQ", operator: "YouTube Live" },
  { id: "fr-paris-2", name: "Paris — Louvre Area", city: "Paris", country: "France", lat: 48.86, lon: 2.33, yt: "OzYp4NRZlwQ", operator: "YouTube Live" },
  { id: "fr-nice-1", name: "Nice — Promenade des Anglais", city: "Nice", country: "France", lat: 43.6961, lon: 7.2717, yt: "YAdNYoRY0Cw", operator: "YouTube Live" },
  { id: "fr-nice-2", name: "Nice — City View", city: "Nice", country: "France", lat: 43.7, lon: 7.26, yt: "asO_10T0k2k", operator: "YouTube Live" },
  { id: "pl-gdansk-1", name: "Gdansk — City View", city: "Gdansk", country: "Poland", lat: 54.352, lon: 18.6466, yt: "NZ_ZiHAx8Ic", operator: "YouTube Live" },
  { id: "jp-shibuya-crossing", name: "Shibuya Scramble Crossing", city: "Tokyo", country: "Japan", lat: 35.6595, lon: 139.7005, yt: "coYw-eVU0Ks", operator: "ANN News / YouTube" },
  { id: "jp-tokyo-tower", name: "Tokyo Tower Live Cam", city: "Tokyo", country: "Japan", lat: 35.6586, lon: 139.7454, yt: "cbJ03Xk_eLQ", operator: "YouTube" },
  { id: "jp-mt-fuji", name: "Mt. Fuji Live", city: "Shizuoka/Yamanashi", country: "Japan", lat: 35.3606, lon: 138.7274, yt: "5aLh8R2HqOQ", operator: "YouTube" },
  { id: "jp-osaka-dotonbori", name: "Dotonbori Live Cam", city: "Osaka", country: "Japan", lat: 34.6687, lon: 135.5013, yt: "m6J9w94oBXY", operator: "YouTube" },
  { id: "jp-shinjuku-kabukicho", name: "Shinjuku Kabukicho Live", city: "Tokyo", country: "Japan", lat: 35.6938, lon: 139.7034, yt: "gFRtAAmiFbE", operator: "YouTube" },
  { id: "jp-akihabara", name: "Akihabara Electric Town", city: "Tokyo", country: "Japan", lat: 35.6984, lon: 139.7731, yt: "HULqEi0RqXI", operator: "YouTube" },
  { id: "jp-tokyo-skytree", name: "Tokyo Skytree Live", city: "Tokyo", country: "Japan", lat: 35.7101, lon: 139.8107, yt: "xIp5F2D8vQ0", operator: "YouTube" },
  { id: "jp-ginza", name: "Ginza 4-Chome Crossing", city: "Tokyo", country: "Japan", lat: 35.6717, lon: 139.7649, yt: "LYzCVlG6lkE", operator: "YouTube" },
  { id: "jp-yokohama-port", name: "Yokohama Port Live", city: "Yokohama", country: "Japan", lat: 35.4437, lon: 139.638, yt: "dN4HRiQnAn4", operator: "YouTube" },
  { id: "jp-kyoto-arashiyama", name: "Kyoto Arashiyama Bamboo Forest", city: "Kyoto", country: "Japan", lat: 34.9949, lon: 135.785, yt: "Op-lf2NRMzs", operator: "YouTube" },
  { id: "jp-hiroshima-dome", name: "Hiroshima Peace Memorial", city: "Hiroshima", country: "Japan", lat: 34.3955, lon: 132.4536, yt: "R6-G_4W5K_M", operator: "YouTube" },
  { id: "jp-sapporo-odori", name: "Sapporo Odori Park", city: "Sapporo", country: "Japan", lat: 43.0588, lon: 141.3563, yt: "N7k3Q5rMZfM", operator: "YouTube" },
  { id: "jp-naha-kokusai", name: "Naha Kokusai Street", city: "Naha/Okinawa", country: "Japan", lat: 26.3358, lon: 127.6809, yt: "cKTkCqVB00A", operator: "YouTube" },
  { id: "jp-fukuoka-hakata", name: "Fukuoka Hakata Station", city: "Fukuoka", country: "Japan", lat: 33.5898, lon: 130.4017, yt: "xvN_GxkVjKs", operator: "YouTube" },
  { id: "jp-nagoya-station", name: "Nagoya Station Area", city: "Nagoya", country: "Japan", lat: 35.1709, lon: 136.8815, yt: "Oji-G0UhD9U", operator: "YouTube" },
  { id: "jp-kobe-harbor", name: "Kobe Harborland", city: "Kobe", country: "Japan", lat: 34.6851, lon: 135.1956, yt: "3xGw0xQBN0s", operator: "YouTube" },
  { id: "jp-asakusa-sensoji", name: "Asakusa Senso-ji Temple", city: "Tokyo", country: "Japan", lat: 35.7148, lon: 139.7967, yt: "Ic5FaEzh6h0", operator: "YouTube" },
  { id: "jp-tokyo-bay", name: "Tokyo Bay Waterfront", city: "Tokyo", country: "Japan", lat: 35.6279, lon: 139.7742, yt: "Y9X1W8HBE4g", operator: "YouTube" },
  { id: "tw-taipei-101", name: "Taipei 101 Live", city: "Taipei", country: "Taiwan", lat: 25.033, lon: 121.5654, yt: "rL5YKnxBudA", operator: "YouTube" },
  { id: "tw-taipei-ximending", name: "Ximending Walking District", city: "Taipei", country: "Taiwan", lat: 25.0422, lon: 121.5079, yt: "W3A3gCqj7bY", operator: "YouTube" },
  { id: "tw-kaohsiung-harbor", name: "Kaohsiung Harbor Live", city: "Kaohsiung", country: "Taiwan", lat: 22.6142, lon: 120.2843, yt: "PdX18mxuYRE", operator: "YouTube" },
  { id: "tw-keelung-harbor", name: "Keelung Harbor", city: "Keelung", country: "Taiwan", lat: 25.1291, lon: 121.7423, yt: "SX90gCtF3bY", operator: "YouTube" },
  { id: "th-bangkok-sukhumvit-soi-11", name: "Sukhumvit Soi 11 — Bangkok", city: "Bangkok", country: "Thailand", lat: 13.7437, lon: 100.5556, yt: "UemFRPrl1hk", operator: "The Real Samui Webcam" },
  { id: "th-bangkok-sukhumvit-soi-19", name: "Sukhumvit Soi 19 — Bangkok", city: "Bangkok", country: "Thailand", lat: 13.7396, lon: 100.5601, yt: "Q71sLS8h9a4", operator: "The Real Samui Webcam" },
  { id: "th-samui-chaweng-green-mango", name: "Chaweng — Soi Green Mango", city: "Ko Samui", country: "Thailand", lat: 9.5071545, lon: 99.9957562, yt: "DwKCna1mumk", operator: "The Real Samui Webcam" },
  { id: "th-samui-chaweng-munchies", name: "Chaweng — Soi Green Mango (Munchies)", city: "Ko Samui", country: "Thailand", lat: 9.5071545, lon: 99.9957562, yt: "yFgVmioYkys", operator: "The Real Samui Webcam" },
  { id: "th-samui-lamai-crystal-bay", name: "Lamai — Crystal Bay Beach", city: "Ko Samui", country: "Thailand", lat: 9.4700032, lon: 100.0459763, yt: "Fw9hgttWzIg", operator: "The Real Samui Webcam" },
  { id: "th-phangan-srithanu", name: "Koh Phangan — Srithanu Beach", city: "Ko Phangan", country: "Thailand", lat: 9.7333, lon: 99.9833, yt: "MW3fisTCXRQ", operator: "The Real Samui Webcam" },
];
