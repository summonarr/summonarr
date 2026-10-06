import { requireAppSession } from "@/lib/require-app-session";
import { getMyWatchHistory } from "@/lib/my-watch-history";
import { isFeatureEnabled } from "@/lib/features";
import { isPlayHistoryEnabled } from "@/lib/play-history";
import { hasPermission, Permission } from "@/lib/permissions";
import { Clock } from "@/components/icons";
import { PageHeader } from "@/components/ui/design";
import { WatchHistoryList } from "@/components/watch-history/watch-history-list";
import { TrackingOffState } from "@/components/watch-history/tracking-off-state";
import { getTranslator } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// Personal watch-history page — the caller's own plays only. requireAppSession()
// is the per-page DB-checked login gate (guardrail 29); the scoping to the
// caller's linked media-server users lives in getMyWatchHistory, shared with
// GET /api/play-history/mine which the client list refetches through.
export default async function WatchHistoryPage() {
  const session = await requireAppSession();
  const t = await getTranslator();

  // Tracking off ⇒ nothing is recorded, so the list's "plays will show up
  // here" copy would be false. Say so (the /popular gate) and skip the history
  // read entirely.
  if (!(await isPlayHistoryEnabled())) {
    return (
      <div className="ds-page-enter">
        <PageHeader
          title={t("personal.history.title")}
          subtitle={t("personal.history.subtitle")}
        />
        <TrackingOffState
          icon={Clock}
          t={t}
          canOpenSettings={hasPermission(session.user.permissions, Permission.ADMIN)}
        />
      </div>
    );
  }

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
    <div className="ds-page-enter">
      <PageHeader
        title={t("personal.history.title")}
        subtitle={t("personal.history.subtitle")}
      />
      <WatchHistoryList
        initial={initial}
        serverProvider={serverProvider}
        issuesEnabled={issuesEnabled}
      />
    </div>
  );
}
