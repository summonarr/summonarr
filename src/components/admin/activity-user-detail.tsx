"use client";

// Per-user activity screen, fed by getUserPlayStats(). Relative-time labels
// wait for useHasMounted (guardrail 16): the server renders an absolute date,
// and the browser swaps in "Xd ago" once the page has hydrated.

import { useMemo, type CSSProperties } from "react";
import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { episodeLabel } from "@/lib/episode-label";
import { foldStreamMethods } from "@/lib/activity-stream-mix";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { IpInfo } from "@/components/admin/ip-info";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui/design";
import {
  ActivityCard,
  ActivityGrid,
  AreaChart,
  Avatar,
  DetailHeader,
  Empty,
  HorizontalBars,
  HourHeatmap,
  Poster,
  SectionHeader,
  SourceTag,
  StreamTypeBars,
  MiniKpi,
  Th,
  ZoneTag,
  fmtDuration,
  streamTypeSegments,
  toHeatmapMatrix,
  utcShortDayFormatter,
} from "@/components/admin/activity-ui";
import { ActivityCalendar } from "@/components/admin/activity-calendar";

export interface UserDetailData {
  userId: string; // mediaServerUserId — scopes the heatmap drill-down popovers
  username: string;
  source: string;
  linkedLabel: string | null;
  email: string | null;
  // false = soft-deleted from the media server; history is kept by design
  // (guardrail 28), so the page still renders and says so.
  active: boolean;
  // An admin pinned the account binding by hand (incl. a pin to nobody), so
  // the poller's automatic resolution skips this row (guardrail 34).
  manualUserLink: boolean;
  totalPlays: number;
  totalWatchTimeHours: number;
  avgSessionDuration: number;
  directPct: number | null;
  lastActiveIso: string | null;
  activityCalendar: { day: string; count: number }[];
  // The statistics zone's today (zonedTodayIso) and the zone itself: the
  // calendar, the daily series and the heatmap are bucketed in it.
  todayIso: string;
  timeZone: string;
  playsByDay: { day: string; count: number; hours: number }[];
  userHeatmap: { dow: number; hour: number; count: number }[];
  platformBreakdown: { platform: string; count: number }[];
  resolutionBreakdown: { resolution: string; count: number }[];
  deviceList: { device: string; count: number }[];
  transcodeRatio: { method: string; count: number }[];
  topMedia: {
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    count: number;
    posterSrc: string | null;
  }[];
  // The most recently seen addresses (capped by the page); knownIpTotal counts
  // every distinct one, so the "N unique" label stays true past the cap.
  knownIps: { ip: string; plays: number; lastSeenIso: string | null }[];
  knownIpTotal?: number;
  recentPlays: {
    id: string;
    title: string;
    tmdbId: number | null;
    mediaType: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    resolution: string | null;
    videoCodec: string | null;
    startedAtIso: string;
  }[];
}

type When = (iso: string | null) => string;

// The title page for a play's title, typed when the type is known.
function activityMediaHref(tmdbId: number, mediaType: string | null): string {
  return `/admin/activity/media/${tmdbId}${mediaType ? `?type=${mediaType}` : ""}`;
}

// The two side tables' shared shape. `minWidth: 0` overrides
// .resp-table-scroll's 760px table floor, which is sized for the ten-column
// history table: every cell here is nowrap, and at 375px the one-column grid
// leaves ~307px of card, so the table scrolls inside its own container.
const SIDE_TABLE: CSSProperties = { width: "100%", minWidth: 0, borderCollapse: "collapse", fontSize: 12.5 };
const SIDE_CELL: CSSProperties = { padding: "9px 11px" };
const TWO_EQUAL = "repeat(2, minmax(0, 1fr))";
const SECTION_GAP: CSSProperties = { marginBottom: 22 };

export function UserDetailView({ data: s }: { data: UserDetailData }) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  // UTC-pinned "May 13": the text before mount, and the chart's day labels.
  const shortDay = useMemo(() => utcShortDayFormatter(locale), [locale]);
  const when: When = (iso) =>
    !iso ? "—" : mounted ? formatRelativeTimeLocalized(iso, locale) : shortDay(iso);

  // Any other method the server recorded is one "Other" segment, as on the
  // Stats tab, so the shares divide by every session.
  const streamMix = foldStreamMethods(s.transcodeRatio);
  const streamTypes = streamTypeSegments(t, streamMix);

  return (
    <div className="ds-page-enter">
      <UserHeader s={s} />
      <UserKpis s={s} when={when} />

      {s.activityCalendar.length > 0 && (
        <div style={SECTION_GAP}>
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.calendar.title")}
              sub={t("adminActivity.user.activeDays", { count: s.activityCalendar.filter((v) => v.count > 0).length })}
            />
            <ActivityCalendar
              data={s.activityCalendar}
              today={s.todayIso}
              timeZone={s.timeZone}
              detailBase={{ userId: s.userId }}
            />
          </ActivityCard>
        </div>
      )}

      <ActivityGrid className="resp-grid-2" columns="minmax(0, 1.2fr) minmax(0, 1fr)" style={SECTION_GAP}>
        <PlaysPerDayCard s={s} shortDay={shortDay} />
        <ActivityCard>
          <SectionHeader label={t("adminActivity.user.viewingHeatmap")} sub={t("adminActivity.user.dayHour")} />
          <HourHeatmap matrix={toHeatmapMatrix(s.userHeatmap)} detailBase={{ userId: s.userId }} timeZone={s.timeZone} />
        </ActivityCard>
      </ActivityGrid>

      <ActivityGrid className="resp-grid-2" columns={TWO_EQUAL} style={SECTION_GAP}>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.platforms")}
            sub={t("adminActivity.title.unique", { count: s.platformBreakdown.length })}
          />
          <HorizontalBars items={s.platformBreakdown.slice(0, 6).map((p) => ({ label: p.platform, count: p.count }))} />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.title.streamType")} sub={t("adminActivity.title.playMethodMix")} />
          <StreamTypeBars data={streamTypes} />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.title.resolutions")} />
          <HorizontalBars
            items={s.resolutionBreakdown.map((r) => ({ label: r.resolution, count: r.count }))}
            color="var(--ds-chart-2)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.user.devices")}
            sub={t("adminActivity.user.known", { count: s.deviceList.length })}
          />
          <HorizontalBars
            items={s.deviceList.slice(0, 6).map((d) => ({ label: d.device, count: d.count }))}
            color="var(--ds-chart-3)"
            labelWidth={100}
          />
        </ActivityCard>
      </ActivityGrid>

      {s.topMedia.length > 0 && (
        <div style={SECTION_GAP}>
          <TopMediaCard topMedia={s.topMedia} />
        </div>
      )}

      <ActivityGrid className="resp-grid-2" columns={TWO_EQUAL} style={SECTION_GAP}>
        <KnownIpsCard s={s} when={when} />
        <RecentPlaysCard plays={s.recentPlays} when={when} />
      </ActivityGrid>
    </div>
  );
}

function UserHeader({ s }: { s: UserDetailData }) {
  const t = useT();
  return (
    <DetailHeader
      back={{ href: "/admin/activity/users", label: t("adminActivity.user.backToUsers") }}
      leading={<Avatar letter={(s.username[0] ?? "?").toUpperCase()} accent="oklch(0.42 0.10 275)" size={48} />}
      title={s.username}
      meta={
        <>
          <SourceTag source={s.source} />
          {!s.active && (
            <Badge
              className="border-zinc-700 bg-zinc-800 text-zinc-400 text-[10px] shrink-0"
              title={t("adminManage.serverUsers.departedTitle")}
            >
              {t("adminManage.serverUsers.departed")}
            </Badge>
          )}
        </>
      }
      subtitle={
        <>
          {[s.email, s.linkedLabel].filter(Boolean).join(" · ") ||
            t("adminActivity.user.sourceAccount", { source: s.source })}
          {s.manualUserLink && <Chip className="ml-2 align-middle">{t("adminManage.serverUsers.pinned")}</Chip>}
        </>
      }
    />
  );
}

function UserKpis({ s, when }: { s: UserDetailData; when: When }) {
  const t = useT();
  const locale = useLocale();
  return (
    <ActivityGrid className="resp-grid-3" columns="repeat(5, minmax(0, 1fr))" style={SECTION_GAP}>
      <MiniKpi label={t("adminActivity.user.totalPlays")} value={s.totalPlays.toLocaleString(locale)} />
      <MiniKpi
        label={t("adminActivity.kpi.watchTime")}
        value={t("adminActivity.common.hoursShort", {
          n: s.totalWatchTimeHours.toLocaleString(locale, { maximumFractionDigits: 1 }),
        })}
      />
      <MiniKpi label={t("adminActivity.user.lastActive")} value={when(s.lastActiveIso)} />
      <MiniKpi label={t("adminActivity.user.avgSession")} value={fmtDuration(s.avgSessionDuration, locale)} />
      <MiniKpi label={t("adminActivity.user.directPlay")} value={s.directPct != null ? `${s.directPct}%` : "—"} />
    </ActivityGrid>
  );
}

// The daily series is counted in the statistics zone, named beside it (19g).
function PlaysPerDayCard({ s, shortDay }: { s: UserDetailData; shortDay: (isoOrDay: string) => string }) {
  const t = useT();
  const counts = useMemo(() => s.playsByDay.map((d) => d.count), [s.playsByDay]);
  const labels = useMemo(() => s.playsByDay.map((d) => shortDay(d.day)), [s.playsByDay, shortDay]);
  return (
    <ActivityCard>
      <SectionHeader
        label={t("adminActivity.title.playsPerDay90")}
        sub={t("adminActivity.user.peakPlays", { count: Math.max(...counts, 0) })}
        right={<ZoneTag zone={s.timeZone} title={t("adminActivity.stats.zoneDaysTitle", { zone: s.timeZone })} />}
      />
      <AreaChart data={counts} h={130} labels={labels} valueSuffix={t("adminActivity.common.playsSuffix")} />
    </ActivityCard>
  );
}

function TopMediaCard({ topMedia }: { topMedia: UserDetailData["topMedia"] }) {
  const t = useT();
  // Floor at 1 so a zero count can't divide by zero (NaN bar widths).
  const max = Math.max(topMedia[0]?.count ?? 1, 1);
  return (
    <ActivityCard>
      <SectionHeader label={t("adminActivity.user.mostWatched")} sub={t("adminActivity.user.titles", { count: topMedia.length })} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {topMedia.map((m, i) => (
          <TopMediaRow key={`${m.title}-${i}`} m={m} rank={i + 1} pct={(m.count / max) * 100} />
        ))}
      </div>
    </ActivityCard>
  );
}

const TOP_TITLE: CSSProperties = {
  fontSize: 13,
  color: "var(--ds-fg)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function TopMediaRow({ m, rank, pct }: { m: UserDetailData["topMedia"][number]; rank: number; pct: number }) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="ds-mono" style={{ width: 16, textAlign: "right", fontSize: 10.5, color: "var(--ds-fg-subtle)" }}>
        {String(rank).padStart(2, "0")}
      </span>
      <Poster src={m.posterSrc} letter={(m.title[0] ?? "?").toUpperCase()} w={28} h={40} radius={3} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3, gap: 8 }}>
          {m.tmdbId ? (
            <Link
              href={activityMediaHref(m.tmdbId, m.mediaType)}
              style={{ ...TOP_TITLE, display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", minWidth: 0 }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{m.title}</span>
              {m.mediaType && (
                <span
                  className="ds-mono"
                  style={{ fontSize: 9, color: "var(--ds-fg-subtle)", letterSpacing: "0.06em", flexShrink: 0 }}
                >
                  {m.mediaType}
                </span>
              )}
            </Link>
          ) : (
            <span style={TOP_TITLE}>{m.title}</span>
          )}
          <span
            className="ds-mono"
            style={{ fontSize: 11, color: "var(--ds-fg-muted)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
          >
            {t("adminActivity.common.plays", { count: m.count })}
          </span>
        </div>
        <div
          style={{
            height: 4,
            background: "color-mix(in oklab, var(--ds-fg) 5%, transparent)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div style={{ width: `${pct}%`, height: "100%", background: "var(--ds-accent)", borderRadius: 999 }} />
        </div>
      </div>
    </div>
  );
}

function KnownIpsCard({ s, when }: { s: UserDetailData; when: When }) {
  const t = useT();
  return (
    <ActivityCard>
      <SectionHeader
        label={t("adminActivity.user.knownIps")}
        sub={t("adminActivity.user.uniqueIps", { count: s.knownIpTotal ?? s.knownIps.length })}
      />
      {s.knownIps.length === 0 ? (
        <Empty description={t("adminActivity.user.noIpData")} />
      ) : (
        <div className="resp-table-scroll">
          <table style={SIDE_TABLE}>
            <thead>
              <tr>
                <Th label={t("adminActivity.field.ipAddress")} />
                <Th label={t("adminActivity.stat.plays")} align="right" />
                <Th label={t("adminActivity.user.lastSeen")} align="right" />
              </tr>
            </thead>
            <tbody>
              {s.knownIps.map((ip) => (
                <tr key={ip.ip} style={{ borderBottom: "1px solid var(--ds-border)" }}>
                  <td style={SIDE_CELL}>
                    <IpInfo ip={ip.ip} />
                  </td>
                  <td
                    className="ds-mono"
                    style={{ ...SIDE_CELL, color: "var(--ds-fg-muted)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {ip.plays}
                  </td>
                  <td className="ds-mono" style={{ ...SIDE_CELL, color: "var(--ds-fg-subtle)", textAlign: "right" }}>
                    {when(ip.lastSeenIso)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ActivityCard>
  );
}

function RecentPlaysCard({ plays, when }: { plays: UserDetailData["recentPlays"]; when: When }) {
  const t = useT();
  return (
    <ActivityCard>
      <SectionHeader label={t("adminActivity.recentPlays.title")} sub={t("adminActivity.user.lastN", { count: plays.length })} />
      {plays.length === 0 ? (
        <Empty description={t("adminActivity.title.noPlays")} />
      ) : (
        <div className="resp-table-scroll">
          <table style={SIDE_TABLE}>
            <thead>
              <tr>
                <Th label={t("adminActivity.field.title")} />
                <Th label={t("adminActivity.field.quality")} />
                <Th label={t("adminActivity.field.when")} align="right" />
              </tr>
            </thead>
            <tbody>
              {plays.map((p, i) => (
                <tr key={p.id} style={{ borderBottom: i < plays.length - 1 ? "1px solid var(--ds-border)" : "none" }}>
                  <td style={SIDE_CELL}>
                    {p.tmdbId ? (
                      <Link
                        href={activityMediaHref(p.tmdbId, p.mediaType)}
                        style={{
                          color: "var(--ds-fg)",
                          fontSize: 12.5,
                          textDecoration: "none",
                          display: "block",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          maxWidth: 220,
                        }}
                      >
                        {p.title}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--ds-fg)" }}>{p.title}</span>
                    )}
                    {p.mediaType === "TV" && p.seasonNumber != null && (
                      <span className="ds-mono" style={{ fontSize: 10, color: "var(--ds-fg-subtle)" }}>
                        {episodeLabel(p.seasonNumber, p.episodeNumber)}
                      </span>
                    )}
                  </td>
                  <td
                    className="ds-mono"
                    style={{ ...SIDE_CELL, color: "var(--ds-fg-subtle)", fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    {p.resolution ?? "—"}
                    {p.videoCodec && <span style={{ color: "var(--ds-fg-subtle)" }}> · {p.videoCodec}</span>}
                  </td>
                  <td
                    className="ds-mono"
                    style={{ ...SIDE_CELL, color: "var(--ds-fg-subtle)", textAlign: "right", fontSize: 11, whiteSpace: "nowrap" }}
                  >
                    {when(p.startedAtIso)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ActivityCard>
  );
}
