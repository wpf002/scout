import type { Source, Subject } from "@scout/sources";
import { requiresScopeFor } from "@scout/sources";
import { fetchHibp, hibpSource } from "../hibp.js";
import { dehashedSource, fetchDehashed } from "./dehashed.js";
import { fetchHunter, hunterSource } from "./hunter.js";
import { fetchWhatsMyName, whatsMyNameSource } from "./whatsmyname.js";
import {
  fetchMaigret,
  fetchSherlock,
  maigretSource,
  sherlockSource,
} from "../cli/sherlock.js";

export interface ScopedAdapter {
  source: Source;
  run: (subject: Subject) => Promise<unknown[]>;
}

/**
 * Every person-facing adapter, behind one registry and one route.
 *
 * The uniformity is the safety property. In Phase 0 HIBP had a bespoke route;
 * three more bespoke routes would have been three more places for the gate to
 * be applied slightly differently, and the one that drifts is the one that
 * leaks. Now there is a single handler, and it cannot run anything that is not
 * on this list.
 *
 * Every member is asserted `requiresScope` by invariants.test.ts, and each
 * runs through `executeScopedSource`, which enforces the gate and writes the
 * audit row before the upstream call is reachable.
 */
export const SCOPED_ADAPTERS: readonly ScopedAdapter[] = Object.freeze([
  { source: hibpSource, run: fetchHibp },
  { source: dehashedSource, run: fetchDehashed },
  { source: hunterSource, run: fetchHunter },
  { source: whatsMyNameSource, run: fetchWhatsMyName },
  { source: sherlockSource, run: fetchSherlock },
  { source: maigretSource, run: fetchMaigret },
]);

const BY_ID = new Map(SCOPED_ADAPTERS.map((a) => [a.source.id, a]));

export function getScopedAdapter(id: string): ScopedAdapter | undefined {
  return BY_ID.get(id);
}

/**
 * Route path for a scoped source, grouped by tier so the URL says what kind of
 * lookup it is.
 */
export function scopedRoutePath(source: Source): string {
  return `/${source.tier}/${source.id}`;
}

/** True when this adapter is gated for the given subject kind. */
export function scopedFor(source: Source, subject: Subject): boolean {
  return requiresScopeFor(source, subject.kind);
}
