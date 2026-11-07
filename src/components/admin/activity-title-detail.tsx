"use client";

// Per-title activity screen, drawn from getMediaPlayStats(). "2h ago" style
// labels only appear after the page has mounted in the browser (useHasMounted),
// so the server and the first browser render match (guardrail 16).

import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { episodeLabel } from "@/lib/episode-label";
import { foldStreamMethods } from "@/lib/activity-stream-mix";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  DetailHeader,
  Empty,
  HeaderStat,
  HorizontalBars,
  LeaderboardRow,
  MethodPill,
  Poster,
  SectionHeader,
  SourceDot,
  StreamTypeBars,
  Td,
  Th,
  fmtDuration,
  methodLabel,
  streamTypeSegments,
} from "@/components/admin/activity-ui";

export interface TitleDetailData {
  tmdbId: number;
  title: string;
  posterSrc: string | null;
  mediaType: string | null;
  year: string | null;
  totalPlays: number;
  uniqueViewers: number;
  avgCompletion: number;
  // Both derived from the ≤50-row recent-plays sample (any watched status),
  // NOT from the all-time watched-only `totalPlays` — the two populations
  // differ, so never pair them in one label.
  watchedCount: number;
  recentSampleSize: number;
  libraryHref: string;
  topViewers: {
    id: string;
    username: string;
    source: string;
    count: number;
    hours: number;
  }[];
  transcodeRatio: { method: string; count: number }[];
  resolutionBreakdown: { resolution: string; count: number }[];
  platforms: { label: string; count: number }[];
  completionHist: { label: string; count: number }[];
  playsByDay: { day: string; count: number }[];
  recentPlays: {
    id: string;
    username: string;
    userSource: string;
    mediaServerUserId: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    resolution: string | null;
    videoCodec: string | null;
    platform: string | null;
    playMethod: string | null;
    videoDecision: string | null;
    audioDecision: string | null;
    playDuration: number;
    startedAtIso: string;
  }[];
}

// Average completion at or above these reads as healthy ("ok") or middling
// ("info"); anything lower is flagged ("warn").
const COMPLETION_OK_PCT = 75;
const COMPLETION_INFO_PCT = 50;

function completionTone(pct: number): "ok" | "info" | "warn" {
  return pct >= COMPLETION_OK_PCT ? "ok" : pct >= COMPLETION_INFO_PCT ? "info" : "warn";
}

function absTime(iso: string, locale: string): string {
  // Format in UTC so the server (its own time zone) and the browser (the
  // viewer's time zone) print the same date. Otherwise a play near midnight
  // could show different days and cause a React #418 hydration error. This is
  // the text shown before mount, and for the chart's day labels.
  return new Date(iso).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TitleDetailView({ data: s }: { data: TitleDetailData }) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const when = (iso: string) => (mounted ? formatRelativeTimeLocalized(iso, locale) : absTime(iso, locale));
  const accent = "oklch(0.36 0.08 60)";
  const isTV = s.mediaType === "TV";

  // Any other method the server recorded is one "Other" segment, as on the
  // Stats tab, so the shares divide by every session.
  const streamMix = foldStreamMethods(s.transcodeRatio);
  const streamTypes = streamTypeSegments(t, streamMix);
  const pct0 = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const playsByDay = s.playsByDay.map((d) => d.count);
  const maxViewer = s.topViewers[0]?.count ?? 1;

  return (
    <div className="ds-page-enter">
      <DetailHeader
        back={{ href: "/admin/activity", label: t("adminActivity.detail.backToActivity") }}
        leading={
          <Poster
            src={s.posterSrc}
            letter={(s.title[0] ?? "?").toUpperCase()}
            accent={accent}
            w={56}
            h={84}
            radius={5}
          />
        }
        title={s.title}
        meta={
          <span
            className="ds-mono uppercase"
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "var(--ds-fg-subtle)",
              whiteSpace: "nowrap",
            }}
          >
            {isTV ? t("adminActivity.title.tvSeries") : t("adminActivity.title.featureFilm")}
          </span>
        }
        subtitle={`${s.year ? `${s.year} · ` : ""}TMDB ${s.tmdbId} · ${t("adminActivity.title.acrossViewers", { count: s.uniqueViewers })}`}
        right={
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto auto auto",
              gap: 24,
            }}
          >
            <HeaderStat label={t("adminActivity.stat.plays")} value={s.totalPlays.toLocaleString(locale)} />
            <HeaderStat
              label={t("adminActivity.stat.viewers")}
              value={s.uniqueViewers.toLocaleString(locale)}
            />
            <HeaderStat
              label={t("adminActivity.popover.completion")}
              value={pct0.format(s.avgCompletion / 100)}
              tone={completionTone(s.avgCompletion)}
            />
          </div>
        }
      >
        <Link
          href={s.libraryHref}
          className="ds-hover-tint"
          style={{
            fontSize: 12,
            padding: "6px 11px",
            borderRadius: 6,
            background: "var(--ds-bg-3)",
            border: "1px solid var(--ds-border)",
            color: "var(--ds-fg)",
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            whiteSpace: "nowrap",
            textDecoration: "none",
          }}
        >
          {t("adminActivity.title.openInLibrary")}
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M4 3h5v5M9 3l-6 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </Link>
      </DetailHeader>

      <div style={{ marginBottom: 22 }}>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.playsPerDay90")}
            sub={t("adminActivity.title.watchedFully", { watched: s.watchedCount, sample: s.recentSampleSize })}
          />
          <AreaChart
            data={playsByDay}
            h={130}
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00Z`, locale))}
            valueSuffix={t("adminActivity.common.playsSuffix")}
          />
        </ActivityCard>
      </div>

      <div
        className="resp-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.whoWatched")}
            sub={
              s.topViewers.length < s.uniqueViewers
                ? t("adminActivity.title.topOfViewers", { top: s.topViewers.length, n: s.uniqueViewers.toLocaleString(locale) })
                : t("adminActivity.title.viewersN", { count: s.uniqueViewers, n: s.uniqueViewers.toLocaleString(locale) })
            }
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {s.topViewers.map((v, i) => (
              <LeaderboardRow
                key={v.id}
                href={`/admin/activity/user/${v.id}`}
                rank={i + 1}
                avatar={
                  <Avatar
                    letter={(v.username[0] ?? "?").toUpperCase()}
                    size={22}
                  />
                }
                title={v.username}
                source={v.source}
                primary={v.count.toLocaleString(locale)}
                secondary={t("adminActivity.common.hoursShort", { n: v.hours.toLocaleString(locale, { maximumFractionDigits: 1 }) })}
                pct={(v.count / maxViewer) * 100}
              />
            ))}
            {s.topViewers.length === 0 && <Empty description={t("adminActivity.title.noViewers")} />}
          </div>
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.popover.completion")}
            sub={t("adminActivity.title.recentSample")}
          />
          <HorizontalBars
            items={s.completionHist}
            color="var(--ds-success)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.title.streamType")} sub={t("adminActivity.title.playMethodMix")} />
          <StreamTypeBars data={streamTypes} />
        </ActivityCard>
      </div>

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader label={t("adminActivity.title.resolutions")} />
          <HorizontalBars
            items={s.resolutionBreakdown.map((r) => ({
              label: r.resolution,
              count: r.count,
            }))}
            color="var(--ds-chart-2)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.platforms")}
            sub={t("adminActivity.title.unique", { count: s.platforms.length })}
          />
          <HorizontalBars
            items={s.platforms.slice(0, 6)}
            color="var(--ds-chart-3)"
            labelWidth={110}
          />
        </ActivityCard>
      </div>

      <div style={{ marginBottom: 22 }}>
        <ActivityCard style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "16px 18px 12px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              borderBottom: "1px solid var(--ds-border)",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "baseline", gap: 12 }}
            >
              <h2
                style={{
                  margin: 0,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  color: "var(--ds-fg)",
                }}
              >
                {t("adminActivity.title.playHistory")}
              </h2>
              <span
                className="ds-mono"
                style={{ fontSize: 11, color: "var(--ds-fg-subtle)" }}
              >
                {t("adminActivity.title.latestSessions", { count: s.recentPlays.length })}
              </span>
            </div>
          </div>
          <div className="resp-table-scroll">
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr style={{ background: "var(--ds-bg-1)" }}>
                  <Th label={t("adminActivity.field.user")} />
                  {isTV && <Th label={t("adminActivity.field.episode")} />}
                  <Th label={t("adminActivity.field.quality")} />
                  <Th label={t("adminActivity.field.platform")} />
                  <Th label={t("adminActivity.field.stream")} />
                  <Th label={t("adminActivity.field.duration")} align="right" />
                  <Th label={t("adminActivity.field.when")} align="right" />
                </tr>
              </thead>
              <tbody>
                {s.recentPlays.map((p, i) => {
                  const ml = methodLabel(
                    t,
                    p.playMethod,
                    p.videoDecision,
                    p.audioDecision,
                  );
                  return (
                    <tr
                      key={p.id}
                      className="recent-row"
                      style={{
                        borderBottom:
                          i < s.recentPlays.length - 1
                            ? "1px solid var(--ds-border)"
                            : "none",
                      }}
                    >
                      <Td>
                        <Link
                          href={`/admin/activity/user/${p.mediaServerUserId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 8,
                            textDecoration: "none",
                            color: "inherit",
                          }}
                        >
                          <Avatar
                            letter={(p.username[0] ?? "?").toUpperCase()}
                            size={20}
                          />
                          <span style={{ color: "var(--ds-fg)" }}>
                            {p.username}
                          </span>
                          <SourceDot source={p.userSource} size={4} />
                        </Link>
                      </Td>
                      {isTV && (
                        <Td mono color="var(--ds-fg-muted)" fontSize={11}>
                          {episodeLabel(p.seasonNumber, p.episodeNumber) ?? "—"}
                        </Td>
                      )}
                      <Td mono color="var(--ds-fg-muted)">
                        {p.resolution ?? "—"}
                        {p.videoCodec && (
                          <span style={{ color: "var(--ds-fg-subtle)" }}>
                            {" "}
                            · {p.videoCodec}
                          </span>
                        )}
                      </Td>
                      <Td color="var(--ds-fg-muted)">{p.platform ?? "—"}</Td>
                      <Td>
                        <MethodPill method={ml.label} methodClass={ml.cls} />
                      </Td>
                      <Td mono color="var(--ds-fg-muted)" align="right" tabular>
                        {fmtDuration(p.playDuration, locale)}
                      </Td>
                      <Td mono color="var(--ds-fg-subtle)" align="right">
                        {when(p.startedAtIso)}
                      </Td>
                    </tr>
                  );
                })}
                {s.recentPlays.length === 0 && (
                  <tr>
                    <td
                      colSpan={isTV ? 7 : 6}
                      style={{
                        padding: "40px 20px",
                        textAlign: "center",
                        color: "var(--ds-fg-subtle)",
                      }}
                    >
                      {t("adminActivity.title.noPlays")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </ActivityCard>
      </div>
    </div>
  );
}
