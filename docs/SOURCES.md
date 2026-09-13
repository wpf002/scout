# Sources

Every v2 collector declares its licence in code (`defineCollector()` refuses
one that does not). This table is the human-readable copy and must match.

## v2 collectors

| Collector | Class | Licence / ToS | Cadence | Resolution | Cost | Status |
|---|---|---|---|---|---|---|
| `adsb-live` — OpenSky Network, adsb.lol, adsb.fi | SENSOR | OpenSky terms; free tier is non-commercial. adsb.lol/adsb.fi ODbL with attribution. | 20 s | position, ~1 s | Free tier; 400 OpenSky credits/day | **Built.** Wraps the live map's assembly. |
| AISStream.io (AIS) | SENSOR | AISStream ToS; free key, global. | streaming | position, per message | Free | Phase 5 |
| Sentinel-2 via Sentinel Hub | SATELLITE | ESA Copernicus open data; Sentinel Hub ToS for the API. | ~5 days revisit | 10 m multispectral | Free tier | Phase 9 |
| Planet | SATELLITE | Commercial contract. | daily | 3–5 m | Paid | Phase 9, adapter only |
| Maxar | SATELLITE | Commercial contract, tasked. | tasked | 30 cm | Paid | Phase 9, adapter only |
| `sec-edgar` — SEC EDGAR company registry | PUBLIC_RECORD | US government work, public domain. SEC fair-access policy: declared User-Agent with contact (`SEC_EDGAR_USER_AGENT`), ≤10 req/s. Inert without it. | daily | n/a | none | **Built.** Jurisdiction: US federal. Further jurisdictions are new adapters, each with its own terms row. |
| Open web | OPEN_WEB | robots.txt and site ToS respected; no auth bypass. Routes through v1's fetch path. | on demand | n/a | none | Phase 9 |
| Licensed broker | BROKER | Contract terms required at registration; no vendor hardcoded. | per contract | n/a | paid | interface only |
| First-party telemetry | FIRST_PARTY | Customer-owned, enrolled with consent record. | streaming | per device | none | Phase 5 |

Imagery is stored as Cloud Optimized GeoTIFFs in the tiles bucket with a
PostGIS tile index, and is not re-downloaded per view.

## v1 sources and live layers

The 19 case-tier sources and 30 live map layers keep their existing terms.
Several are non-commercial or attribution-bound (TeleGeography cables CC
BY-NC-SA; OpenSky free tier; abuse.ch redistribution limits; adsb.lol ODbL).
None of that changes in v2. It matters the day Scout is sold, not before.
