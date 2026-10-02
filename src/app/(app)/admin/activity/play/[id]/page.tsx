import { authActive } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/permissions";
import Link from "next/link";
import { posterUrl } from "@/lib/tmdb-types";
import { bitrateToKbps } from "@/lib/bitrate";
import { User, CheckCircle2, Circle } from "@/components/icons";
// Same card + section-title + detail-header primitives the user/title detail
// views use, so the three Activity detail pages share one composition.
import {
  ActivityCard,
  DetailHeader,
  Poster,
  SectionHeader,
  SourceTag,
} from "@/components/admin/activity-ui";
import { DeletePlayButton } from "@/components/admin/delete-play-button";
import { IpInfo } from "@/components/admin/ip-info";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { getLocale, getTranslator } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/translate";

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

// `source` is required: Plex reports kbps, Jellyfin bps, and the row is the
// only thing that can tell them apart (lib/bitrate.ts).
function formatBitrate(raw: number | null, source: string | null): string {
  const kbps = bitrateToKbps(raw, source);
  if (kbps <= 0) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

// Server component: formatting here uses the Node process's zone, so pin it to
// UTC and say so (matching the calendar's "days in UTC" label) rather than
// render an unlabelled time in whatever zone the container happens to run.
function formatTs(d: Date | null, locale: string): string {
  if (!d) return "—";
  return `${d.toLocaleString(locale, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "UTC",
  })} UTC`;
}

function LabeledValue({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className={`text-sm text-zinc-200 ${mono ? "tabular-nums font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function PlayMethodBadge({ method, t }: { method: string | null; t: Translator }) {
  if (!method) return <span className="text-zinc-500">—</span>;
  const colors: Record<string, string> = {
    DirectPlay: "bg-green-500/15 text-green-400",
    DirectStream: "bg-sky-500/15 text-sky-400",
    Transcode: "bg-orange-500/15 text-orange-400",
  };
  const labels: Record<string, string> = {
    DirectPlay: t("adminActivity.method.directPlay"),
    DirectStream: t("adminActivity.method.directStreamRemux"),
    Transcode: t("adminActivity.method.transcode"),
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[method] ?? "bg-zinc-700 text-zinc-300"}`}>
      {labels[method] ?? method}
    </span>
  );
}

function DecisionBadge({ decision, t }: { decision: string | null; t: Translator }) {
  if (!decision) return <span className="text-zinc-500">—</span>;
  const isTranscode = decision === "transcode";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
      isTranscode ? "bg-orange-500/15 text-orange-400" : "bg-green-500/15 text-green-400"
    }`}>
      {isTranscode ? t("adminActivity.method.transcode") : t("adminActivity.method.direct")}
    </span>
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
  const [t, locale] = await Promise.all([getTranslator(), getLocale()]);

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
    <div className="ds-page-enter max-w-4xl">
      <DetailHeader
        back={{ href: "/admin/activity?tab=history", label: t("adminActivity.play.backToHistory") }}
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
            <LabeledValue label={t("adminActivity.field.started")} value={formatTs(play.startedAt, locale)} />
            <LabeledValue label={t("adminActivity.field.stopped")} value={formatTs(play.stoppedAt, locale)} />
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wide mb-1">{t("adminActivity.field.progress")}</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-blue-500" : "bg-zinc-500"}`}
                    style={{ width: `${pct}%` }}
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
              <PlayMethodBadge method={play.playMethod} t={t} />
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
            <LabeledValue label={t("adminActivity.field.bitrate")} value={formatBitrate(play.bitrate, play.source)} />
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
                ? <IpInfo ip={play.ipAddress} />
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
