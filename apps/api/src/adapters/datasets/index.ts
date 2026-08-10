import type {
  DatasetObservation,
  Source,
  Subject,
} from "@scout/sources";
import { fetchIntelx, intelxSource } from "./intelx.js";
import {
  fetchOpenSanctions,
  openSanctionsSource,
} from "./opensanctions.js";

export interface DatasetAdapter {
  source: Source;
  run: (subject: Subject) => Promise<DatasetObservation[]>;
}

/**
 * Built dataset adapters.
 *
 * Unlike the infra set, these are NOT uniformly non-scoped: Intelligence X is
 * gated for email selectors. That is why there is no dataset sweep — a batch
 * path here would have to reason about per-subject-kind gating, and the
 * cheapest way to get that wrong is to build it before it is needed. Dataset
 * sources run one at a time, through `executeSource`, which picks the right
 * runner from the effective gate.
 */
export const DATASET_ADAPTERS: readonly DatasetAdapter[] = Object.freeze([
  { source: intelxSource, run: fetchIntelx },
  { source: openSanctionsSource, run: fetchOpenSanctions },
]);

const BY_ID = new Map(DATASET_ADAPTERS.map((a) => [a.source.id, a]));

export function getDatasetAdapter(id: string): DatasetAdapter | undefined {
  return BY_ID.get(id);
}
