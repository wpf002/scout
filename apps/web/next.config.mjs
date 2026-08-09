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
    const target = process.env.SCOUT_API_URL ?? "http://localhost:3001";
    return [{ source: "/api/:path*", destination: `${target}/:path*` }];
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
