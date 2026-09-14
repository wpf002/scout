# Sources

Every v2 collector declares its licence in code (`defineCollector()` refuses
one that does not). This table is the human-readable copy and must match.

## v2 collectors

| Collector | Class | Licence / ToS | Cadence | Resolution | Cost | Status |
|---|---|---|---|---|---|---|
| `adsb-live` — OpenSky Network, adsb.lol, adsb.fi | SENSOR | OpenSky terms; free tier is non-commercial. adsb.lol/adsb.fi ODbL with attribution. | 20 s | position, ~1 s | Free tier; 400 OpenSky credits/day | **Built.** Wraps the live map's assembly. |
| `ais-live` — Kystverket (Norway), Digitraffic (Finland), AISStream.io | SENSOR | National feeds under NLOD / CC BY 4.0 with attribution on every row. AISStream.io under its ToS when `AISSTREAM_API_KEY` is set; keyless runs cover the national feeds only. | 60 s | position, per message | Free | **Built.** Wraps the live map's maritime assembly; a keyed run also listens to the global stream for a bounded window. |
| `sentinel-2` — Sentinel-2 L2A via Sentinel Hub | SATELLITE | Copernicus Sentinel data, free and open (attribution: contains modified Copernicus Sentinel data). Sentinel Hub ToS and free-tier processing units. Inert without `SENTINELHUB_CLIENT_ID`/`_SECRET`. | ~5 days revisit | 10 m, true colour | Free tier | **Built.** Catalogue search, then one GeoTIFF and one PNG per scene over the box, stored once in the tiles bucket and indexed in `ImageryTile`. |
| `sec-edgar` — SEC EDGAR company registry | PUBLIC_RECORD | US government work, public domain. SEC fair-access policy: declared User-Agent with contact (`SEC_EDGAR_USER_AGENT`), ≤10 req/s. Inert without it. | daily | n/a | none | **Built.** Jurisdiction: US federal. Further jurisdictions are new adapters, each with its own terms row. |
| `open-web` — one page under a subject domain | OPEN_WEB | robots.txt obeyed (a closed page is not fetched and the run says why); Scout's declared user agent; no login, cookies or bypass. Content is the publisher's; Scout keeps what the page states about itself. | on demand | n/a | none | **Built.** Title, description, published contact details as identifiers, the URL as provenance. |
| Licensed broker | BROKER | `defineBrokerAdapter()` refuses an adapter without a contract reference and a credentials variable; no vendor is shipped or hardcoded. | per contract | n/a | paid | **Interface built.** Nothing registered. |
| `first-party-telemetry` | FIRST_PARTY | Customer-owned device data ingested through `/v2/collect` under a named consent record (`consentRef`, required; the reference is stored, never the document). | streaming | per device | none | **Built.** Every point is an observation with `DEVICE_ID`; refused without a consent reference. |

Imagery is stored in the tiles bucket (`S3_BUCKET_TILES`) as the GeoTIFF the
provider returned plus a PNG preview, and indexed in `ImageryTile` with a
PostGIS polygon. A scene over a box is requested once: the index is checked,
then the bucket, then the provider. Before storing, the GeoTIFF is converted to a Cloud Optimized one when a
converter is on PATH (`gdal_translate -of COG`, or `rio cogeo create`;
`IMAGERY_COG_COMMAND` forces one); `cloudOptimized` on the row is set from
the stored file's layout marker, and when no converter is installed the
plain GeoTIFF is stored and the flag stays false. The console draws the
previews under the observations and serves them from the bucket, not the
provider.

## v1 sources and live layers

The 19 case-tier sources and 30 live map layers keep their existing terms.
Several are non-commercial or attribution-bound (TeleGeography cables CC
BY-NC-SA; OpenSky free tier; abuse.ch redistribution limits; adsb.lol ODbL).
None of that changes in v2. It matters the day Scout is sold, not before.
