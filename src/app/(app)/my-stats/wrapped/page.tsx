import Link from "next/link";
import { requireAppSession } from "@/lib/require-app-session";
import { getMyWrapped, isMediaServerProvider } from "@/lib/my-watch-history";
import { resolvePosterMap, posterSrcFor } from "@/lib/poster-cache";
import { ChevronLeft, Sparkles } from "@/components/icons";
import { EmptyState, PageHeader } from "@/components/ui/design";
import { WrappedView, type WrappedData } from "@/components/watch-history/wrapped-view";
import { TrackingOffState } from "@/components/watch-history/tracking-off-state";
import { isPlayHistoryEnabled } from "@/lib/play-history";
import { zonedDayKey } from "@/lib/stats-time-zone";
import { hasPermission, Permission } from "@/lib/permissions";
import { getTranslator } from "@/lib/i18n/server";

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
  const t = await getTranslator();

  const back = (
    <Link
      href="/my-stats"
      className="inline-flex items-center transition-colors text-[var(--ds-fg-muted)] hover:text-[var(--ds-fg)]"
      style={{
        gap: 4,
        marginBottom: 14,
        fontSize: 12.5,
        textDecoration: "none",
      }}
    >
      <ChevronLeft aria-hidden style={{ width: 14, height: 14 }} />
      {t("personal.wrapped.back")}
    </Link>
  );

  // Tracking off ⇒ nothing is recorded, so neither the year pills nor the
  // "not enough history" copy below is honest. Say so (the /popular gate) and
  // skip the aggregate read entirely.
  if (!(await isPlayHistoryEnabled())) {
    return (
      <div className="ds-page-enter">
        {back}
        <PageHeader title={t("personal.wrapped.title")} subtitle={t("personal.wrapped.subtitle")} />
        <TrackingOffState
          icon={Sparkles}
          t={t}
          canOpenSettings={hasPermission(session.user.permissions, Permission.ADMIN)}
        />
      </div>
    );
  }

  const sp = await searchParams;
  const requested = sp.year && /^\d{4}$/.test(sp.year) ? parseInt(sp.year, 10) : undefined;
  const { linked, years, year, data } = await getMyWrapped(session.user.id, requested);

  const serverProvider = isMediaServerProvider(session.user.provider);

  let view: WrappedData | null = null;
  if (data && year != null) {
    // Live TmdbCache posters are authoritative; fall back to the PlayHistory
    // snapshot for titles no longer cached (same as the dashboard).
    const posterItems = [...data.topTitles, ...(data.longestSitting ? [data.longestSitting] : [])];
    const posters = await resolvePosterMap(posterItems);
    const src = (tmdbId: number | null, mediaType: string | null, posterPath: string | null) =>
      posterSrcFor(posters, tmdbId, mediaType, posterPath);
    view = {
      year,
      // The year runs on the statistics zone's calendar, like the data.
      isCurrentYear: year === Number(zonedDayKey(new Date(), data.timeZone).slice(0, 4)),
      timeZone: data.timeZone,
      totals: data.totals,
      movies: data.movies,
      tv: data.tv,
      topTitles: data.topTitles.map((top) => ({
        title: top.title,
        tmdbId: top.tmdbId,
        mediaType: top.mediaType,
        count: top.count,
        hours: top.hours,
        posterSrc: src(top.tmdbId, top.mediaType, top.posterPath),
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
            posterSrc: src(
              data.longestSitting.tmdbId,
              data.longestSitting.mediaType,
              data.longestSitting.posterPath,
            ),
          }
        : null,
      completion: data.completion,
      topPlatform: data.topPlatform,
      topDevice: data.topDevice,
    };
  }

  return (
    <div className="ds-page-enter">
      {back}

      <PageHeader title={t("personal.wrapped.title")} subtitle={t("personal.wrapped.subtitle")} />

      {years.length > 1 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
          {years.map((y) => {
            const active = y === year;
            return (
              <Link
                key={y}
                href={`/my-stats/wrapped?year=${y}`}
                className="ds-mono ds-hover-tint"
                aria-current={active ? "page" : undefined}
                style={{
                  fontSize: 12.5,
                  padding: "5px 12px",
                  borderRadius: 999,
                  textDecoration: "none",
                  border: "1px solid var(--ds-border)",
                  background: active ? "var(--ds-accent)" : "var(--ds-bg-2)",
                  color: active ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {y}
              </Link>
            );
          })}
        </div>
      )}

      {view ? (
        <WrappedView data={view} />
      ) : (
        <EmptyState
          icon={Sparkles}
          title={t("personal.wrapped.emptyTitle")}
          description={
            !linked
              ? serverProvider
                ? t("personal.wrapped.emptyServer")
                : t("personal.wrapped.emptyUnlinked")
              : t("personal.wrapped.emptyNotEnough")
          }
        />
      )}
    </div>
  );
}
