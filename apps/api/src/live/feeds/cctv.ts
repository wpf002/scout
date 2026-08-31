import { z } from "zod";
import { getJson } from "../http.js";
import { merge } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * Public cameras, from the agencies that publish their positions.
 *
 * Every one of these is a transport authority or municipality putting its own
 * traffic cameras on the open internet. None of it is a private camera, and
 * none of it comes from scanning for exposed devices — that distinction is the
 * whole reason this layer is defensible.
 *
 * `stream_url` is what the agency itself serves, so the shape varies: a JPEG
 * that updates, an HLS playlist, or an embeddable page. The type is carried on
 * the feature so the viewer can pick a player rather than guess.
 */

export type StreamType = "image" | "hls" | "iframe";

interface Camera {
  id: string;
  name: string;
  lat: number;
  lon: number;
  city: string | null;
  country: string;
  streamUrl: string | null;
  streamType: StreamType;
  operator: string;
}

const toFeature = (camera: Camera): Feature =>
  point(camera.lon, camera.lat, {
    layer: "cctv",
    id: camera.id,
    label: camera.name,
    city: camera.city,
    country: camera.country,
    streamUrl: camera.streamUrl,
    streamType: camera.streamType,
    operator: camera.operator,
    colour: "#c8b0ff",
  });

// ── Caltrans ───────────────────────────────────────────────────────────────

const CALTRANS_SCHEMA = z.object({
  data: z
    .array(
      z.object({
        cctv: z
          .object({
            index: z.union([z.string(), z.number()]).optional(),
            recordTimestamp: z.unknown().optional(),
            location: z
              .object({
                district: z.string().optional(),
                locationName: z.string().optional(),
                nearbyPlace: z.string().optional(),
                latitude: z.string().optional(),
                longitude: z.string().optional(),
              })
              .partial()
              .optional(),
            imageData: z
              .object({
                streamingVideoURL: z.string().optional(),
                static: z
                  .object({ currentImageURL: z.string().optional() })
                  .partial()
                  .optional(),
              })
              .partial()
              .optional(),
          })
          .partial(),
      }),
    )
    .default([]),
});

/** Caltrans publishes one file per district; there are twelve. */
const CALTRANS_DISTRICTS = [3, 4, 5, 6, 7, 8, 10, 11, 12];

async function caltrans(): Promise<Camera[]> {
  const { items } = await merge(
    CALTRANS_DISTRICTS.map((d) => async () => {
      const padded = String(d).padStart(2, "0");
      const parsed = CALTRANS_SCHEMA.parse(
        await getJson(
          `https://cwwp2.dot.ca.gov/data/d${d}/cctv/cctvStatusD${padded}.json`,
          { timeoutMs: 30_000 },
        ),
      );

      return parsed.data.flatMap((row): Camera[] => {
        const cctv = row.cctv;
        const location = cctv.location;
        const lat = Number(location?.latitude);
        const lon = Number(location?.longitude);
        if (!usable(lon, lat)) return [];

        const hls = cctv.imageData?.streamingVideoURL;
        const still = cctv.imageData?.static?.currentImageURL;
        const url = hls ?? still ?? null;

        return [
          {
            id: `caltrans-d${d}-${cctv.index ?? `${lon},${lat}`}`,
            name: location?.locationName?.trim() || location?.nearbyPlace?.trim() || "Caltrans camera",
            lat,
            lon,
            city: location?.nearbyPlace?.trim() ?? null,
            country: "United States",
            streamUrl: url,
            streamType: hls !== undefined ? "hls" : "image",
            operator: `Caltrans District ${d}`,
          },
        ];
      });
    }),
  );
  return items;
}

// ── 511 Ontario ────────────────────────────────────────────────────────────

const ON_SCHEMA = z.array(
  z.object({
    Id: z.union([z.string(), z.number()]).optional(),
    Name: z.string().optional(),
    Description: z.string().optional(),
    Latitude: z.number().optional(),
    Longitude: z.number().optional(),
    Url: z.string().optional(),
    Views: z
      .array(
        z.object({
          Url: z.string().optional(),
          Status: z.string().optional(),
          Description: z.string().optional(),
        }),
      )
      .optional(),
  }),
);

async function ontario(): Promise<Camera[]> {
  const parsed = ON_SCHEMA.parse(
    await getJson("https://511on.ca/api/v2/get/cameras", { timeoutMs: 30_000 }),
  );

  return parsed.flatMap((row): Camera[] => {
    if (!usable(row.Longitude, row.Latitude)) return [];
    const view = row.Views?.[0];
    return [
      {
        id: `511on-${row.Id ?? `${row.Longitude},${row.Latitude}`}`,
        name: row.Name?.trim() || row.Description?.trim() || "Ontario camera",
        lat: row.Latitude as number,
        lon: row.Longitude as number,
        city: null,
        country: "Canada",
        streamUrl: view?.Url ?? row.Url ?? null,
        streamType: "image",
        operator: "511 Ontario",
      },
    ];
  });
}

// ── DriveBC ────────────────────────────────────────────────────────────────

const BC_SCHEMA = z.array(
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    caption: z.string().optional(),
    location: z
      .object({ type: z.string().optional(), coordinates: z.array(z.number()).optional() })
      .partial()
      .optional(),
    links: z
      .object({ imageDisplay: z.string().optional(), imageSource: z.string().optional() })
      .partial()
      .optional(),
    region_name: z.string().optional(),
  }),
);

async function driveBc(): Promise<Camera[]> {
  const parsed = BC_SCHEMA.parse(
    await getJson("https://www.drivebc.ca/api/webcams/", { timeoutMs: 30_000 }),
  );

  return parsed.flatMap((row): Camera[] => {
    const [lon, lat] = row.location?.coordinates ?? [];
    if (!usable(lon, lat)) return [];
    return [
      {
        id: `drivebc-${row.id ?? `${lon},${lat}`}`,
        name: row.name?.trim() || row.caption?.trim() || "DriveBC camera",
        lat: lat as number,
        lon,
        city: row.region_name ?? null,
        country: "Canada",
        streamUrl: row.links?.imageDisplay ?? row.links?.imageSource ?? null,
        streamType: "image",
        operator: "DriveBC",
      },
    ];
  });
}

// ── Transport for London ───────────────────────────────────────────────────

const TFL_SCHEMA = z.array(
  z.object({
    id: z.string().optional(),
    commonName: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    additionalProperties: z
      .array(z.object({ key: z.string().optional(), value: z.string().optional() }))
      .optional(),
  }),
);

async function tfl(): Promise<Camera[]> {
  const parsed = TFL_SCHEMA.parse(
    await getJson("https://api.tfl.gov.uk/Place/Type/JamCam", { timeoutMs: 40_000 }),
  );

  return parsed.flatMap((row): Camera[] => {
    if (!usable(row.lon, row.lat)) return [];
    const props = row.additionalProperties ?? [];
    const still = props.find((p) => p.key === "imageUrl")?.value;
    const video = props.find((p) => p.key === "videoUrl")?.value;
    return [
      {
        id: `tfl-${row.id ?? `${row.lon},${row.lat}`}`,
        name: row.commonName?.trim() || "TfL camera",
        lat: row.lat as number,
        lon: row.lon as number,
        city: "London",
        country: "United Kingdom",
        streamUrl: still ?? video ?? null,
        streamType: still !== undefined ? "image" : "hls",
        operator: "Transport for London",
      },
    ];
  });
}

// ── New York City ──────────────────────────────────────────────────────────

const NYC_SCHEMA = z.array(
  z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    area: z.string().optional(),
    imageUrl: z.string().optional(),
    isOnline: z.union([z.string(), z.boolean()]).optional(),
  }),
);

async function nyc(): Promise<Camera[]> {
  const parsed = NYC_SCHEMA.parse(
    await getJson("https://webcams.nyctmc.org/api/cameras", { timeoutMs: 30_000 }),
  );

  return parsed.flatMap((row): Camera[] => {
    if (!usable(row.longitude, row.latitude)) return [];
    return [
      {
        id: `nyc-${row.id ?? `${row.longitude},${row.latitude}`}`,
        name: row.name?.trim() || "NYC DOT camera",
        lat: row.latitude as number,
        lon: row.longitude as number,
        city: row.area?.trim() ?? "New York",
        country: "United States",
        streamUrl: row.imageUrl ?? (row.id === undefined ? null : `https://webcams.nyctmc.org/api/cameras/${row.id}/image`),
        streamType: "image",
        operator: "NYC DOT",
      },
    ];
  });
}

// ── Singapore ──────────────────────────────────────────────────────────────

const SG_SCHEMA = z.object({
  items: z
    .array(
      z.object({
        cameras: z
          .array(
            z.object({
              camera_id: z.string().optional(),
              image: z.string().optional(),
              timestamp: z.string().optional(),
              location: z
                .object({ latitude: z.number().optional(), longitude: z.number().optional() })
                .partial()
                .optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

async function singapore(): Promise<Camera[]> {
  const parsed = SG_SCHEMA.parse(
    await getJson("https://api.data.gov.sg/v1/transport/traffic-images", {
      timeoutMs: 30_000,
    }),
  );

  return (parsed.items[0]?.cameras ?? []).flatMap((row): Camera[] => {
    const lat = row.location?.latitude;
    const lon = row.location?.longitude;
    if (!usable(lon, lat)) return [];
    return [
      {
        id: `sg-${row.camera_id ?? `${lon},${lat}`}`,
        name: `LTA camera ${row.camera_id ?? ""}`.trim(),
        lat: lat as number,
        lon,
        city: "Singapore",
        country: "Singapore",
        streamUrl: row.image ?? null,
        streamType: "image",
        operator: "LTA Singapore",
      },
    ];
  });
}

// ── Ottawa ─────────────────────────────────────────────────────────────────

const OTTAWA_SCHEMA = z.array(
  z.object({
    id: z.number().optional(),
    number: z.number().optional(),
    description: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    type: z.string().optional(),
  }),
);

async function ottawa(): Promise<Camera[]> {
  const parsed = OTTAWA_SCHEMA.parse(
    await getJson("https://traffic.ottawa.ca/beta/camera_list", {
      timeoutMs: 30_000,
    }),
  );

  return parsed.flatMap((row): Camera[] => {
    if (!usable(row.longitude, row.latitude)) return [];
    return [
      {
        id: `ottawa-${row.number ?? row.id ?? `${row.longitude},${row.latitude}`}`,
        name: row.description?.trim() || "Ottawa camera",
        lat: row.latitude as number,
        lon: row.longitude as number,
        city: "Ottawa",
        country: "Canada",
        streamUrl:
          row.number === undefined
            ? null
            : `https://traffic.ottawa.ca/beta/camera?id=${row.number}`,
        streamType: "image",
        operator: row.type === "MTO" ? "Ontario MTO" : "City of Ottawa",
      },
    ];
  });
}

export async function cctv(): Promise<FeatureCollection> {
  const { items, failures } = await merge<Camera>([
    caltrans,
    ontario,
    driveBc,
    tfl,
    nyc,
    ottawa,
    singapore,
  ]);

  const operators: Record<string, number> = {};
  for (const camera of items) {
    operators[camera.operator] = (operators[camera.operator] ?? 0) + 1;
  }

  return {
    type: "FeatureCollection",
    features: items.map(toFeature),
    meta: { operators, failures },
  };
}
