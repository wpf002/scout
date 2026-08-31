import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";

/**
 * Basemap tile proxy.
 *
 * The map fetches vector tiles, glyphs and sprites from a public basemap CDN.
 * Proxying them through Scout rather than letting the browser fetch them
 * directly does three things: it keeps the CDN from seeing which areas an
 * investigator is looking at, it means one origin in the CSP rather than a
 * wildcard, and it lets a future deployment swap basemaps without shipping a
 * new client bundle.
 *
 * The allowlist is the whole security boundary. An open proxy that forwards
 * any URL is a server-side request forgery hole — someone asks it for
 * `http://169.254.169.254/` and Scout fetches cloud credentials on their
 * behalf. Only these hosts, only https, no redirects followed.
 */
/**
 * The hosts this proxy will fetch from. This list is the entire security
 * boundary — everything else about the route is plumbing.
 *
 * Two kinds of entry, because two kinds of host.
 *
 * Suffixes, written with a leading dot, cover CDNs that shard. An exact host
 * list looked tighter and was wrong: the vector style's TileJSON hands back
 * `tiles-a` through `tiles-d`, which no hand-written list anticipated. Every
 * tile was refused, so the source never loaded, the style never finished,
 * `load` never fired, and the map sat black with no error anywhere. The
 * leading dot is what keeps this safe: `cartocdn.com` and `evil-cartocdn.com`
 * do not match `.cartocdn.com`, and neither does `cartocdn.com.attacker.test`.
 *
 * Exact hosts cover the ones where a suffix would be far too wide. Terrain
 * tiles come from `s3.amazonaws.com`, and allowing `.amazonaws.com` would open
 * this proxy onto every AWS service endpoint there is.
 */
const ALLOWED_SUFFIXES = [".cartocdn.com", ".arcgisonline.com"];

const ALLOWED_HOSTS = new Set([
  "basemaps.cartocdn.com",
  "cartocdn.com",
  "arcgisonline.com",
  "server.arcgisonline.com",
  // AWS's open terrain tiles, for the 3D elevation layer.
  "s3.amazonaws.com",
  "elevation-tiles-prod.s3.amazonaws.com",
]);

/** Exposed for the allowlist tests; the boundary deserves a test run. */
export const allowedHostForTest = (hostname: string): boolean =>
  allowedHost(hostname);

function allowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Tiles are immutable enough that a day of browser caching is safe. */
const CACHE_CONTROL = "public, max-age=86400, immutable";

export async function registerTileRoutes(app: FastifyInstance): Promise<void> {
  app.get("/proxy-tiles", async (request, reply) => {
    const query = z
      .object({ url: z.string().url().max(2048) })
      .safeParse(request.query);

    if (!query.success) throw badRequest("A tile url is required.");

    let target: URL;
    try {
      target = new URL(query.data.url);
    } catch {
      throw badRequest("That is not a valid url.");
    }

    if (target.protocol !== "https:" || !allowedHost(target.hostname)) {
      throw badRequest(
        `Refusing to proxy ${target.hostname}. Only the basemap CDN is allowed.`,
      );
    }

    const upstream = await fetch(target, {
      // Never follow a redirect: the allowlist check applies to the URL asked
      // for, and a redirect is the upstream choosing a different one.
      redirect: "manual",
      headers: { accept: "*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return reply.status(502).send({ error: "upstream-redirect" });
    }
    if (!upstream.ok) {
      return reply.status(upstream.status).send();
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    return reply
      .header(
        "content-type",
        upstream.headers.get("content-type") ?? "application/octet-stream",
      )
      .header("cache-control", CACHE_CONTROL)
      .send(body);
  });
}
