"use client";

// Per-user activity screen, fed by getUserPlayStats(). Relative-time labels
// wait for useHasMounted (guardrail 16): the server renders an absolute date,
// and the browser swaps in "Xd ago" once the page has hydrated.

import Link from "next/link";
import { useHasMounted } from "@/hooks/use-has-mounted";
import { formatRelativeTimeLocalized } from "@/lib/relative-time";
import { useLocale, useT } from "@/components/i18n/i18n-provider";
import { IpInfo } from "@/components/admin/ip-info";
import { Badge } from "@/components/ui/badge";
import { Chip } from "@/components/ui/design";
import {
  ActivityCard,
  AreaChart,
  Avatar,
  DetailHeader,
  HorizontalBars,
  HourHeatmap,
  Poster,
  SectionHeader,
  SourceTag,
  StreamTypeBars,
  MiniKpi,
  Th,
  fmtDuration,
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
  todayIso: string;
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
  knownIps: { ip: string; plays: number; lastSeenIso: string | null }[];
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

// `labelKey` is a catalog key, translated at render.
const STREAM_META: Record<string, { labelKey: string; color: string }> = {
  DirectPlay: { labelKey: "adminActivity.method.directPlay", color: "var(--ds-success)" },
  DirectStream: { labelKey: "adminActivity.method.remux", color: "var(--ds-info)" },
  Transcode: { labelKey: "adminActivity.method.transcode", color: "var(--ds-warning)" },
};

function absTime(iso: string, locale: string): string {
  // Pin to UTC so the server (container time zone) and the browser (user time
  // zone) print the same date. Otherwise a play near midnight could render as
  // different days and cause a React #418 hydration mismatch.
  return new Date(iso).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function UserDetailView({ data: s }: { data: UserDetailData }) {
  const mounted = useHasMounted();
  const t = useT();
  const locale = useLocale();
  const when = (iso: string | null) =>
    !iso ? "—" : mounted ? formatRelativeTimeLocalized(iso, locale) : absTime(iso, locale);

  // Postgres day-of-week is 0=Sun..6=Sat; the heatmap rows start on Monday,
  // so (dow + 6) % 7 shifts Sunday to the last row.
  const heatmapMatrix: number[][] = Array.from({ length: 7 }, () =>
    new Array<number>(24).fill(0),
  );
  for (const c of s.userHeatmap) {
    if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
      heatmapMatrix[(c.dow + 6) % 7][c.hour] = c.count;
    }
  }

  const streamTypes = ["DirectPlay", "DirectStream", "Transcode"].map((m) => ({
    label: t(STREAM_META[m].labelKey),
    count: s.transcodeRatio.find((r) => r.method === m)?.count ?? 0,
    color: STREAM_META[m].color,
  }));

  const playsByDay = s.playsByDay.map((d) => d.count);
  // Floor at 1 so a zero count can't divide by zero (NaN bar widths).
  const maxTopMedia = Math.max(s.topMedia[0]?.count ?? 1, 1);

  return (
    <div className="ds-page-enter">
      <DetailHeader
        back={{ href: "/admin/activity/users", label: t("adminActivity.user.backToUsers") }}
        leading={
          <Avatar
            letter={(s.username[0] ?? "?").toUpperCase()}
            accent="oklch(0.42 0.10 275)"
            size={48}
          />
        }
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
            {s.manualUserLink && (
              <Chip className="ml-2 align-middle">{t("adminManage.serverUsers.pinned")}</Chip>
            )}
          </>
        }
      />

      <div
        className="resp-grid-3"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <MiniKpi
          label={t("adminActivity.user.totalPlays")}
          value={s.totalPlays.toLocaleString(locale)}
          big
        />
        <MiniKpi
          label={t("adminActivity.kpi.watchTime")}
          value={t("adminActivity.common.hoursShort", {
            n: s.totalWatchTimeHours.toLocaleString(locale, { maximumFractionDigits: 1 }),
          })}
          big
        />
        <MiniKpi label={t("adminActivity.user.lastActive")} value={when(s.lastActiveIso)} />
        <MiniKpi
          label={t("adminActivity.user.avgSession")}
          value={fmtDuration(s.avgSessionDuration)}
        />
        <MiniKpi
          label={t("adminActivity.user.directPlay")}
          value={s.directPct != null ? `${s.directPct}%` : "—"}
          big
        />
      </div>

      {s.activityCalendar.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.calendar.title")}
              sub={t("adminActivity.user.activeDays", { count: s.activityCalendar.filter((v) => v.count > 0).length })}
            />
            <ActivityCalendar
              data={s.activityCalendar}
              today={s.todayIso}
              detailBase={{ userId: s.userId }}
            />
          </ActivityCard>
        </div>
      )}

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "1.2fr 1fr",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.playsPerDay90")}
            sub={t("adminActivity.user.peakPlays", { count: Math.max(...playsByDay, 0) })}
          />
          <AreaChart
            data={playsByDay}
            h={130}
            labels={s.playsByDay.map((d) => absTime(`${d.day}T00:00:00Z`, locale))}
            valueSuffix={t("adminActivity.common.playsSuffix")}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.user.viewingHeatmap")} sub={t("adminActivity.user.dayHour")} />
          <HourHeatmap matrix={heatmapMatrix} detailBase={{ userId: s.userId }} />
        </ActivityCard>
      </div>

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, 1fr)",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.title.platforms")}
            sub={t("adminActivity.title.unique", { count: s.platformBreakdown.length })}
          />
          <HorizontalBars
            items={s.platformBreakdown
              .slice(0, 6)
              .map((p) => ({ label: p.platform, count: p.count }))}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.title.streamType")} sub={t("adminActivity.title.playMethodMix")} />
          <StreamTypeBars data={streamTypes} />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader label={t("adminActivity.title.resolutions")} />
          <HorizontalBars
            items={s.resolutionBreakdown.map((r) => ({
              label: r.resolution,
              count: r.count,
            }))}
            color="oklch(0.68 0.16 158)"
            labelWidth={70}
          />
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.user.devices")}
            sub={t("adminActivity.user.known", { count: s.deviceList.length })}
          />
          <HorizontalBars
            items={s.deviceList
              .slice(0, 6)
              .map((d) => ({ label: d.device, count: d.count }))}
            color="oklch(0.62 0.14 295)"
            labelWidth={100}
          />
        </ActivityCard>
      </div>

      {s.topMedia.length > 0 && (
        <div style={{ marginBottom: 22 }}>
          <ActivityCard>
            <SectionHeader
              label={t("adminActivity.user.mostWatched")}
              sub={t("adminActivity.user.titles", { count: s.topMedia.length })}
            />
            <div
              style={{ display: "flex", flexDirection: "column", gap: 8 }}
            >
              {s.topMedia.map((m, i) => (
                <div
                  key={`${m.title}-${i}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span
                    className="ds-mono"
                    style={{
                      width: 16,
                      textAlign: "right",
                      fontSize: 10.5,
                      color: "var(--ds-fg-subtle)",
                    }}
                  >
                    {(i + 1).toString().padStart(2, "0")}
                  </span>
                  <Poster
                    src={m.posterSrc}
                    letter={(m.title[0] ?? "?").toUpperCase()}
                    w={28}
                    h={40}
                    radius={3}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        marginBottom: 3,
                        gap: 8,
                      }}
                    >
                      {m.tmdbId ? (
                        <Link
                          href={`/admin/activity/media/${m.tmdbId}${m.mediaType ? `?type=${m.mediaType}` : ""}`}
                          style={{
                            fontSize: 13,
                            color: "var(--ds-fg)",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            textDecoration: "none",
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {m.title}
                          </span>
                          {m.mediaType && (
                            <span
                              className="ds-mono"
                              style={{
                                fontSize: 9,
                                color: "var(--ds-fg-subtle)",
                                letterSpacing: "0.06em",
                                flexShrink: 0,
                              }}
                            >
                              {m.mediaType}
                            </span>
                          )}
                        </Link>
                      ) : (
                        <span
                          style={{
                            fontSize: 13,
                            color: "var(--ds-fg)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {m.title}
                        </span>
                      )}
                      <span
                        className="ds-mono"
                        style={{
                          fontSize: 11,
                          color: "var(--ds-fg-muted)",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
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
                      <div
                        style={{
                          width: `${(m.count / maxTopMedia) * 100}%`,
                          height: "100%",
                          background: "var(--ds-accent)",
                          borderRadius: 999,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ActivityCard>
        </div>
      )}

      <div
        className="resp-grid-2"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 10,
          marginBottom: 22,
        }}
      >
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.user.knownIps")}
            sub={t("adminActivity.user.uniqueIps", { count: s.knownIps.length })}
          />
          {s.knownIps.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--ds-fg-subtle)",
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              {t("adminActivity.user.noIpData")}
            </div>
          ) : (
            // Scroll container, like the history/title tables: every cell is
            // nowrap, and at 375px the one-column grid leaves ~307px of card.
            // `minWidth: 0` overrides .resp-table-scroll's 760px table floor,
            // which is sized for the ten-column history table.
            <div className="resp-table-scroll">
            <table
              style={{
                width: "100%",
                minWidth: 0,
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th label={t("adminActivity.field.ipAddress")} />
                  <Th label={t("adminActivity.stat.plays")} align="right" />
                  <Th label={t("adminActivity.user.lastSeen")} align="right" />
                </tr>
              </thead>
              <tbody>
                {s.knownIps.map((ip) => (
                  <tr
                    key={ip.ip}
                    style={{ borderBottom: "1px solid var(--ds-border)" }}
                  >
                    <td style={{ padding: "9px 11px" }}>
                      <IpInfo ip={ip.ip} />
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-muted)",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {ip.plays}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-subtle)",
                        textAlign: "right",
                      }}
                    >
                      {when(ip.lastSeenIso)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </ActivityCard>
        <ActivityCard>
          <SectionHeader
            label={t("adminActivity.recentPlays.title")}
            sub={t("adminActivity.user.lastN", { count: s.recentPlays.length })}
          />
          {s.recentPlays.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--ds-fg-subtle)",
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              {t("adminActivity.title.noPlays")}
            </div>
          ) : (
            <div className="resp-table-scroll">
            <table
              style={{
                width: "100%",
                minWidth: 0,
                borderCollapse: "collapse",
                fontSize: 12.5,
              }}
            >
              <thead>
                <tr>
                  <Th label={t("adminActivity.field.title")} />
                  <Th label={t("adminActivity.field.quality")} />
                  <Th label={t("adminActivity.field.when")} align="right" />
                </tr>
              </thead>
              <tbody>
                {s.recentPlays.map((p, i) => (
                  <tr
                    key={p.id}
                    style={{
                      borderBottom:
                        i < s.recentPlays.length - 1
                          ? "1px solid var(--ds-border)"
                          : "none",
                    }}
                  >
                    <td style={{ padding: "9px 11px" }}>
                      {p.tmdbId ? (
                        <Link
                          href={`/admin/activity/media/${p.tmdbId}${p.mediaType ? `?type=${p.mediaType}` : ""}`}
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
                        <span style={{ color: "var(--ds-fg)" }}>
                          {p.title}
                        </span>
                      )}
                      {p.mediaType === "TV" && p.seasonNumber != null && (
                        <span
                          className="ds-mono"
                          style={{
                            fontSize: 10,
                            color: "var(--ds-fg-subtle)",
                          }}
                        >
                          S{String(p.seasonNumber).padStart(2, "0")} · E
                          {String(p.episodeNumber ?? 0).padStart(2, "0")}
                        </span>
                      )}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-subtle)",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {p.resolution ?? "—"}
                      {p.videoCodec && (
                        <span style={{ color: "var(--ds-fg-subtle)" }}>
                          {" "}
                          · {p.videoCodec}
                        </span>
                      )}
                    </td>
                    <td
                      className="ds-mono"
                      style={{
                        padding: "9px 11px",
                        color: "var(--ds-fg-subtle)",
                        textAlign: "right",
                        fontSize: 11,
                        whiteSpace: "nowrap",
                      }}
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
      </div>
    </div>
  );
}
