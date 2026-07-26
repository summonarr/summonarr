import { requireAppSession } from "@/lib/require-app-session";
import { getMyWatchHistory } from "@/lib/my-watch-history";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/design";
import { WatchHistoryList } from "@/components/watch-history/watch-history-list";

export const dynamic = "force-dynamic";

// Personal watch-history page — the caller's own plays only. requireAppSession()
// is the per-page DB-checked login gate (guardrail 29); the scoping to the
// caller's linked media-server users lives in getMyWatchHistory, shared with
// GET /api/play-history/mine which the client list refetches through.
export default async function WatchHistoryPage() {
  const session = await requireAppSession();
  const [initial, issuesEnabled] = await Promise.all([
    getMyWatchHistory(session.user.id),
    // Row-level "Report issue" buttons only render when the issues feature is
    // on — POST /api/issues 403s while it's disabled.
    isFeatureEnabled("feature.page.issues"),
  ]);
  // Plex/Jellyfin sign-ins ARE media-server identities — never show them the
  // "get your account linked" explainer; their history simply hasn't been
  // recorded yet. Only local/OIDC accounts can genuinely need linking.
  const provider = session.user.provider ?? "";
  const serverProvider =
    provider === "plex" || provider === "jellyfin" || provider === "jellyfin-quickconnect";

  return (
    <div>
      <PageHeader
        title="Watch History"
        subtitle="What you've watched on the server"
      />
      <div style={{ marginTop: 16 }}>
        <WatchHistoryList
          initial={initial}
          serverProvider={serverProvider}
          issuesEnabled={issuesEnabled}
        />
      </div>
    </div>
  );
}
