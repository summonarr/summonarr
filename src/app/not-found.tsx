import Link from "next/link";
import { Home, Film, Tv } from "@/components/icons";

// ROOT not-found boundary. This is a different file from (app)/not-found.tsx and
// catches a different case — do not merge them.
//
// A not-found.tsx inside a route group only handles notFound() thrown by
// segments in that group, which is why /movie/999999999 (a real route that
// calls notFound()) got the branded page while /anything-else fell through to
// Next's built-in "404 · This page could not be found" — no styling, no way
// out but the back button. Per the Next 16 docs: "the root app/not-found.js and
// app/global-not-found.js files handle any unmatched URLs for your whole
// application."
//
// Deliberately a root not-found rather than a global-not-found: this renders
// inside the root layout, so it inherits the fonts, theme script and design
// tokens for free. global-not-found bypasses layout entirely and would have to
// re-import all of that, including the theme — it only sees the OS colour
// scheme otherwise.
//
// It has no sidebar or header because those live in (app)/layout.tsx behind an
// auth gate, and an unmatched URL can be hit by a signed-out visitor. The links
// below are the recovery path; each redirects to /login on its own if there is
// no session.
export default function RootNotFound() {
  return (
    <div
      className="flex flex-col items-center justify-center px-6"
      style={{ minHeight: "100dvh", paddingTop: 48, paddingBottom: 48 }}
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
        That address doesn&apos;t match anything here. It may have been removed,
        or the link may be wrong.
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
