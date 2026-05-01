import Link from "next/link";
import { Home, Film, Tv } from "lucide-react";

// Mobile audit F-2.1: replaces Next.js's default "404 / This page could not
// be found." text-only page. Server Component (no props per Next.js 16
// not-found convention). Renders inside (app) layout, so the mobile bottom
// tab bar and drawer remain available for recovery alongside these CTAs.
export default function NotFound() {
  return (
    <div
      className="flex flex-col items-center justify-start px-6"
      style={{ paddingTop: 64, paddingBottom: 64, minHeight: "60vh" }}
    >
      <div
        className="ds-mono"
        style={{
          fontSize: 64,
          fontWeight: 700,
          color: "var(--ds-fg-muted)",
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        404
      </div>
      <h1
        className="m-0 font-semibold text-center"
        style={{ fontSize: 22, color: "var(--ds-fg)", marginTop: 12 }}
      >
        Couldn&apos;t find that page
      </h1>
      <p
        className="text-center"
        style={{
          fontSize: 14,
          color: "var(--ds-fg-muted)",
          marginTop: 8,
          maxWidth: 320,
          lineHeight: 1.5,
        }}
      >
        The page or title you&apos;re looking for might have been removed, is
        unavailable, or the link is wrong.
      </p>
      <div
        className="flex flex-col items-stretch gap-2"
        style={{ marginTop: 28, width: "100%", maxWidth: 280 }}
      >
        <Link
          href="/"
          className="ds-tap inline-flex items-center justify-center gap-2 font-medium"
          style={{
            background: "var(--ds-accent)",
            color: "var(--ds-accent-fg)",
            borderRadius: 10,
            minHeight: 44,
            fontSize: 14,
          }}
        >
          <Home className="w-4 h-4" />
          Go home
        </Link>
        <Link
          href="/movies"
          className="ds-tap inline-flex items-center justify-center gap-2 font-medium"
          style={{
            background: "var(--ds-bg-2)",
            color: "var(--ds-fg)",
            border: "1px solid var(--ds-border)",
            borderRadius: 10,
            minHeight: 44,
            fontSize: 14,
          }}
        >
          <Film className="w-4 h-4" />
          Browse movies
        </Link>
        <Link
          href="/tv"
          className="ds-tap inline-flex items-center justify-center gap-2 font-medium"
          style={{
            background: "var(--ds-bg-2)",
            color: "var(--ds-fg)",
            border: "1px solid var(--ds-border)",
            borderRadius: 10,
            minHeight: 44,
            fontSize: 14,
          }}
        >
          <Tv className="w-4 h-4" />
          Browse TV
        </Link>
      </div>
    </div>
  );
}
