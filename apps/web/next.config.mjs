/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard talks to the Scout API directly from the browser. The API
  // owns the scope gate and the audit log, so there is no second enforcement
  // point here to keep in sync — the UI can only ever ask.
  env: {
    NEXT_PUBLIC_API_URL:
      process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
