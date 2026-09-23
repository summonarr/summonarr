import { Home, Film, Tv } from "@/components/icons";
import { NOT_FOUND_COPY, StatePage } from "@/components/layout/state-page";

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
// auth gate, and an unmatched URL can be hit by a signed-out visitor — hence
// frame="document": nothing else is on the page, so it fills and centres the
// viewport where the (app) copy sits top-aligned under the header. The links
// below are the recovery path; each redirects to /login on its own if there is
// no session.
export default function RootNotFound() {
  return (
    <StatePage
      frame="document"
      glyph="404"
      title={NOT_FOUND_COPY.title}
      description={NOT_FOUND_COPY.description}
      primary={{ label: "Go home", href: "/", icon: <Home className="w-4 h-4" /> }}
      secondary={[
        { label: "Browse movies", href: "/movies", icon: <Film className="w-4 h-4" /> },
        { label: "Browse TV", href: "/tv", icon: <Tv className="w-4 h-4" /> },
      ]}
    />
  );
}
