import Link from "next/link";
import { requireAppSession } from "@/lib/require-app-session";
import { getMyWrapped } from "@/lib/my-watch-history";
import { resolvePosterMap } from "@/lib/poster-cache";
import { posterUrl } from "@/lib/tmdb-types";
import { PageHeader } from "@/components/ui/design";
import { WrappedView, type WrappedData } from "@/components/watch-history/wrapped-view";

export const dynamic = "force-dynamic";

// Personal "Wrapped" year-in-review — the caller's OWN aggregates only.
// requireAppSession() is the per-page DB-checked login gate (guardrail 29); the
// scoping to linked media-server identities lives in getMyWrapped (the shared
// chokepoint). The `?year=` param is validated to 4 digits here and re-checked
// against the years-with-data list inside getMyWrapped, so it can only ever
// select a year the caller actually has.
export default async function WrappedPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const session = await requireAppSession();
  const sp = await searchParams;
  const requested = sp.year && /^\d{4}$/.test(sp.year) ? parseInt(sp.year, 10) : undefined;
  const { linked, years, year, data } = await getMyWrapped(session.user.id, requested);

  const provider = session.user.provider ?? "";
  const serverProvider =
    provider === "plex" || provider === "jellyfin" || provider === "jellyfin-quickconnect";

  let view: WrappedData | null = null;
  if (data && year != null) {
    // Live TmdbCache posters are authoritative; fall back to the PlayHistory
    // snapshot for titles no longer cached (same as the dashboard).
    const posterItems = [...data.topTitles, ...(data.longestSitting ? [data.longestSitting] : [])];
    const posters = await resolvePosterMap(posterItems);
    const src = (tmdbId: number | null, posterPath: string | null) =>
      (tmdbId != null ? posters[tmdbId] : undefined) ?? (posterPath ? posterUrl(posterPath, "w342") : null);
    view = {
      year,
      isCurrentYear: year === new Date().getUTCFullYear(),
      totals: data.totals,
      movies: data.movies,
      tv: data.tv,
      topTitles: data.topTitles.map((t) => ({
        title: t.title,
        tmdbId: t.tmdbId,
        mediaType: t.mediaType,
        count: t.count,
        hours: t.hours,
        posterSrc: src(t.tmdbId, t.posterPath),
      })),
      biggestDay: data.biggestDay,
      busiestMonth: data.busiestMonth,
      primeDow: data.primeDow,
      primeHour: data.primeHour,
      longestSitting: data.longestSitting
        ? {
            title: data.longestSitting.title,
            tmdbId: data.longestSitting.tmdbId,
            mediaType: data.longestSitting.mediaType,
            seconds: data.longestSitting.seconds,
            startedAt: data.longestSitting.startedAt,
            posterSrc: src(data.longestSitting.tmdbId, data.longestSitting.posterPath),
          }
        : null,
      completion: data.completion,
      topPlatform: data.topPlatform,
      topDevice: data.topDevice,
    };
  }

  return (
    <div>
      <Link
        href="/my-stats"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 14,
          fontSize: 12.5,
          color: "var(--ds-fg-muted)",
          textDecoration: "none",
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M7 3l-3 3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back to My Stats
      </Link>

      <PageHeader title="Year in Review" subtitle="Your watching, wrapped up" />

      {years.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {years.map((y) => {
            const active = y === year;
            return (
              <Link
                key={y}
                href={`/my-stats/wrapped?year=${y}`}
                className="ds-mono"
                style={{
                  fontSize: 12.5,
                  padding: "5px 12px",
                  borderRadius: 999,
                  textDecoration: "none",
                  border: "1px solid var(--ds-border)",
                  background: active ? "var(--ds-accent)" : "var(--ds-bg-2)",
                  color: active ? "#fff" : "var(--ds-fg-muted)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {y}
              </Link>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {view ? (
          <WrappedView data={view} />
        ) : (
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
            {!linked
              ? serverProvider
                ? "No watch activity has been recorded for your account yet — once you play something on the server, your Year in Review will appear here."
                : "Your account isn't linked to a Plex or Jellyfin identity yet, so there's nothing to wrap up. Your account links automatically when your media-server email matches, or an admin can link it manually."
              : "Not enough watch activity yet to build a Year in Review. Come back once you've watched a few things on the server."}
          </div>
        )}
      </div>
    </div>
  );
}
