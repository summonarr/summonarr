import { requireAppSession } from "@/lib/require-app-session";
import { getMyWatchHistory, isMediaServerProvider } from "@/lib/my-watch-history";
import { isFeatureEnabled } from "@/lib/features";
import { isPlayHistoryEnabled } from "@/lib/play-history";
import { hasPermission, Permission } from "@/lib/permissions";
import { Clock } from "@/components/icons";
import { PageHeader } from "@/components/ui/design";
import { WatchHistoryList } from "@/components/watch-history/watch-history-list";
import { TrackingOffState } from "@/components/watch-history/tracking-off-state";
import { getTranslator } from "@/lib/i18n/server";
import { searchParamGetter, type PageSearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

// Personal watch-history page — the caller's own plays only. requireAppSession()
// is the per-page DB-checked login gate (guardrail 29); the scoping to the
// caller's linked media-server users lives in getMyWatchHistory, shared with
// GET /api/play-history/mine which the client list refetches through.
export default async function WatchHistoryPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>;
}) {
  // The tracking switch is a cheap settings read, so it joins the gate.
  const [sp, session, t, trackingOn] = await Promise.all([
    searchParams,
    requireAppSession(),
    getTranslator(),
    isPlayHistoryEnabled(),
  ]);
  // The list mirrors its filters into ?type= and ?q=, so a reload or a shared
  // link renders the same filtered first page.
  const get = searchParamGetter(sp);
  const rawType = get("type");
  const initialType = rawType === "MOVIE" || rawType === "TV" ? rawType : "";
  const initialSearch = (get("q") ?? "").trim();

  // Tracking off ⇒ nothing is recorded, so the list's "plays will show up
  // here" copy would be false. Say so (the /popular gate) and skip the history
  // read entirely.
  if (!trackingOn) {
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
    getMyWatchHistory(session.user.id, { mediaType: initialType || null, search: initialSearch || null }),
    // Row-level "Report issue" buttons only render when the issues feature is
    // on — POST /api/issues 403s while it's disabled.
    isFeatureEnabled("feature.page.issues"),
  ]);
  // Plex/Jellyfin sign-ins ARE media-server identities — never show them the
  // "get your account linked" explainer; their history simply hasn't been
  // recorded yet. Only local/OIDC accounts can genuinely need linking.
  const serverProvider = isMediaServerProvider(session.user.provider);

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("personal.history.title")}
        subtitle={t("personal.history.subtitle")}
      />
      <WatchHistoryList
        initial={initial}
        initialType={initialType}
        initialSearch={initialSearch}
        serverProvider={serverProvider}
        issuesEnabled={issuesEnabled}
      />
    </div>
  );
}
