import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { authActive } from "@/lib/auth";
import { hasPermission, Permission } from "@/lib/permissions";
import { requireFeature } from "@/lib/features";
import { PageHeader, StatCard } from "@/components/ui/design";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { ISSUE_TYPE_LABEL_KEY } from "@/lib/status-labels";
import {
  PENDING_AGE_ALERT_DAYS,
  PENDING_AGE_WARN_DAYS,
  STUCK_DOWNLOAD_DAYS,
  durationParts,
  parseStatsRange,
  share,
  statsRangeSince,
  utcMonthKey,
} from "@/lib/admin-stats";
import {
  getFulfillmentStats,
  getIssueStats,
  getLibraryGrowth,
  getLibraryStats,
  getMostWantedPending,
  getPendingQueue,
  getRequestOverview,
  getRequestSources,
  getRequestsByInstance,
  getRequestsByMonth,
  getStorageStats,
  getStuckRequests,
  getTopDeletionVotes,
  getTopRequesters,
  getUserStats,
  getWatchGradeSpreadForStats,
  type DurationStat,
  type StuckReason,
} from "@/lib/admin-stats-data";
import { StatsRangeFilter } from "@/components/admin/stats/stats-range-filter";
import {
  MEDIA_COLOR,
  STATUS_COLOR,
  Meter,
  MetricGrid,
  MonthChart,
  RankList,
  ShareBar,
  StatsNote,
  StatsSection,
  SubHeading,
} from "@/components/admin/stats/stats-ui";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Fmt {
  t: Translator;
  locale: string;
  num: (n: number) => string;
  pct: (ratio: number | null) => string;
  bytes: (n: number) => string;
  duration: (seconds: number | null) => string;
  ageDays: (iso: string | null) => number | null;
}

function makeFormatters(t: Translator, locale: string, now: Date): Fmt {
  const numberFmt = new Intl.NumberFormat(locale);
  const pctFmt = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const oneDecimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  return {
    t,
    locale,
    num: (n) => numberFmt.format(n),
    pct: (r) => (r === null ? "—" : pctFmt.format(r)),
    bytes: (n) => {
      if (!(n > 0)) return "0 B";
      const i = Math.max(0, Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1));
      return `${oneDecimal.format(n / Math.pow(1024, i))} ${units[i]}`;
    },
    duration: (s) => {
      if (s === null) return "—";
      const { unit, value } = durationParts(s);
      // `count` picks the plural form ("1 day" / "1.5 days"); `value` is the
      // locale-formatted number the string shows.
      const vars = { count: value, value: oneDecimal.format(value) };
      return unit === "minutes"
        ? t("adminManage.stats.minutes", vars)
        : unit === "hours"
          ? t("adminManage.stats.hours", vars)
          : t("adminManage.stats.days", vars);
    },
    ageDays: (iso) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS)) : null),
  };
}

const mediaHref = (mediaType: string, tmdbId: number) => `/${mediaType === "TV" ? "tv" : "movie"}/${tmdbId}`;

export default async function StatsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireFeature("feature.admin.stats");
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { range: rangeParam } = await searchParams;
  const range = parseStatsRange(rangeParam);
  const now = new Date();
  const since = statsRangeSince(range, now);

  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);
  const f = makeFormatters(t, locale, now);

  const [
    overview, fulfillment, months, pending, mostWanted, stuck,
    instances, users, topRequesters, library, growth, issues, votes,
  ] = await Promise.all([
    getRequestOverview(since),
    getFulfillmentStats(since),
    getRequestsByMonth(),
    getPendingQueue(),
    getMostWantedPending(),
    getStuckRequests(),
    getRequestsByInstance(since),
    getUserStats(since),
    getTopRequesters(since),
    getLibraryStats(),
    getLibraryGrowth(),
    getIssueStats(since),
    getTopDeletionVotes(),
  ]);
  // Needs the window's total, so it can't join the batch above.
  const sources = await getRequestSources(since, overview.total);

  const currentMonth = utcMonthKey(now);
  const decisions = overview.approved + overview.byStatus.DECLINED;
  const oldestPendingDays = f.ageDays(pending.oldestCreatedAt);
  const oldestIssueDays = f.ageDays(issues.oldestOpenCreatedAt);
  const unresolvedIssues = issues.open + issues.inProgress;
  const stuckTotal = stuck.counts["push-failed"] + stuck.counts["not-in-arr"] + stuck.counts["slow-download"];
  const rangeLabel = t(`adminManage.stats.rangeLabel.${range}`);

  const kpis = [
    { key: "requests", label: t("adminManage.stats.totalRequests"), value: f.num(overview.total), hint: rangeLabel },
    {
      key: "pending",
      label: t("adminManage.stats.awaitingDecision"),
      value: f.num(pending.requests),
      hint: oldestPendingDays === null ? t("adminManage.stats.queueEmpty") : t("adminManage.stats.oldestDays", { count: oldestPendingDays }),
    },
    {
      key: "approval",
      label: t("adminManage.stats.approvalRate"),
      value: f.pct(share(overview.approved, decisions)),
      // `count` picks the plural form; `value` is the Intl-grouped number shown,
      // so the hint agrees with the formatted KPI above it (translate.ts
      // interpolates String(v), never Intl).
      hint: t("adminManage.stats.ofDecisions", { count: decisions, value: f.num(decisions) }),
    },
    {
      key: "fulfil",
      label: t("adminManage.stats.medianFulfillment"),
      value: f.duration(fulfillment.total.medianSeconds),
      hint: t("adminManage.stats.requestToAvailable"),
    },
    {
      key: "users",
      label: t("adminManage.stats.activeUsers"),
      value: f.num(users.active),
      hint: t("adminManage.stats.seenLast30", { count: users.seenLast30Days, value: f.num(users.seenLast30Days) }),
    },
    {
      key: "issues",
      label: t("adminManage.stats.unresolvedIssues"),
      value: f.num(unresolvedIssues),
      hint: t("adminManage.stats.openInProgress", { open: f.num(issues.open), inProgress: f.num(issues.inProgress) }),
    },
  ];

  return (
    <div className="ds-page-enter">
      <PageHeader
        title={t("adminManage.stats.title")}
        subtitle={t("adminManage.stats.subtitle")}
        right={
          <Link href="/admin/activity/stats" className="text-sm hover:underline" style={{ color: "var(--ds-accent-text)" }}>
            {t("adminManage.stats.playbackLink")}
          </Link>
        }
      />

      <StatsRangeFilter active={range} />

      <div
        className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6"
        style={{ gap: 10, marginBottom: 20 }}
      >
        {kpis.map((k) => (
          <StatCard key={k.key} label={k.label} value={k.value} hint={k.hint} mono />
        ))}
      </div>

      <AttentionSection f={f} pending={pending} oldestPendingDays={oldestPendingDays} stuck={stuck} stuckTotal={stuckTotal} mostWanted={mostWanted} />

      <PipelineSection f={f} overview={overview} decisions={decisions} sources={sources} instances={instances} rangeLabel={rangeLabel} />

      <FulfillmentSection f={f} fulfillment={fulfillment} rangeLabel={rangeLabel} />

      <StatsSection id="stats-months" title={t("adminManage.stats.requestsOverTime")} subtitle={t("adminManage.stats.last12Months")}>
        <MonthChart
          months={months.map((m) => m.month)}
          series={(["AVAILABLE", "APPROVED", "PENDING", "DECLINED"] as const).map((s) => ({
            key: s,
            label: t(`requests.status.${s.toLowerCase()}`),
            color: STATUS_COLOR[s],
            values: months.map((m) => m.byStatus[s]),
          }))}
          locale={locale}
          currentMonth={currentMonth}
          ariaLabel={t("adminManage.stats.requestsOverTime")}
          partialLabel={t("adminManage.stats.monthInProgress")}
          monthHeader={t("adminManage.stats.month")}
          formatNumber={f.num}
        />
      </StatsSection>

      <UsersSection f={f} users={users} topRequesters={topRequesters} currentMonth={currentMonth} rangeLabel={rangeLabel} />

      <LibrarySection f={f} library={library} growth={growth} currentMonth={currentMonth} />

      <IssuesSection f={f} issues={issues} oldestIssueDays={oldestIssueDays} unresolved={unresolvedIssues} rangeLabel={rangeLabel} />

      <VotesSection f={f} votes={votes} />

      <Suspense fallback={<SlowSectionFallback title={t("adminManage.stats.storage")} label={t("adminManage.stats.loadingStorage")} />}>
        <StorageSection f={f} />
      </Suspense>

      <Suspense fallback={<SlowSectionFallback title={t("adminManage.stats.watchGrades")} label={t("adminManage.stats.loadingGrades")} />}>
        <WatchGradesSection f={f} />
      </Suspense>
    </div>
  );
}

// ─── Sections ────────────────────────────────────────────────────────────────

function AttentionSection({
  f, pending, oldestPendingDays, stuck, stuckTotal, mostWanted,
}: {
  f: Fmt;
  pending: Awaited<ReturnType<typeof getPendingQueue>>;
  oldestPendingDays: number | null;
  stuck: Awaited<ReturnType<typeof getStuckRequests>>;
  stuckTotal: number;
  mostWanted: Awaited<ReturnType<typeof getMostWantedPending>>;
}) {
  const { t } = f;
  const reasonLabel: Record<StuckReason, string> = {
    "push-failed": t("adminManage.stats.stuck.pushFailed"),
    "not-in-arr": t("adminManage.stats.stuck.notInArr"),
    "slow-download": t("adminManage.stats.stuck.slowDownload", { days: STUCK_DOWNLOAD_DAYS }),
  };
  return (
    <StatsSection id="stats-attention" title={t("adminManage.stats.needsAttention")} subtitle={t("adminManage.stats.currentState")}>
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 24 }}>
        <div>
          <SubHeading>{t("adminManage.stats.pendingQueue")}</SubHeading>
          <MetricGrid
            columns="grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 xl:grid-cols-4"
            items={[
              { label: t("adminManage.stats.requests"), value: f.num(pending.requests) },
              { label: t("adminManage.stats.titles"), value: f.num(pending.titles) },
              {
                label: t("adminManage.stats.olderThanDays", { count: PENDING_AGE_WARN_DAYS }),
                value: f.num(pending.olderThanWarn),
                tone: pending.olderThanWarn > 0 ? "warning" : undefined,
              },
              {
                label: t("adminManage.stats.olderThanDays", { count: PENDING_AGE_ALERT_DAYS }),
                value: f.num(pending.olderThanAlert),
                tone: pending.olderThanAlert > 0 ? "danger" : undefined,
              },
            ]}
          />
          {oldestPendingDays !== null && (
            <StatsNote>{t("adminManage.stats.oldestPending", { count: oldestPendingDays })}</StatsNote>
          )}
          <div style={{ marginTop: 18 }}>
            <SubHeading>{t("adminManage.stats.mostWanted")}</SubHeading>
            <RankList
              emptyLabel={t("adminManage.stats.queueEmpty")}
              rows={mostWanted.map((w) => ({
                key: `${w.mediaType}:${w.tmdbId}`,
                label: w.title,
                href: mediaHref(w.mediaType, w.tmdbId),
                value: t("adminManage.stats.requesterCount", { count: w.requesters }),
                detail: t("adminManage.stats.waitingDays", { count: f.ageDays(w.oldestCreatedAt) ?? 0 }),
              }))}
            />
          </div>
        </div>
        <div>
          <SubHeading>{t("adminManage.stats.stuckRequests")}</SubHeading>
          <MetricGrid
            columns="grid-cols-3"
            items={(["push-failed", "not-in-arr", "slow-download"] as const).map((r) => ({
              label: reasonLabel[r],
              value: f.num(stuck.counts[r]),
              tone: stuck.counts[r] > 0 ? (r === "slow-download" ? "warning" : "danger") : undefined,
            }))}
          />
          <StatsNote>{t("adminManage.stats.stuckHint")}</StatsNote>
          {stuckTotal > 0 && (
            <div style={{ marginTop: 18 }}>
              <SubHeading>{t("adminManage.stats.oldestStuck")}</SubHeading>
              <RankList
                emptyLabel=""
                rows={stuck.oldest.map((s) => ({
                  key: s.id,
                  label: s.title,
                  href: mediaHref(s.mediaType, s.tmdbId),
                  value: t("adminManage.stats.daysShort", { count: f.ageDays(s.approvedAt) ?? 0 }),
                  detail: `${reasonLabel[s.reason]}${s.arrInstance ? ` · ${s.arrInstance}` : ""}`,
                }))}
              />
            </div>
          )}
        </div>
      </div>
    </StatsSection>
  );
}

function PipelineSection({
  f, overview, decisions, sources, instances, rangeLabel,
}: {
  f: Fmt;
  overview: Awaited<ReturnType<typeof getRequestOverview>>;
  decisions: number;
  sources: Awaited<ReturnType<typeof getRequestSources>>;
  instances: Awaited<ReturnType<typeof getRequestsByInstance>>;
  rangeLabel: string;
}) {
  const { t } = f;
  const s = overview.byStatus;
  const greenlit = s.APPROVED + s.AVAILABLE;
  return (
    <StatsSection id="stats-pipeline" title={t("adminManage.stats.requests")} subtitle={rangeLabel}>
      <ShareBar
        ariaLabel={t("adminManage.stats.byStatus")}
        formatNumber={f.num}
        parts={(["AVAILABLE", "APPROVED", "PENDING", "DECLINED"] as const).map((k) => ({
          label: t(`requests.status.${k.toLowerCase()}`),
          value: s[k],
          color: STATUS_COLOR[k],
        }))}
      />
      <div style={{ marginTop: 18 }}>
        <MetricGrid
          columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
          items={[
            { label: t("adminManage.stats.approvalRate"), value: f.pct(share(overview.approved, decisions)), hint: t("adminManage.stats.ofDecisions", { count: decisions, value: f.num(decisions) }) },
            { label: t("adminManage.stats.declineRate"), value: f.pct(share(s.DECLINED, decisions)) },
            { label: t("adminManage.stats.fulfillmentRate"), value: f.pct(share(s.AVAILABLE, greenlit)), hint: t("adminManage.stats.fulfillmentRateHint") },
            { label: t("adminManage.stats.alreadyAvailable"), value: f.num(overview.mirrored), hint: t("adminManage.stats.alreadyAvailableHint") },
            { label: t("nav.movies"), value: f.num(overview.byMediaType.MOVIE) },
            { label: t("nav.tvShows"), value: f.num(overview.byMediaType.TV) },
          ]}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 24, marginTop: 20 }}>
        <div>
          <SubHeading>{t("adminManage.stats.sources")}</SubHeading>
          <ShareBar
            ariaLabel={t("adminManage.stats.sources")}
            formatNumber={f.num}
            parts={[
              { label: t("adminManage.stats.source.manual"), value: sources.other, color: "var(--ds-accent)" },
              { label: t("adminManage.stats.source.watchlist"), value: sources.watchlist, color: "var(--ds-info)" },
              { label: t("adminManage.stats.source.plexWatchlist"), value: sources.plexWatchlist, color: "var(--ds-plex)" },
            ]}
          />
          <StatsNote>{t("adminManage.stats.sourcesHint")}</StatsNote>
        </div>
        {instances.length > 1 && (
          <div>
            <SubHeading>{t("adminManage.stats.byInstance")}</SubHeading>
            <RankList
              emptyLabel=""
              rows={instances.map((i) => ({
                key: i.slug || "default",
                label: i.slug ? i.name : t("adminManage.stats.defaultInstance"),
                value: f.num(i.count),
              }))}
            />
          </div>
        )}
      </div>
    </StatsSection>
  );
}

function durationItems(f: Fmt, label: string, d: DurationStat, hint?: string) {
  return {
    label,
    value: f.duration(d.medianSeconds),
    hint: d.count > 0
      ? t90(f, d) + (hint ? ` · ${hint}` : "")
      : f.t("adminManage.stats.noData"),
  };
}
function t90(f: Fmt, d: DurationStat, of: "requests" | "issues" = "requests") {
  const vars = { p90: f.duration(d.p90Seconds), count: d.count, value: f.num(d.count) };
  return of === "issues" ? f.t("adminManage.stats.p90OfIssues", vars) : f.t("adminManage.stats.p90Of", vars);
}

function FulfillmentSection({
  f, fulfillment, rangeLabel,
}: {
  f: Fmt;
  fulfillment: Awaited<ReturnType<typeof getFulfillmentStats>>;
  rangeLabel: string;
}) {
  const { t } = f;
  const autoShare = share(fulfillment.autoApproved, fulfillment.autoApproved + fulfillment.adminApproved);
  return (
    <StatsSection id="stats-fulfillment" title={t("adminManage.stats.timeToFulfil")} subtitle={`${rangeLabel} · ${t("adminManage.stats.medianNote")}`}>
      <MetricGrid
        columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
        items={[
          durationItems(f, t("adminManage.stats.timeToApprove"), fulfillment.approve),
          durationItems(f, t("adminManage.stats.timeToDownload"), fulfillment.download),
          durationItems(f, t("adminManage.stats.requestToAvailable"), fulfillment.total),
          {
            label: t("adminManage.stats.autoApproved"),
            value: f.pct(autoShare),
            hint: t("adminManage.stats.autoApprovedHint", { auto: f.num(fulfillment.autoApproved), admin: f.num(fulfillment.adminApproved) }),
          },
        ]}
      />
      <div style={{ marginTop: 18 }}>
        <MetricGrid
          columns="grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
          items={[
            durationItems(f, `${t("nav.movies")} · ${t("adminManage.stats.timeToDownload")}`, fulfillment.byMediaType.MOVIE.download),
            durationItems(f, `${t("nav.movies")} · ${t("adminManage.stats.requestToAvailable")}`, fulfillment.byMediaType.MOVIE.total),
            durationItems(f, `${t("nav.tvShows")} · ${t("adminManage.stats.timeToDownload")}`, fulfillment.byMediaType.TV.download),
            durationItems(f, `${t("nav.tvShows")} · ${t("adminManage.stats.requestToAvailable")}`, fulfillment.byMediaType.TV.total),
          ]}
        />
      </div>
      <StatsNote>{t("adminManage.stats.fulfillmentHint")}</StatsNote>
    </StatsSection>
  );
}

function UsersSection({
  f, users, topRequesters, currentMonth, rangeLabel,
}: {
  f: Fmt;
  users: Awaited<ReturnType<typeof getUserStats>>;
  topRequesters: Awaited<ReturnType<typeof getTopRequesters>>;
  currentMonth: string;
  rangeLabel: string;
}) {
  const { t } = f;
  return (
    <StatsSection id="stats-users" title={t("adminManage.stats.users")}>
      <MetricGrid
        columns="grid-cols-2 sm:grid-cols-4"
        items={[
          { label: t("adminManage.stats.activeUsers"), value: f.num(users.active) },
          { label: t("adminManage.stats.seenLast30Label"), value: f.num(users.seenLast30Days) },
          { label: t("adminManage.stats.requesters"), value: f.num(users.requesters), hint: rangeLabel },
          { label: t("adminManage.stats.disabledUsers"), value: f.num(users.disabled) },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 24, marginTop: 20 }}>
        <div>
          <SubHeading>{t("adminManage.stats.topRequesters")} · {rangeLabel}</SubHeading>
          <RankList
            emptyLabel={t("adminManage.stats.noData")}
            rows={topRequesters.map((u) => ({
              key: u.id,
              label: `${u.name ?? u.email}${u.disabled ? ` (${t("adminManage.stats.disabled")})` : ""}`,
              value: t("adminManage.stats.requestCount", { count: u.count }),
              detail: t("adminManage.stats.requesterDetail", { available: f.num(u.available), declined: f.num(u.declined) }),
            }))}
          />
        </div>
        <div>
          <SubHeading>{t("adminManage.stats.newUsers")}</SubHeading>
          <MonthChart
            months={users.newByMonth.map((m) => m.month)}
            series={[{ key: "users", label: t("adminManage.stats.newUsers"), color: "var(--ds-accent)", values: users.newByMonth.map((m) => m.count) }]}
            locale={f.locale}
            currentMonth={currentMonth}
            ariaLabel={t("adminManage.stats.newUsers")}
            partialLabel={t("adminManage.stats.monthInProgress")}
            monthHeader={t("adminManage.stats.month")}
            formatNumber={f.num}
            height={80}
          />
        </div>
      </div>
    </StatsSection>
  );
}

function LibrarySection({
  f, library, growth, currentMonth,
}: {
  f: Fmt;
  library: Awaited<ReturnType<typeof getLibraryStats>>;
  growth: Awaited<ReturnType<typeof getLibraryGrowth>>;
  currentMonth: string;
}) {
  const { t } = f;
  const services = (["plex", "jellyfin"] as const).filter((s) => {
    const p = library.perService[s];
    return p.movies + p.series + p.episodes > 0;
  });
  if (services.length === 0) return null;
  const multiServer = library.servers.length > services.length;
  return (
    <StatsSection id="stats-library" title={t("adminManage.stats.library")} subtitle={t("adminManage.stats.currentState")}>
      <MetricGrid
        columns="grid-cols-2 sm:grid-cols-3"
        items={[
          { label: t("adminManage.stats.uniqueTitles"), value: f.num(library.unique.movies + library.unique.series), hint: t("adminManage.stats.uniqueTitlesHint") },
          { label: t("nav.movies"), value: f.num(library.unique.movies) },
          { label: t("adminManage.stats.series"), value: f.num(library.unique.series) },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 16, marginTop: 18 }}>
        {services.map((s) => {
          const p = library.perService[s];
          const servers = library.servers.filter((x) => x.service === s);
          return (
            <div
              key={s}
              style={{ padding: 16, background: "var(--ds-bg-3)", border: "1px solid var(--ds-border)", borderRadius: 8 }}
            >
              <SubHeading>{s === "plex" ? "Plex" : "Jellyfin"}</SubHeading>
              <MetricGrid
                columns="grid-cols-3"
                items={[
                  { label: t("nav.movies"), value: f.num(p.movies) },
                  { label: t("adminManage.stats.series"), value: f.num(p.series) },
                  { label: t("adminManage.stats.episodes"), value: f.num(p.episodes) },
                ]}
              />
              {multiServer && servers.length > 1 && (
                <div style={{ marginTop: 14 }}>
                  <RankList
                    emptyLabel=""
                    rows={servers.map((x) => ({
                      key: x.slug || "default",
                      label: x.slug ? x.name : t("adminManage.stats.defaultInstance"),
                      value: t("adminManage.stats.moviesSeries", { movies: f.num(x.movies), series: f.num(x.series) }),
                    }))}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 20 }}>
        <SubHeading>{t("adminManage.stats.libraryGrowth")}</SubHeading>
        <MonthChart
          months={growth.map((g) => g.month)}
          series={[
            { key: "movies", label: t("nav.movies"), color: MEDIA_COLOR.MOVIE, values: growth.map((g) => g.movies) },
            { key: "series", label: t("adminManage.stats.series"), color: MEDIA_COLOR.TV, values: growth.map((g) => g.series) },
          ]}
          locale={f.locale}
          currentMonth={currentMonth}
          ariaLabel={t("adminManage.stats.libraryGrowth")}
          partialLabel={t("adminManage.stats.monthInProgress")}
          monthHeader={t("adminManage.stats.month")}
          formatNumber={f.num}
          height={90}
        />
        <StatsNote>{t("adminManage.stats.libraryGrowthHint")}</StatsNote>
      </div>
    </StatsSection>
  );
}

function IssuesSection({
  f, issues, oldestIssueDays, unresolved, rangeLabel,
}: {
  f: Fmt;
  issues: Awaited<ReturnType<typeof getIssueStats>>;
  oldestIssueDays: number | null;
  unresolved: number;
  rangeLabel: string;
}) {
  const { t } = f;
  return (
    <StatsSection
      id="stats-issues"
      title={t("adminManage.stats.issues")}
      right={
        <Link href="/admin/issues" className="text-sm hover:underline" style={{ color: "var(--ds-accent-text)" }}>
          {t("adminManage.stats.openIssuesLink")}
        </Link>
      }
    >
      <MetricGrid
        columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
        items={[
          { label: t("adminManage.stats.openIssues"), value: f.num(issues.open), tone: issues.open > 0 ? "warning" : undefined },
          { label: t("adminManage.stats.inProgress"), value: f.num(issues.inProgress) },
          { label: t("adminManage.stats.unclaimed"), value: f.num(issues.unclaimed) },
          { label: t("adminManage.stats.noAdminReply"), value: f.num(issues.noAdminReply), tone: issues.noAdminReply > 0 ? "warning" : undefined },
          {
            label: t("adminManage.stats.oldestOpen"),
            value: oldestIssueDays === null ? "—" : t("adminManage.stats.daysShort", { count: oldestIssueDays }),
          },
          {
            label: t("adminManage.stats.timeToResolve"),
            value: f.duration(issues.resolve.medianSeconds),
            hint: issues.resolve.count > 0 ? t90(f, issues.resolve, "issues") : t("adminManage.stats.noData"),
          },
        ]}
      />
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 24, marginTop: 20 }}>
        <div>
          <SubHeading>{t("adminManage.stats.backlogByType")}</SubHeading>
          {unresolved > 0 ? (
            <ShareBar
              ariaLabel={t("adminManage.stats.backlogByType")}
              formatNumber={f.num}
              parts={issues.backlogByType.map((b, i) => ({
                label: t(ISSUE_TYPE_LABEL_KEY[b.type] ?? "personal.issues.type.other"),
                value: b.count,
                color: ISSUE_COLORS[i % ISSUE_COLORS.length],
              }))}
            />
          ) : (
            <p style={{ fontSize: 13, color: "var(--ds-fg-subtle)", margin: 0 }}>{t("adminManage.stats.noOpenIssues")}</p>
          )}
        </div>
        <div>
          <SubHeading>{rangeLabel}</SubHeading>
          <MetricGrid
            columns="grid-cols-2"
            items={[
              { label: t("adminManage.stats.issuesReported"), value: f.num(issues.createdInRange) },
              { label: t("adminManage.stats.issuesResolved"), value: f.num(issues.resolvedInRange) },
            ]}
          />
          <StatsNote>{t("adminManage.stats.timeToResolveHint")}</StatsNote>
        </div>
      </div>
    </StatsSection>
  );
}

const ISSUE_COLORS = ["var(--ds-danger)", "var(--ds-warning)", "var(--ds-info)", "var(--ds-accent)", "var(--ds-success)"];

function VotesSection({ f, votes }: { f: Fmt; votes: Awaited<ReturnType<typeof getTopDeletionVotes>> }) {
  const { t } = f;
  if (votes.total === 0) return null;
  return (
    <StatsSection
      id="stats-votes"
      title={t("adminManage.stats.deletionVotes")}
      subtitle={
        votes.threshold > 0
          ? t("adminManage.stats.voteThreshold", { count: votes.threshold })
          : t("adminManage.stats.noVoteThreshold")
      }
      right={
        <Link href="/votes" className="text-sm hover:underline" style={{ color: "var(--ds-accent-text)" }}>
          {t("adminManage.stats.allVotesLink")}
        </Link>
      }
    >
      <RankList
        emptyLabel=""
        rows={votes.titles.map((v) => ({
          key: `${v.mediaType}:${v.tmdbId}`,
          label: v.title,
          href: mediaHref(v.mediaType, v.tmdbId),
          value: t("adminManage.stats.voteCount", { count: v.votes }),
        }))}
      />
    </StatsSection>
  );
}

// ─── Slow sections (streamed) ─────────────────────────────────────────────────

function SlowSectionFallback({ title, label }: { title: string; label: string }) {
  return (
    <StatsSection title={title}>
      <div className="animate-pulse" role="status" aria-label={label}>
        <div style={{ height: 14, width: "40%", background: "var(--ds-bg-3)", borderRadius: 4, marginBottom: 10 }} />
        <div style={{ height: 6, background: "var(--ds-bg-3)", borderRadius: 999, marginBottom: 16 }} />
        <div style={{ height: 14, width: "30%", background: "var(--ds-bg-3)", borderRadius: 4, marginBottom: 10 }} />
        <div style={{ height: 6, background: "var(--ds-bg-3)", borderRadius: 999 }} />
      </div>
    </StatsSection>
  );
}

// Live Radarr/Sonarr calls. Streamed behind a Suspense boundary so one slow or
// unreachable instance (30 s timeout) no longer holds the whole page blank.
async function StorageSection({ f }: { f: Fmt }) {
  const { t } = f;
  const storage = await getStorageStats();
  // One down instance fails both calls; say so once.
  const reported = new Set(storage.unreachable.map((u) => `${u.service}:${u.slug}`));
  const listingErrors = storage.listingErrors.filter((e) => !reported.has(`${e.service}:${e.slug}`));
  const hasAnything =
    storage.disks.length > 0 || storage.libraries.length > 0 || storage.unreachable.length > 0 || storage.listingErrors.length > 0;
  if (!hasAnything) return null;
  return (
    <StatsSection
      id="stats-storage"
      title={t("adminManage.stats.storage")}
      subtitle={t("adminManage.stats.storageCached")}
    >
      <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 24 }}>
        <div>
          <SubHeading>{t("adminManage.stats.diskSpace")}</SubHeading>
          {storage.disks.map((d) => (
            <Meter
              key={`${d.path}:${d.totalSpace}`}
              label={d.label}
              pct={d.usedPct}
              detail={t("adminManage.stats.diskUsed", {
                used: f.bytes(d.totalSpace - d.freeSpace),
                total: f.bytes(d.totalSpace),
              })}
              valueText={t("adminManage.stats.diskFree", { free: f.bytes(d.freeSpace) })}
              sub={`${t("adminManage.stats.diskFree", { free: f.bytes(d.freeSpace) })} · ${d.reportedBy.join(", ")}`}
            />
          ))}
          {storage.unreachable.map((u) => (
            <StatsNote key={`${u.service}:${u.slug}`} tone="warning">
              {t("adminManage.stats.unreachable", { name: u.label })}
            </StatsNote>
          ))}
        </div>
        <div>
          <SubHeading>{t("adminManage.stats.librarySize")}</SubHeading>
          <RankList
            emptyLabel={t("adminManage.stats.noData")}
            rows={storage.libraries.map((l) => ({
              key: `${l.service}:${l.slug}`,
              label: l.name,
              value: f.bytes(l.bytes),
              detail: t("adminManage.stats.titleCount", { count: l.titles }),
            }))}
          />
          {listingErrors.map((e) => (
            <StatsNote key={`${e.service}:${e.slug}`} tone="warning">
              {t("adminManage.stats.unreachable", { name: e.name })}
            </StatsNote>
          ))}
          {storage.reclaimable && (
            <div style={{ marginTop: 16 }}>
              <SubHeading>{t("adminManage.stats.reclaimable")}</SubHeading>
              <p style={{ fontSize: 13, color: "var(--ds-fg)", margin: 0 }}>
                {storage.reclaimable.titles === 0
                  ? t("adminManage.stats.reclaimableNone")
                  : t("adminManage.stats.reclaimableValue", {
                      size: f.bytes(storage.reclaimable.bytes),
                      count: storage.reclaimable.titles,
                      value: f.num(storage.reclaimable.titles),
                    })}{" "}
                <Link href="/admin/cleanup" className="hover:underline" style={{ color: "var(--ds-accent-text)" }}>
                  {t("adminManage.stats.reviewCleanup")}
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>
    </StatsSection>
  );
}

async function WatchGradesSection({ f }: { f: Fmt }) {
  const { t } = f;
  const spread = await getWatchGradeSpreadForStats().catch((err) => {
    console.warn("[admin-stats] watch-grade spread failed:", err instanceof Error ? err.message : err);
    return null;
  });
  if (!spread) return null;
  const graded = spread.A + spread.B + spread.C + spread.D + spread.F;
  return (
    <StatsSection
      id="stats-grades"
      title={t("adminManage.stats.watchGrades")}
      subtitle={t("adminManage.stats.watchGradesHint")}
      right={
        <Link href="/admin/users" className="text-sm hover:underline" style={{ color: "var(--ds-accent-text)" }}>
          {t("adminManage.stats.usersLink")}
        </Link>
      }
    >
      <ShareBar
        ariaLabel={t("adminManage.stats.watchGrades")}
        formatNumber={f.num}
        parts={[
          { label: "A", value: spread.A, color: "var(--ds-success)" },
          { label: "B", value: spread.B, color: "var(--ds-info)" },
          { label: "C", value: spread.C, color: "var(--ds-accent)" },
          { label: "D", value: spread.D, color: "var(--ds-warning)" },
          { label: "F", value: spread.F, color: "var(--ds-danger)" },
        ]}
      />
      <StatsNote>{t("adminManage.stats.notGradedCount", { count: spread.notGraded, value: f.num(spread.notGraded), graded: f.num(graded) })}</StatsNote>
    </StatsSection>
  );
}

