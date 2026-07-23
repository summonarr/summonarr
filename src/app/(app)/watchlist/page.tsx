import { requireAppSession } from "@/lib/require-app-session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { WatchlistGrid } from "@/components/watchlist/watchlist-grid";

export const dynamic = "force-dynamic";

// Personal watchlist page. requireAppSession() is the per-page DB-checked login
// gate — the (app) layout's gate can be skipped via a client-supplied RSC router
// state tree, so each page enforces the login wall itself (see src/lib/require-app-session.ts).
export default async function WatchlistPage() {
  const session = await requireAppSession();
  const items = session
    ? await prisma.watchlistItem.findMany({
        where: { userId: session.user.id },
        select: { tmdbId: true, mediaType: true, title: true, posterPath: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      })
    : [];

  return (
    <div>
      <PageHeader title="Watchlist" />
      <div style={{ marginTop: 16 }}>
        <WatchlistGrid initialItems={items} />
      </div>
    </div>
  );
}
