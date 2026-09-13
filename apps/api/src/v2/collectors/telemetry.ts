import { z } from "zod";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";

/**
 * First-party telemetry: positions from a customer's own devices.
 *
 * The ingest is the collect route with this collector, so every gate the
 * other sources pass applies here too: the authorization must permit the
 * FIRST_PARTY class, the run is audited, each point is an observation with
 * provenance and is deduplicated by content. What is specific to this
 * source is consent: a run names the consent record it operates under, and
 * a run without one is a 400, not a row.
 */

const pointSchema = z.object({
  at: z.coerce.date(),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  speedKn: z.number().nonnegative().optional(),
  headingDeg: z.number().min(0).max(360).optional(),
  altitudeM: z.number().optional(),
  note: z.string().trim().max(500).optional(),
});

export const telemetryParamsSchema = z.object({
  /** The consent or contract record the fleet is enrolled under. Required. */
  consentRef: z.string().trim().min(1).max(200),
  deviceId: z.string().trim().min(1).max(200),
  /** A label for the device or its operator, if the customer wants one on the row. */
  label: z.string().trim().max(200).optional(),
  points: z.array(pointSchema).min(1).max(5_000),
});
export type TelemetryParams = z.infer<typeof telemetryParamsSchema>;

export function normalizeTelemetry(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const batch = telemetryParamsSchema.parse(raw);
  return batch.points.map((p) => ({
    sourceId: telemetryCollector.id,
    authorizationId: meta.authorizationId,
    collectedAt: meta.collectedAt,
    observedAt: p.at,
    rawPayload: p,
    normalizedPayload: {
      deviceId: batch.deviceId,
      consentRef: batch.consentRef,
      label: batch.label ?? null,
      speedKn: p.speedKn ?? null,
      headingDeg: p.headingDeg ?? null,
      altitudeM: p.altitudeM ?? null,
      note: p.note ?? null,
      at: p.at.toISOString(),
    },
    position: { lon: p.lon, lat: p.lat },
    confidenceBp: null,
    indeterminate: false,
    entityKind: "DEVICE" as const,
    ...(meta.caseId === undefined ? {} : { caseId: meta.caseId }),
    identifiers: [
      { kind: "DEVICE_ID" as const, value: batch.deviceId },
      ...(batch.label === undefined ? [] : [{ kind: "NAME" as const, value: batch.label }]),
    ],
  }));
}

const base = defineCollector(
  {
    id: "first-party-telemetry",
    name: "First-party telemetry",
    sourceClass: "FIRST_PARTY",
    licensingTerms:
      "Customer-owned data from devices and systems the customer operates, ingested under a named consent or contract record (`consentRef`) that the customer holds. " +
      "Scout stores the reference, never the consent document, and refuses a batch that does not name one.",
    rateLimit: { perMinute: 600 },
    refreshCadenceSeconds: 1,
    spatialResolutionMeters: 5,
    temporalLagSeconds: 0,
  },
  normalizeTelemetry,
);

export const telemetryCollector = {
  ...base,
  entityKind: "DEVICE" as const,
  subjectRequired: false,
  paramsSchema: telemetryParamsSchema,
  // No network: the batch is the payload. `fetch` hands it to `normalize`.
  async fetch(input: { params?: Record<string, unknown> | undefined }) {
    return telemetryParamsSchema.parse(input.params ?? {});
  },
};
