/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard is deliberately standalone: it reads the shared contract's
  // shapes but does not import across the workspace, so it stays mergeable and
  // runs even when the rest of the monorepo is mid-integration.
  experimental: { typedRoutes: false },
};
export default nextConfig;
