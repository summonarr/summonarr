import Link from "next/link";
import { requireAppSession } from "@/lib/require-app-session";
import { getMyPlayStats } from "@/lib/my-watch-history";
import { resolvePosterMap, posterPathKey } from "@/lib/poster-cache";
import { posterUrl } from "@/lib/tmdb-types";
import { PageHeader } from "@/components/ui/design";
import { MyStatsView, type MyStatsData } from "@/components/watch-history/my-stats-view";

export const dynamic = "force-dynamic";

// Personal watch-stats dashboard — the caller's OWN aggregates only.
// requireAppSession() is the per-page DB-checked login gate (guardrail 29); any
// authenticated user may view their own stats, so there is no role check. All
// scoping to the caller's linked media-server identities lives in
// getMyPlayStats (the shared chokepoint with getMyWatchHistory) — no userId
// param exists, so nothing here can widen the scope to another user.
export default async function MyStatsPage() {
  const session = await requireAppSession();
  const { linked, stats } = await getMyPlayStats(session.user.id);

  // Plex/Jellyfin sign-ins ARE media-server identities — for them an empty
  // result means "nothing recorded yet", not "unlinked account". Only
  // local/OIDC accounts can genuinely need linking (mirrors /watch-history).
  const provider = session.user.provider ?? "";
  const serverProvider =
    provider === "plex" || provider === "jellyfin" || provider === "jellyfin-quickconnect";

  let data: MyStatsData | null = null;
  if (stats) {
    // Live TmdbCache posters are authoritative and current; fall back to the
    // PlayHistory.posterPath snapshot only for titles no longer cached (the
    // admin per-user page does the same). No unmapped-title library resolution
    // here — a rare missing poster degrades to the letter tile, which is fine
    // for a personal surface.
    const posters = await resolvePosterMap(stats.topMedia);
    data = {
      totalPlays: stats.totalPlays,
      totalWatchTimeHours: stats.totalWatchTimeHours,
      avgSessionDuration: stats.avgSessionDuration,
      lastActiveIso: stats.recentPlays[0]?.startedAt.toISOString() ?? null,
      activityCalendar: stats.activityCalendar,
      // Server-computed reference date passed as a prop — never Date.now() in
      // the client render path (guardrail 16).
      todayIso: new Date().toISOString(),
      playsByDay: stats.playsByDay,
      userHeatmap: stats.userHeatmap,
      platformBreakdown: stats.platformBreakdown,
      deviceList: stats.deviceList,
      topMedia: stats.topMedia.map((m) => ({
        title: m.title,
        tmdbId: m.tmdbId,
        mediaType: m.mediaType,
        count: m.count,
        posterSrc:
          (m.tmdbId != null ? posters[posterPathKey(m.tmdbId, m.mediaType)] : undefined) ??
          (m.posterPath ? posterUrl(m.posterPath, "w342") : null),
      })),
    };
  }

  return (
    <div>
      <PageHeader title="My Stats" subtitle="Your viewing activity on the server" />
      <div style={{ marginTop: 16 }}>
        {!linked ? (
          <div
            style={{
              padding: 24,
              border: "1px solid var(--ds-border)",
              borderRadius: 10,
              background: "var(--ds-bg-2)",
              color: "var(--ds-fg-subtle)",
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {serverProvider
              ? "No watch activity has been recorded for your account yet. Once you play something on the server, your stats will appear here."
              : "Your account isn't linked to a Plex or Jellyfin identity yet, so there's no watch history to summarize. Your account links automatically when your media-server email matches, or an admin can link it manually."}
          </div>
        ) : data ? (
          <>
            {data.totalPlays > 0 && (
              <Link
                href="/my-stats/wrapped"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 22,
                  padding: "14px 18px",
                  borderRadius: 12,
                  textDecoration: "none",
                  color: "#fff",
                  background:
                    "linear-gradient(135deg, oklch(0.5 0.22 285) 0%, oklch(0.52 0.22 330) 55%, oklch(0.6 0.2 25) 100%)",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 18 }}>✨</span>
                  <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em" }}>
                    Your Year in Review
                  </span>
                </span>
                <span aria-hidden style={{ fontSize: 18, opacity: 0.9 }}>→</span>
              </Link>
            )}
            <MyStatsView data={data} />
          </>
        ) : null}
      </div>
    </div>
  );
}
