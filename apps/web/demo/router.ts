/**
 * A hash router, which is all this needs.
 *
 * The demo is a single file opened from disk or from a static host, so there is
 * no server to answer a real path. Hash routing keeps deep links working in
 * both cases and survives a reload.
 */
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.length > 0 ? hash : "/";
}

export function navigate(path: string): void {
  window.location.hash = path;
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    for (const listener of listeners) listener();
  });
}

export function usePath(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentPath,
    () => "/",
  );
}

/** The case id in `/cases/:id`, or an empty string elsewhere. */
export function caseIdFromPath(path: string): string {
  return /^\/cases\/([^/]+)$/.exec(path)?.[1] ?? "";
}
