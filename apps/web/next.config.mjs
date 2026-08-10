/**
 * The dashboard talks to the Scout API through a same-origin `/api` path.
 *
 * It used to call `http://localhost:3001` straight from the browser, which
 * meant two ports to get right, a CORS allowlist to keep in sync, and a page
 * that sat there looking broken if either was wrong. Proxying through Next
 * leaves exactly one URL to open and no cross-origin request to configure.
 *
 * Set `SCOUT_API_URL` when the API is somewhere other than localhost:3001 —
 * it is read at *runtime* by the rewrite, not baked into the client bundle, so
 * the same build works in front of any API. `NEXT_PUBLIC_API_URL` still wins if
 * set, for a deployment that genuinely wants the browser calling the API
 * directly.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    // Empty means "same origin, via the rewrite below" — the default.
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "",
  },
  async rewrites() {
    // 127.0.0.1, not `localhost`. The API binds an IPv4 address, while
    // `localhost` resolves to ::1 first on most machines — so whether this
    // proxy reaches a running API comes down to Node's DNS ordering, and when
    // it picks the v6 address the page reports the API as down while it is
    // sitting there answering on v4.
    const target = process.env.SCOUT_API_URL ?? "http://127.0.0.1:3001";
    return [{ source: "/api/:path*", destination: `${target}/:path*` }];
  },
  eslint: { ignoreDuringBuilds: true },

  /**
   * What the dev server is allowed to watch.
   *
   * Without this, Watchpack walks the whole monorepo — including
   * `node_modules` across every workspace and `.pgdata`, which is a live
   * Postgres cluster the dev script creates inside the repo. On macOS every
   * watched file costs a descriptor, and between the API's watcher and this
   * one the process ran out: `EMFILE: too many open files`.
   *
   * The failure is silent and looks like something else entirely. Watchpack
   * logs the EMFILE and carries on, Next never finishes discovering the app
   * directory, and every request falls through to `_not-found` — so the
   * dashboard answers 404 on `/` while reporting itself as ready. It reads as
   * a broken route, not as a resource limit.
   */
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/node_modules/**",
          "**/.next/**",
          "**/dist/**",
          "**/.pgdata/**",
          "**/.git/**",
        ],
      };
    }
    return config;
  },
};

export default nextConfig;
