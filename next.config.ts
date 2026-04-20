import type { NextConfig } from "next";

// CSP is now set dynamically per-request in proxy.ts (nonce-based).
// Only non-CSP security headers remain here.
const securityHeaders = [
  // Prevent the page from being embedded in iframes (clickjacking protection)
  { key: "X-Frame-Options", value: "DENY" },
  // Prevent MIME-type sniffing
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Limit referrer information sent to other origins
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable browser features not needed by this app
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Force HTTPS for 1 year (only effective when served over HTTPS)
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Cap proxy body buffering — defence-in-depth against oversized request payloads.
    // Route handlers enforce their own limits; this prevents the proxy layer from
    // buffering unbounded request bodies into memory.
    proxyClientMaxBodySize: "50mb",
  },
  logging: {
    fetches: { fullUrl: false },
  },
  // Allow deploying under a subpath (e.g. /request) behind a reverse proxy.
  // Set BASE_PATH=/request in your environment to enable.
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
