import type { NextConfig } from "next";

// The Content-Security-Policy header is set per request in src/proxy.ts,
// because it carries a fresh random nonce each time. The fixed security
// headers live here.
const securityHeaders = [
  // Prevent the page from being embedded in iframes (clickjacking protection)
  { key: "X-Frame-Options", value: "DENY" },
  // Prevent MIME-type sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Limit referrer information sent to other origins
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable browser features not needed by this app. (FLoC's interest-cohort
  // is gone from browsers; Chromium logs an unrecognized feature for it.)
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  // Keep search engines and AI crawlers from indexing any response
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
  // Force HTTPS for 1 year (only effective when served over HTTPS). This host
  // only: includeSubDomains would force HTTPS on every sibling subdomain of a
  // self-hosted domain (an apex deploy like https://example.com/request), and
  // preload consents to the browsers' preload list — both the operator's call,
  // made at their reverse proxy (docker-container/README.md). This value is
  // fixed at build time, so it can't be a runtime setting.
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Don't advertise the framework — drops the default `X-Powered-By: Next.js`.
  poweredByHeader: false,
  experimental: {
    // Cap how much of a request body the proxy layer will buffer in memory.
    // Next clones EVERY non-GET body up to this size before src/proxy.ts runs —
    // before any auth — so it is a per-request memory bound for anonymous
    // callers too. Each route enforces its own, much smaller limit via
    // readJsonCapped (guardrail 30). The largest legitimate body is a restore
    // chunk (MAX_CHUNK_BYTES, 20 MiB, in the two *import-chunk routes); this
    // must stay ABOVE it, because an over-limit body is truncated, not refused.
    // tests/security-invariants.test.mts pins the ordering.
    proxyClientMaxBodySize: "21mb",
  },
  logging: {
    fetches: { fullUrl: false },
  },
  // Allow deploying under a subpath (e.g. /request) behind a reverse proxy.
  // BASE_PATH is read at BUILD time and baked into the client bundle, so set it
  // when running `next build` (the Dockerfile takes it as a build arg).
  ...(process.env.BASE_PATH ? { basePath: process.env.BASE_PATH } : {}),
  // Exclude packages from standalone tracing that are not needed at runtime.
  // Drop Wasm query compilers for databases other than PostgreSQL, and prisma dev tooling.
  outputFileTracingExcludes: {
    "/**": [
      "./node_modules/@prisma/client/runtime/query_compiler_fast_bg.cockroachdb*",
      "./node_modules/@prisma/client/runtime/query_compiler_fast_bg.mysql*",
      "./node_modules/@prisma/client/runtime/query_compiler_fast_bg.sqlserver*",
      "./node_modules/@prisma/client/runtime/query_compiler_small_bg.cockroachdb*",
      "./node_modules/@prisma/client/runtime/query_compiler_small_bg.mysql*",
      "./node_modules/@prisma/client/runtime/query_compiler_small_bg.sqlserver*",
      "./node_modules/@prisma/studio-core/**",
      "./node_modules/@prisma/dev/**",
      "./node_modules/@prisma/engines/**",
      "./node_modules/prisma/**",
      "./node_modules/shadcn/**",
    ],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: "/(.*)",
        headers: securityHeaders,
      },
      {
        // Prevent CDNs and shared caches from serving authenticated API responses
        // to other users. Private ensures only the browser can cache; no-store
        // prevents stale data from being served after state changes.
        source: "/api/(.*)",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Vary", value: "Cookie" },
        ],
      },
    ];
  },
};

export default nextConfig;
