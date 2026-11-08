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
import { first, type PageSearchParams } from "@/lib/search-params";

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
  searchParams: Promise<PageSearchParams>;
}) {
  const session = await requireAppSession();
  const [t, trackingOn, sp] = await Promise.all([getTranslator(), isPlayHistoryEnabled(), searchParams]);

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
  if (!trackingOn) {
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

  // A repeated ?year= arrives as an array: first() takes its first value.
  const yearParam = first(sp.year);
  const requested = yearParam && /^\d{4}$/.test(yearParam) ? parseInt(yearParam, 10) : undefined;
  const { linked, years, year, data } = await getMyWrapped(session.user.id, requested);

  const serverProvider = isMediaServerProvider(session.user.provider);
  const view = data && year != null ? await wrappedViewOf(data, year) : null;

  return (
    <div className="ds-page-enter">
      {back}

      <PageHeader title={t("personal.wrapped.title")} subtitle={t("personal.wrapped.subtitle")} />

      {years.length > 1 && <YearPicker years={years} active={year} />}

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

type WrappedRaw = NonNullable<Awaited<ReturnType<typeof getMyWrapped>>["data"]>;

// The aggregates as the view's model, with each title's poster resolved. Live
// TmdbCache posters are authoritative; fall back to the PlayHistory snapshot
// for titles no longer cached (same as the dashboard).
async function wrappedViewOf(data: WrappedRaw, year: number): Promise<WrappedData> {
  const posterItems = [...data.topTitles, ...(data.longestSitting ? [data.longestSitting] : [])];
  const posters = await resolvePosterMap(posterItems);
  const src = (tmdbId: number | null, mediaType: string | null, posterPath: string | null) =>
    posterSrcFor(posters, tmdbId, mediaType, posterPath);
  const sitting = data.longestSitting;
  return {
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
    longestSitting: sitting
      ? {
          title: sitting.title,
          tmdbId: sitting.tmdbId,
          mediaType: sitting.mediaType,
          seconds: sitting.seconds,
          startedAt: sitting.startedAt,
          posterSrc: src(sitting.tmdbId, sitting.mediaType, sitting.posterPath),
        }
      : null,
    completion: data.completion,
    topPlatform: data.topPlatform,
    topDevice: data.topDevice,
  };
}

// One pill per year with data; the shown year is marked current.
function YearPicker({ years, active }: { years: number[]; active: number | null }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
      {years.map((y) => {
        const isActive = y === active;
        return (
          <Link
            key={y}
            href={`/my-stats/wrapped?year=${y}`}
            className="ds-mono ds-hover-tint"
            aria-current={isActive ? "page" : undefined}
            style={{
              fontSize: 12.5,
              padding: "5px 12px",
              borderRadius: 999,
              textDecoration: "none",
              border: "1px solid var(--ds-border)",
              background: isActive ? "var(--ds-accent)" : "var(--ds-bg-2)",
              color: isActive ? "var(--ds-accent-fg)" : "var(--ds-fg-muted)",
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {y}
          </Link>
        );
      })}
    </div>
  );
}
