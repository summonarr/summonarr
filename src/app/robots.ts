import type { MetadataRoute } from "next";

// A private, login-gated app: ask every well-behaved crawler to stay out.
// Advisory only — the X-Robots-Tag header (next.config.ts) and the page-level
// `robots` metadata (layout.tsx) back it up; real access control is the login.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
