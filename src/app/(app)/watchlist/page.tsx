import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui/design";
import { WatchlistGrid } from "@/components/watchlist/watchlist-grid";

export const dynamic = "force-dynamic";

// Personal watchlist page. The (app) layout DB-gates login for the whole subtree
// (guardrail 29); `auth()` here is a personalization read (the caller's own id),
// not an authorization decision, so JWT-only auth() is appropriate.
export default async function WatchlistPage() {
  const session = await auth();
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
