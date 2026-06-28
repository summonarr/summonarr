import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import type { Prisma } from "@/generated/prisma";

export const dynamic = "force-dynamic";

const MAX_EXPORT_ROWS = 10_000;
const PAGE_SIZE = 1000;
const MAX_SEARCH_LEN = 100;

// Prisma's `contains` filter emits an ILIKE with no `ESCAPE` clause, so a search
// term laden with `%`/`_` wildcards would force an unindexable pattern scan (a
// search-box DoS). Strip the LIKE metacharacters (and the escape char) and bound
// the length so the filter is a bounded literal substring match.
function sanitizeContainsSearch(s: string): string {
  return s.replace(/[%_\\]/g, "").slice(0, MAX_SEARCH_LEN);
}

function escapeCSV(value: unknown): string {
  if (value == null) return "";
  let str = String(value);
  // Prefix formula-injection characters to prevent CSV injection in Excel/Sheets
  if (/^[=+\-@|%\t\r\n]/.test(str)) {
    str = "\t" + str;
  }
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\t")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(request: NextRequest) {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

  if (!checkRateLimit(`ph-export:${session.user.id}:${getClientIp(request.headers)}`, 5, 3_600_000)) {
    return NextResponse.json({ error: "Too many export requests — try again later" }, { status: 429 });
  }

  const params = request.nextUrl.searchParams;
  const format = params.get("format") === "json" ? "json" : "csv";

  const where: Record<string, unknown> = {};

  const source = params.get("source");
  if (source === "plex" || source === "jellyfin") where.source = source;

  const mediaType = params.get("mediaType");
  if (mediaType === "MOVIE" || mediaType === "TV") where.mediaType = mediaType;

  const watched = params.get("watched");
  if (watched === "true") where.watched = true;
  else if (watched === "false") where.watched = false;

  const userId = params.get("userId");
  if (userId) where.mediaServerUserId = userId;

  const playMethod = params.get("playMethod");
  if (playMethod && ["DirectPlay", "DirectStream", "Transcode"].includes(playMethod)) {
    where.playMethod = playMethod;
  }

  const platform = params.get("platform");
  if (platform) where.platform = platform;

  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  if (startDate || endDate) {
    where.startedAt = {
      ...(startDate ? { gte: new Date(startDate) } : {}),
      ...(endDate ? { lte: new Date(endDate) } : {}),
    };
  }

  const search = sanitizeContainsSearch(params.get("search")?.trim() ?? "");
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { ipAddress: { contains: search, mode: "insensitive" } },
      { mediaServerUser: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  // Play-history export streams up to MAX_EXPORT_ROWS of viewer PII (titles,
  // usernames, devices, IP-correlated rows). Record a paper-trail row so the
  // export is attributable — mirrors the audit-log export. The filters are
  // logged (not the rows) so the trail captures scope without re-deriving PII.
  const ctx = auditContext(request, { user: { provider: session.user.provider } });
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? session.user.id,
    action: "PLAY_HISTORY_EXPORT",
    target: "play-history:export",
    details: {
      kind: "play-history",
      format,
      maxRows: MAX_EXPORT_ROWS,
      filters: {
        source: source ?? null,
        mediaType: mediaType ?? null,
        watched: watched ?? null,
        userId: userId ?? null,
        playMethod: where.playMethod ?? null,
        platform: platform ?? null,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
        search: search || null,
      },
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    provider: ctx.provider,
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (format === "json") {
    const rows = await prisma.playHistory.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: MAX_EXPORT_ROWS,
      select: {
        id: true,
        title: true,
        mediaType: true,
        year: true,
        seasonNumber: true,
        episodeNumber: true,
        episodeTitle: true,
        source: true,
        startedAt: true,
        stoppedAt: true,
        duration: true,
        playDuration: true,
        pausedDuration: true,
        watched: true,
        platform: true,
        player: true,
        device: true,
        playMethod: true,
        videoCodec: true,
        audioCodec: true,
        resolution: true,
        bitrate: true,
        videoDecision: true,
        audioDecision: true,
        container: true,
        mediaServerUser: { select: { username: true, source: true } },
      },
    });
    const data = rows.map((r) => ({
      id: r.id,
      title: r.title,
      mediaType: r.mediaType,
      year: r.year,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      episodeTitle: r.episodeTitle,
      username: r.mediaServerUser.username,
      source: r.source,
      startedAt: r.startedAt.toISOString(),
      stoppedAt: r.stoppedAt.toISOString(),
      duration: r.duration,
      playDuration: r.playDuration,
      pausedDuration: r.pausedDuration,
      watched: r.watched,
      platform: r.platform,
      player: r.player,
      device: r.device,
      playMethod: r.playMethod,
      videoCodec: r.videoCodec,
      audioCodec: r.audioCodec,
      resolution: r.resolution,
      bitrate: r.bitrate,
      videoDecision: r.videoDecision,
      audioDecision: r.audioDecision,
      container: r.container,
    }));
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="play-history-${timestamp}.json"`,
      },
    });
  }

  const headers = [
    "Title", "Media Type", "Year", "Season", "Episode", "Episode Title",
    "Username", "Source", "Started At", "Stopped At",
    "Duration (s)", "Play Duration (s)", "Paused Duration (s)", "Watched",
    "Platform", "Player", "Device",
    "Play Method", "Video Codec", "Audio Codec", "Resolution", "Bitrate",
    "Video Decision", "Audio Decision", "Container",
  ];

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(headers.join(",") + "\n"));

        let cursor: string | undefined = undefined;
        let emitted = 0;

        while (emitted < MAX_EXPORT_ROWS) {
          const remaining = MAX_EXPORT_ROWS - emitted;
          const take = Math.min(PAGE_SIZE, remaining);
          type PlayHistoryRow = Prisma.PlayHistoryGetPayload<{
            select: {
              id: true; title: true; mediaType: true; year: true;
              seasonNumber: true; episodeNumber: true; episodeTitle: true;
              source: true; startedAt: true; stoppedAt: true;
              duration: true; playDuration: true; pausedDuration: true; watched: true;
              platform: true; player: true; device: true; playMethod: true;
              videoCodec: true; audioCodec: true; resolution: true; bitrate: true;
              videoDecision: true; audioDecision: true; container: true;
              mediaServerUser: { select: { username: true; source: true } };
            };
          }>;
          const page: PlayHistoryRow[] = await prisma.playHistory.findMany({
            where,
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
            take,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: {
              id: true,
              title: true,
              mediaType: true,
              year: true,
              seasonNumber: true,
              episodeNumber: true,
              episodeTitle: true,
              source: true,
              startedAt: true,
              stoppedAt: true,
              duration: true,
              playDuration: true,
              pausedDuration: true,
              watched: true,
              platform: true,
              player: true,
              device: true,
              playMethod: true,
              videoCodec: true,
              audioCodec: true,
              resolution: true,
              bitrate: true,
              videoDecision: true,
              audioDecision: true,
              container: true,
              mediaServerUser: { select: { username: true, source: true } },
            },
          });

          if (page.length === 0) break;
          for (const r of page) {
            const line = [
              escapeCSV(r.title), escapeCSV(r.mediaType), escapeCSV(r.year),
              escapeCSV(r.seasonNumber), escapeCSV(r.episodeNumber), escapeCSV(r.episodeTitle),
              escapeCSV(r.mediaServerUser.username), escapeCSV(r.source),
              escapeCSV(r.startedAt.toISOString()), escapeCSV(r.stoppedAt.toISOString()),
              escapeCSV(r.duration), escapeCSV(r.playDuration), escapeCSV(r.pausedDuration),
              escapeCSV(r.watched), escapeCSV(r.platform), escapeCSV(r.player),
              escapeCSV(r.device), escapeCSV(r.playMethod),
              escapeCSV(r.videoCodec), escapeCSV(r.audioCodec), escapeCSV(r.resolution),
              escapeCSV(r.bitrate), escapeCSV(r.videoDecision), escapeCSV(r.audioDecision),
              escapeCSV(r.container),
            ].join(",");
            controller.enqueue(encoder.encode(line + "\n"));
          }

          emitted += page.length;
          cursor = page[page.length - 1].id;

          if (page.length < take) break;
        }

        if (emitted >= MAX_EXPORT_ROWS) {
          controller.enqueue(
            encoder.encode(
              `# Export truncated at ${MAX_EXPORT_ROWS} rows — use ?cursor= to paginate\n`
            )
          );
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="play-history-${timestamp}.csv"`,
    },
  });
}
