import type { InfraObservation, Source, Subject } from "@scout/sources";
import { crtshSource, fetchCrtsh } from "./crtsh.js";
import { fetchShodan, shodanSource } from "./shodan.js";
import { censysSource, fetchCensys } from "./censys.js";
import {
  fetchTheHarvester,
  theHarvesterSource,
} from "../cli/theharvester.js";
import { fetchUrlscan, urlscanSource } from "./urlscan.js";
import { fetchWayback, waybackSource } from "./wayback.js";
import {
  certSpotterSource,
  fetchCertSpotter,
  fetchHackerTarget,
  fetchOtx,
  fetchRapidDns,
  hackerTargetSource,
  otxSource,
  rapidDnsSource,
} from "./keyless.js";
import { fetchRdap, rdapSource } from "./rdap.js";
import {
  feodoSource,
  fetchFeodo,
  fetchGreyNoise,
  greyNoiseSource,
} from "./reputation.js";

export interface InfraAdapter {
  source: Source;
  run: (subject: Subject) => Promise<InfraObservation[]>;
}

/**
 * Every built infrastructure adapter.
 *
 * All of these are non-scoped by construction: they look at hosts,
 * certificates and DNS, not at people. `infraAdapters.test.ts` asserts none of
 * them is `requiresScope`, so a person-facing source can never end up on this
 * list — and therefore never in the batch sweep.
 */
export const INFRA_ADAPTERS: readonly InfraAdapter[] = Object.freeze([
  { source: crtshSource, run: fetchCrtsh },
  { source: shodanSource, run: fetchShodan },
  { source: censysSource, run: fetchCensys },
  { source: theHarvesterSource, run: fetchTheHarvester },
  { source: urlscanSource, run: fetchUrlscan },
  { source: waybackSource, run: fetchWayback },
  { source: rdapSource, run: fetchRdap },
  { source: certSpotterSource, run: fetchCertSpotter },
  { source: hackerTargetSource, run: fetchHackerTarget },
  { source: rapidDnsSource, run: fetchRapidDns },
  { source: otxSource, run: fetchOtx },
  { source: greyNoiseSource, run: fetchGreyNoise },
  { source: feodoSource, run: fetchFeodo },
]);

const BY_ID = new Map(INFRA_ADAPTERS.map((a) => [a.source.id, a]));

export function getInfraAdapter(id: string): InfraAdapter | undefined {
  return BY_ID.get(id);
}

/** Adapters that can meaningfully be asked about this subject kind. */
export function infraAdaptersFor(
  subject: Subject,
): readonly InfraAdapter[] {
  return INFRA_ADAPTERS.filter((adapter) =>
    adapter.source.accepts.includes(subject.kind),
  );
}
