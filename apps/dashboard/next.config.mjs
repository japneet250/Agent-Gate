/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard is deliberately standalone: it reads the shared contract's
  // shapes but does not import across the workspace, so it stays mergeable and
  // runs even when the rest of the monorepo is mid-integration.
  experimental: {
    typedRoutes: false,
    // /api/benchmark reads packages/evals/report*.json off disk at request
    // time with fs.readFile, not an import — Next's file tracer only follows
    // imports, so on Vercel it silently ships a serverless function with
    // neither file and the route always 404s. This tells the tracer to bundle
    // them anyway. Without it the page still renders (the client falls back
    // to the fixture baked in at build time), but "re-run the harness, see
    // the number change with no rebuild" — the actual point of that route —
    // is dead in production.
    outputFileTracingIncludes: {
      '/api/benchmark': ['../../packages/evals/report.json', '../../packages/evals/report.baseline.json'],
    },
  },
};
export default nextConfig;
