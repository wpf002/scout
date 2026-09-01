import { cached } from "../cache.js";
import { aircraftIn } from "./aircraft.js";
import { maritime } from "./maritime.js";
import { point, type Feature, type FeatureCollection } from "../types.js";

/**
 * The cross-domain entity overlay.
 *
 * One layer that answers "what is moving, and in which domain" — air, sea and
 * naval on the same symbology — rather than four layers an operator has to
 * read together. It is deliberately thinned: this is a picture of activity,
 * not a tracking layer, and the tracking layers already exist beside it.
 *
 * It carries no new upstream. Every entity here is already on the map through
 * Aviation or Maritime, so this costs nothing but the sampling — which is why
 * the reference implementation builds it in the browser from data it has
 * already fetched, and why this one is a view over the same feeds rather than
 * a fifth provider.
 */

/** Entities per domain. Enough to read as a pattern, few enough to stay legible. */
const PER_DOMAIN = 60;

export type Domain = "AIR" | "SEA" | "NAVAL";

const DOMAIN_COLOUR: Record<Domain, string> = {
  AIR: "#5ac8fa",
  SEA: "#30d0c0",
  NAVAL: "#ff3b52",
};

/** Evenly sampled, never truncated — a truncated set is one region. */
function sample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const step = Math.ceil(items.length / limit);
  return items.filter((_, index) => index % step === 0).slice(0, limit);
}

function relabel(feature: Feature, domain: Domain, source: string): Feature | null {
  if (feature.geometry.type !== "Point") return null;
  const [lon, lat] = feature.geometry.coordinates;
  const p = feature.properties;

  return point(lon, lat, {
    layer: `sdk_${domain.toLowerCase()}`,
    domain,
    id: `${domain}-${String(p["id"] ?? `${lon},${lat}`)}`,
    label: String(p["label"] ?? "Track"),
    heading: p["heading"] ?? 0,
    source,
    colour: DOMAIN_COLOUR[domain],
  });
}

async function entities(): Promise<Record<Domain, Feature[]>> {
  const [commercial, priv, jets, mil, sea] = await Promise.allSettled([
    aircraftIn("commercial")(),
    aircraftIn("private")(),
    aircraftIn("jet")(),
    aircraftIn("military")(),
    maritime(),
  ]);

  const settled = (r: PromiseSettledResult<FeatureCollection>) =>
    r.status === "fulfilled" ? r.value.features : [];

  const air = [...settled(commercial), ...settled(priv), ...settled(jets)];
  const vessels = settled(sea).filter((f) => f.properties["role"] === "vessel");

  /*
   * Naval is military aviation plus any vessel AIS calls a military craft.
   * AIS ship type 35 is the published code for one, so this is what the
   * transponder says rather than an inference from a name.
   */
  const navalVessels = vessels.filter(
    (f) => f.properties["shipType"] === "Military",
  );

  return {
    AIR: sample(air, PER_DOMAIN).flatMap((f) => {
      const relabelled = relabel(f, "AIR", "ADS-B via OpenSky and adsb.fi");
      return relabelled === null ? [] : [relabelled];
    }),
    SEA: sample(vessels, PER_DOMAIN).flatMap((f) => {
      const relabelled = relabel(f, "SEA", "AIS via national authorities");
      return relabelled === null ? [] : [relabelled];
    }),
    NAVAL: sample(
      [...settled(mil), ...navalVessels],
      PER_DOMAIN,
    ).flatMap((f) => {
      const relabelled = relabel(f, "NAVAL", "ADS-B military flag and AIS ship type");
      return relabelled === null ? [] : [relabelled];
    }),
  };
}

const TTL_MS = 30_000;

export function sdkDomain(domain: Domain) {
  return async (): Promise<FeatureCollection> => {
    const all = await cached("sdk:entities", TTL_MS, entities);
    return {
      type: "FeatureCollection",
      features: all[domain],
      meta: {
        domain,
        note: "A sampled cross-domain view of tracks already carried by the Aviation and Maritime layers. Not a separate feed.",
      },
    };
  };
}
