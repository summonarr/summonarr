import { Home, Film, Tv } from "@/components/icons";
import { StatePage } from "@/components/layout/state-page";
import { getTranslator } from "@/lib/i18n/server";

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
export default async function RootNotFound() {
  const t = await getTranslator();
  return (
    <StatePage
      frame="document"
      glyph="404"
      title={t("shared.notFound.title")}
      description={t("shared.notFound.description")}
      primary={{ label: t("shared.error.goHome"), href: "/", icon: <Home className="w-4 h-4" /> }}
      secondary={[
        { label: t("shared.notFound.browseMovies"), href: "/movies", icon: <Film className="w-4 h-4" /> },
        { label: t("shared.notFound.browseTv"), href: "/tv", icon: <Tv className="w-4 h-4" /> },
      ]}
    />
  );
}
