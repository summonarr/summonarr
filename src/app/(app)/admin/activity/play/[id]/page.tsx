import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import Link from "next/link";
import { posterUrl } from "@/lib/tmdb-types";
import { User, CheckCircle2, Circle } from "@/components/icons";
// Same card + section-title + detail-header + method-pill primitives the
// user/title detail views and the history table use, so the three Activity
// detail pages share one composition and one vocabulary ("Remux", not
// "Direct Stream (Remux)").
import {
  ActivityCard,
  DetailHeader,
  MethodPill,
  Poster,
  SectionHeader,
  SourceTag,
  fmtBitrate,
  methodLabel,
} from "@/components/admin/activity-ui";
import { DeletePlayButton } from "@/components/admin/delete-play-button";
import { IpInfo } from "@/components/admin/ip-info";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";
import { PlayTimestamp } from "./play-timestamp";

export const dynamic = "force-dynamic";

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function LabeledValue({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-sm text-zinc-200 ${mono ? "tabular-nums font-mono" : ""}`}>{value}</p>
    </div>
  );
}

// The same pill + label rule as the history table and the title page, so one
// play method never has two names across the Activity surfaces.
function PlayMethodBadge({
  method,
  videoDecision,
  audioDecision,
  t,
}: {
  method: string | null;
  videoDecision: string | null;
  audioDecision: string | null;
  t: Translator;
}) {
  if (!method) return <span className="text-zinc-500">—</span>;
  const ml = methodLabel(t, method, videoDecision, audioDecision);
  return <MethodPill method={ml.label} methodClass={ml.cls} />;
}

function DecisionBadge({ decision, t }: { decision: string | null; t: Translator }) {
  if (!decision) return <span className="text-zinc-500">—</span>;
  const isTranscode = decision === "transcode";
  return (
    <MethodPill
      method={isTranscode ? t("adminActivity.method.transcode") : t("adminActivity.method.direct")}
      methodClass={isTranscode ? "warn" : "ok"}
    />
  );
}

export default async function PlayDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await authActive();
  if (!session || !hasPermission(session.user.permissions, Permission.ADMIN)) redirect("/");

  const { id } = await params;
  const t = await getTranslator();

  const play = await prisma.playHistory.findUnique({
    where: { id },
    include: {
      mediaServerUser: {
        select: { id: true, username: true, source: true, thumbUrl: true },
      },
    },
  });

  if (!play) notFound();

  const isTV = (play.mediaType ?? "").toString() === "TV";
  const mediaHref = play.tmdbId
    ? `/admin/activity/media/${play.tmdbId}${play.mediaType ? `?type=${play.mediaType}` : ""}`
    : null;
  const episodeStr = isTV && play.seasonNumber != null
    ? `S${String(play.seasonNumber).padStart(2, "0")}E${String(play.episodeNumber ?? 0).padStart(2, "0")}`
    : null;

  let posterPath: string | null = null;
  if (play.tmdbId) {
    // The play's OWN media type first: TMDB numbers movies and TV separately, so
    // a show can share its id with a cached movie, and findMany has no defined
    // order — first-row-wins rendered whichever of the two came back first.
    const own = `${isTV ? "tv" : "movie"}:${play.tmdbId}:details`;
    const other = `${isTV ? "movie" : "tv"}:${play.tmdbId}:details`;
    const cacheRows = await prisma.tmdbCache.findMany({
      where: { key: { in: [own, other] } },
      select: { key: true, data: true },
    });
    cacheRows.sort((a, b) => (a.key === own ? 0 : 1) - (b.key === own ? 0 : 1));
    for (const row of cacheRows) {
      try {
        const parsed = JSON.parse(row.data) as { posterPath?: string | null; poster_path?: string | null };
        const path = parsed.posterPath ?? parsed.poster_path ?? null;
        if (path) { posterPath = posterUrl(path, "w342"); break; }
      } catch { }
    }
  }

  const playDurationS = play.playDuration;
  const durationS = play.duration;
  const pct = durationS > 0 ? Math.min(Math.round((playDurationS / durationS) * 100), 100) : 0;

  // Mono subtitle line: the episode for a TV play, otherwise the format, then
  // the title's year — the same "<kind> · <year>" shape the title detail uses.
  const subtitle = [
    episodeStr
      ? `${episodeStr}${play.episodeTitle ? ` — ${play.episodeTitle}` : ""}`
      : isTV
        ? t("adminActivity.title.tvSeries")
        : t("adminActivity.title.featureFilm"),
    play.year,
  ]
    .filter(Boolean)
    .join(" · ");
  const poster = (
    <Poster
      src={posterPath}
      letter={(play.title[0] ?? "?").toUpperCase()}
      w={56}
      h={84}
      radius={5}
    />
  );

  return (
    <div className="ds-page-enter">
      <DetailHeader
        back={{ href: "/admin/activity/history", label: t("adminActivity.play.backToHistory") }}
        leading={
          mediaHref ? (
            <Link href={mediaHref} className="block" aria-label={play.title}>
              {poster}
            </Link>
          ) : (
            poster
          )
        }
        title={
          mediaHref ? (
            <Link href={mediaHref} className="hover:text-indigo-400 transition-colors">
              {play.title}
            </Link>
          ) : (
            play.title
          )
        }
        meta={<SourceTag source={play.source} />}
        subtitle={subtitle}
      >
        <div className="flex items-center gap-3 flex-wrap">
          {play.watched ? (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <CheckCircle2 className="w-3.5 h-3.5" /> {t("adminActivity.field.watched")}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-zinc-500">
              <Circle className="w-3.5 h-3.5" /> {t("adminActivity.play.notWatched")}
            </span>
          )}
          <span className="text-xs text-zinc-500">{t("adminActivity.play.pctComplete", { pct })}</span>
        </div>
      </DetailHeader>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <ActivityCard>
          <SectionHeader label={t("adminActivity.play.playback")} />
          <div className="space-y-3">
            <LabeledValue
              label={t("adminActivity.field.started")}
              value={<PlayTimestamp iso={play.startedAt.toISOString()} />}
            />
            <LabeledValue
              label={t("adminActivity.field.stopped")}
              value={<PlayTimestamp iso={play.stoppedAt?.toISOString() ?? null} />}
            />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{t("adminActivity.field.progress")}</p>
              <div className="flex items-center gap-2">
                {/* Same fill rule as the history table's bar: success once the
                    play counts as watched, otherwise the accent (guardrail 42 —
                    a fixed blue-* is not remapped and ignores the accent). */}
                <div
                  className="flex-1 h-2 rounded-full overflow-hidden"
                  style={{ background: "color-mix(in oklab, var(--ds-fg) 6%, transparent)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${pct}%`,
                      background: play.watched ? "var(--ds-success)" : "var(--ds-accent)",
                    }}
                  />
                </div>
                <span className="text-xs text-zinc-400 tabular-nums w-8 text-right">{pct}%</span>
              </div>
            </div>
            <LabeledValue label={t("adminActivity.kpi.watchTime")} value={formatDuration(playDurationS)} />
            <LabeledValue label={t("adminActivity.field.totalDuration")} value={formatDuration(durationS)} />
            {play.pausedDuration > 0 && (
              <LabeledValue label={t("adminActivity.field.paused")} value={formatDuration(play.pausedDuration)} />
            )}
          </div>
        </ActivityCard>

        <ActivityCard>
          <SectionHeader label={t("adminActivity.play.streamQuality")} />
          <div className="space-y-3">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{t("adminActivity.play.playMethod")}</p>
              <PlayMethodBadge
                method={play.playMethod}
                videoDecision={play.videoDecision}
                audioDecision={play.audioDecision}
                t={t}
              />
            </div>
            <LabeledValue label={t("adminActivity.popover.resolution")} value={play.resolution ?? "—"} />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{t("adminActivity.field.videoCodec")}</p>
              <span className="text-sm text-zinc-200">{play.videoCodec?.toUpperCase() ?? "—"}</span>
              {play.videoDecision && (
                <span className="ml-2"><DecisionBadge decision={play.videoDecision} t={t} /></span>
              )}
            </div>
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{t("adminActivity.field.audioCodec")}</p>
              <span className="text-sm text-zinc-200">{play.audioCodec?.toUpperCase() ?? "—"}</span>
              {play.audioDecision && (
                <span className="ml-2"><DecisionBadge decision={play.audioDecision} t={t} /></span>
              )}
            </div>
            <LabeledValue label={t("adminActivity.field.container")} value={play.container?.toUpperCase() ?? "—"} />
            <LabeledValue label={t("adminActivity.field.bitrate")} value={fmtBitrate(play.bitrate, play.source)} />
          </div>
        </ActivityCard>

        <ActivityCard>
          <SectionHeader label={t("adminActivity.field.device")} />
          <div className="space-y-3">
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{t("adminActivity.field.user")}</p>
              <Link
                href={`/admin/activity/user/${play.mediaServerUser.id}`}
                className="flex items-center gap-2 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {/* Avatar URL is from an arbitrary upstream media-server host (can't be
                    allowlisted in next/image remotePatterns); the shared Avatar falls back
                    to an initial when the thumb fails to load. */}
                {play.mediaServerUser.thumbUrl && /^https?:\/\//i.test(play.mediaServerUser.thumbUrl) && (
                  <Avatar className="size-5">
                    <AvatarImage src={play.mediaServerUser.thumbUrl} alt="" />
                    <AvatarFallback className="text-[9px]">
                      {play.mediaServerUser.username.slice(0, 1).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                )}
                <User className="w-3.5 h-3.5" />
                {play.mediaServerUser.username}
              </Link>
            </div>
            <LabeledValue label={t("adminActivity.field.platform")} value={play.platform ?? "—"} />
            <LabeledValue label={t("adminActivity.field.player")} value={play.player ?? "—"} />
            <LabeledValue label={t("adminActivity.field.device")} value={play.device ?? "—"} />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{t("adminActivity.field.ipAddress")}</p>
              {play.ipAddress
                ? <IpInfo ip={play.ipAddress} size="sm" />
                : <p className="text-sm text-zinc-200">—</p>}
            </div>
          </div>
        </ActivityCard>
      </div>

      <div className="flex justify-end">
        <DeletePlayButton id={play.id} />
      </div>
    </div>
  );
}
