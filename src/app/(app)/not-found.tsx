import { Home, Film, Tv } from "@/components/icons";
import { StatePage } from "@/components/layout/state-page";
import { getTranslator } from "@/lib/i18n/server";

// Replaces Next.js's default "404 / This page could not be found." text-only
// page. Server Component (no props per Next.js 16 not-found convention). Renders
// inside (app) layout, so the mobile bottom tab bar and drawer remain available
// for recovery alongside these CTAs. Copy is shared with the root boundary
// (src/app/not-found.tsx) via the shared.notFound.* keys — the two catch different cases
// but must read identically.
export default async function NotFound() {
  const t = await getTranslator();
  return (
    <StatePage
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
