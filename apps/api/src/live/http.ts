/**
 * The one place Scout talks to a public feed.
 *
 * Every upstream gets the same treatment: a real user agent, a timeout, and a
 * failure that names the URL. Several of these providers ask callers to
 * identify themselves, and one of them refuses the request outright without
 * gzip — so headers are per-call rather than assumed.
 */

const TIMEOUT_MS = 25_000;

export const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

export class UpstreamError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${new URL(url).hostname} responded ${status}`);
  }
}

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Some upstreams answer 4xx with a body worth reading. */
  allowStatus?: number[];
  /** Overpass takes its query as a POST body; everything else is a GET. */
  method?: "GET" | "POST";
  body?: string;
}

export async function getText(
  url: string,
  options: FetchOptions = {},
): Promise<string> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : { body: options.body }),
    headers: { "user-agent": UA, ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    redirect: "follow",
  });

  const body = await response.text();
  if (!response.ok && !(options.allowStatus ?? []).includes(response.status)) {
    throw new UpstreamError(url, response.status, body.slice(0, 400));
  }
  return body;
}

export async function getJson<T = unknown>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const body = await getText(url, {
    ...options,
    headers: { accept: "application/json", ...options.headers },
  });

  try {
    return JSON.parse(body) as T;
  } catch {
    // An HTML error page parsed as JSON is the failure that reads as a dead
    // feed rather than a wrong URL, so it is named as what it is.
    throw new Error(
      `${new URL(url).hostname} returned ${body.trimStart().startsWith("<") ? "HTML" : "unparseable data"} where JSON was expected`,
    );
  }
}

/**
 * Fetch several things and keep whatever answers.
 *
 * Used by every layer that is a union of regional sources. One agency's API
 * being down should thin the layer, not empty it — an operator reading a blank
 * map cannot tell "nothing there" from "the fetch failed". If they all fail,
 * the first error is raised so the layer can say why.
 */
export async function merge<T>(
  loaders: Array<() => Promise<T[]>>,
): Promise<{ items: T[]; failures: number }> {
  const settled = await Promise.allSettled(loaders.map((load) => load()));
  const items = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failures = settled.filter((r) => r.status === "rejected").length;

  if (items.length === 0 && failures > 0) {
    const first = settled.find((r) => r.status === "rejected");
    if (first !== undefined && first.status === "rejected") {
      throw first.reason instanceof Error
        ? first.reason
        : new Error(String(first.reason));
    }
  }
  return { items, failures };
}
