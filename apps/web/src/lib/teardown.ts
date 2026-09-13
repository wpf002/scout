/**
 * What to take off the map when the switches change.
 *
 * Separated from the map code because it is the part that can be wrong
 * silently. Removing too much clears a layer the operator still has switched
 * on; removing too little leaves stale marks behind that look live. Neither
 * throws, and neither is visible in a log.
 */

/**
 * The style ids one feed layer occupies.
 *
 * A feed is not one style layer. Clustered feeds add a bubble layer and a count
 * label, and tracks add an endpoint layer, all sharing a single source. Missing
 * one of them leaves an orphan that MapLibre then refuses to remove the source
 * under, because a layer still references it.
 */
export function styleIdsFor(layerId: string): string[] {
  return [
    layerId,
    `${layerId}-endpoints`,
    `${layerId}-cluster`,
    `${layerId}-count`,
  ];
}

/**
 * Which drawn layers are no longer switched on.
 *
 * Reads what was actually drawn rather than the whole catalogue. Sweeping the
 * catalogue produced the same visible result but called `removeSource` on every
 * layer that happened to be off — and MapLibre tears a source down
 * synchronously, so with a heavy feed on the map that landed between clicking a
 * switch and the switch moving.
 */
export function toRemove(drawn: Iterable<string>, active: string[]): string[] {
  const keep = new Set(active);
  const gone: string[] = [];
  for (const layerId of drawn) {
    if (!keep.has(layerId)) gone.push(layerId);
  }
  return gone;
}
