import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { WatchlistGrid } from "@/components/watchlist/watchlist-grid";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// Newest-first page size. The grid is told the cap so it can say when the list
// was cut here (there is no load-more on this page).
const LIST_CAP = 500;

// Personal watchlist page. requireAppSession() is the per-page DB-checked login
// gate — the (app) layout's gate can be skipped via a client-supplied RSC router
// state tree, so each page enforces the login wall itself (see src/lib/require-app-session.ts).
export default async function WatchlistPage() {
  const session = await requireAppSession();
  const t = await getTranslator();
  const items = await prisma.watchlistItem.findMany({
    where: { userId: session.user.id },
    select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
    orderBy: { createdAt: "desc" },
    take: LIST_CAP,
  });

  return (
    <div className="ds-page-enter">
      <PageHeader title={t("personal.watchlist.title")} subtitle={t("personal.watchlist.subtitle")} />
      <WatchlistGrid initialItems={items} cap={LIST_CAP} />
    </div>
  );
}
