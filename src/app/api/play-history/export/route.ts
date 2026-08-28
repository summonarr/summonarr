import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { hasPermission, Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { logAudit, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { composeWhere, parsePlayHistoryFilters, PLAY_METHODS } from "@/lib/play-history-filters";
import { SEARCH_TERM_MAX_LEN } from "@/lib/sanitize";

export const dynamic = "force-dynamic";

const MAX_EXPORT_ROWS = 10_000;
const PAGE_SIZE = 1000;

// The exported column set, shared by the CSV and JSON paths so the two can
// never drift. `mediaServerUser.username` is the one non-PlayHistory field, so
// it rides a join alias rather than this list.
const EXPORT_COLUMNS = [
  "id", "title", "mediaType", "year", "seasonNumber", "episodeNumber", "episodeTitle",
  "source", "startedAt", "stoppedAt", "duration", "playDuration", "pausedDuration",
  "watched", "platform", "player", "device", "playMethod", "videoCodec", "audioCodec",
  "resolution", "bitrate", "videoDecision", "audioDecision", "container",
] as const;

const EXPORT_SELECT = EXPORT_COLUMNS.map((c) => `h."${c}"`).join(", ");

// One exported row: the columns above (as the pg driver types them) plus the
// joined username. Dates arrive as Date objects, so the ISO serialization below
// matches what Prisma's client produced.
interface ExportRow {
  id: string;
  title: string;
  mediaType: "MOVIE" | "TV" | null;
  year: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  episodeTitle: string | null;
  source: string;
  startedAt: Date;
  stoppedAt: Date;
  duration: number;
  playDuration: number;
  pausedDuration: number | null;
  watched: boolean;
  platform: string | null;
  player: string | null;
  device: string | null;
  playMethod: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  resolution: string | null;
  bitrate: number | null;
  videoDecision: string | null;
  audioDecision: string | null;
  container: string | null;
  username: string;
}

function escapeCSV(value: unknown): string {
  if (value == null) return "";
  let str = String(value);
  // Prefix formula-injection characters to prevent CSV injection in Excel/Sheets
  if (/^[=+\-@|%\t\r\n]/.test(str)) {
    str = "\t" + str;
  }
  // `\r` MUST be in the quoting test: an embedded (non-leading) carriage return in an
  // UNquoted field is a record separator to Excel/most CSV parsers, so `foo\r=cmd` would
  // split into a second row whose `=cmd` bypasses the leading-char formula prefix above.
  // Quoting keeps the CR as literal field data.
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r") || str.includes("\t")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function GET(request: NextRequest) {
  const session = await requireAuth(); // permission checked inside
  if (session instanceof NextResponse) return session;
  if (!hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Keyed on the session user ALONE. getClientIp falls back to a hash of the
  // User-Agent whenever TRUST_PROXY is not "true" — the default docker deployment —
  // so folding it in let one admin session mint a fresh bucket per UA string and
  // multiply its own allowance on a bulk PII export. A caller-controlled component can
  // only ever widen a limit, never tighten it.
  if (!checkRateLimit(`ph-export:${session.user.id}`, 5, 3_600_000)) {
    return NextResponse.json({ error: "Too many export requests — try again later" }, { status: 429 });
  }

  const params = request.nextUrl.searchParams;
  const format = params.get("format") === "json" ? "json" : "csv";

  const source = params.get("source");
  const mediaType = params.get("mediaType");
  const watched = params.get("watched");
  const userId = params.get("userId");
  const tmdbId = params.get("tmdbId");
  const playMethod = params.get("playMethod");
  const platform = params.get("platform");
  const startDate = params.get("startDate");
  const endDate = params.get("endDate");
  const search = (params.get("search")?.trim() ?? "").slice(0, SEARCH_TERM_MAX_LEN);

  // Reject unparseable dates with a 400 BEFORE the audit write below — an
  // Invalid Date fed into the query throws an uncaught 500, and the paper-trail
  // row must not record an export that never ran.
  for (const [name, value] of [["startDate", startDate], ["endDate", endDate]] as const) {
    if (value && isNaN(new Date(value).getTime())) {
      return NextResponse.json({ error: `${name} must be a valid date` }, { status: 400 });
    }
  }

  // Raw fragments, not a Prisma `where`, and shared with the list route the
  // admin table exports FROM — so "export what I'm looking at" holds for every
  // filter, `search` included. Prisma's `contains` emits an ILIKE with no
  // ESCAPE clause, so a term carrying a `%`/`_` could only be made safe there
  // by stripping the character, which silently exported the wrong rows (a
  // `john_doe` export searched for `johndoe`). See src/lib/play-history-filters.ts.
  const { whereSql, binds, nextBindIndex } = composeWhere(parsePlayHistoryFilters(params));

  // Play-history export streams up to MAX_EXPORT_ROWS of viewer PII (titles,
  // usernames, devices, IP-correlated rows). Record a paper-trail row so the
  // export is attributable — mirrors the audit-log export. The filters are
  // logged (not the rows) so the trail captures scope without re-deriving PII.
  const ctx = auditContext(request, { user: { provider: session.user.provider } });
  // await (not void) so the paper-trail row is durably written before up to
  // MAX_EXPORT_ROWS of viewer PII stream out. A fire-and-forget audit could lose
  // the record if the process/stream dies first.
  await logAudit({
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
        tmdbId: tmdbId ?? null,
        // The VALIDATED value, not the raw param — an unrecognized playMethod
        // never narrows the query, so logging it would record a scope the
        // export did not actually have.
        playMethod: playMethod && PLAY_METHODS.includes(playMethod) ? playMethod : null,
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
    const rows = await prisma.$queryRawUnsafe<ExportRow[]>(
      `
        SELECT ${EXPORT_SELECT}, msu."username" AS username
        FROM "PlayHistory" h
        LEFT JOIN "MediaServerUser" msu ON msu.id = h."mediaServerUserId"
        WHERE 1=1 ${whereSql}
        ORDER BY h."startedAt" DESC
        LIMIT $${nextBindIndex}
      `,
      ...binds,
      MAX_EXPORT_ROWS,
    );
    const data = rows.map((r) => ({
      id: r.id,
      title: r.title,
      mediaType: r.mediaType,
      year: r.year,
      seasonNumber: r.seasonNumber,
      episodeNumber: r.episodeNumber,
      episodeTitle: r.episodeTitle,
      username: r.username,
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

        // Keyset cursor over (startedAt, id) DESC — the same predicate Prisma's
        // `cursor` + `skip: 1` compiled to, written out because the filters are
        // now raw fragments. The expanded OR form (rather than a row
        // comparison) mirrors src/lib/my-watch-history.ts, which avoids relying
        // on Postgres inferring parameter types inside a row constructor.
        let cursor: { startedAt: Date; id: string } | null = null;
        let emitted = 0;

        while (emitted < MAX_EXPORT_ROWS) {
          const remaining = MAX_EXPORT_ROWS - emitted;
          const take = Math.min(PAGE_SIZE, remaining);

          const pageBinds: unknown[] = [...binds];
          let cursorSql = "";
          if (cursor) {
            cursorSql =
              ` AND (h."startedAt" < $${nextBindIndex}` +
              ` OR (h."startedAt" = $${nextBindIndex} AND h."id" < $${nextBindIndex + 1}))`;
            pageBinds.push(cursor.startedAt, cursor.id);
          }
          // Derived from the array so it can't drift from what was pushed —
          // nextBindIndex when there's no cursor, nextBindIndex + 2 with one.
          const limitBind = pageBinds.length + 1;
          pageBinds.push(take);

          const page = await prisma.$queryRawUnsafe<ExportRow[]>(
            `
              SELECT ${EXPORT_SELECT}, msu."username" AS username
              FROM "PlayHistory" h
              LEFT JOIN "MediaServerUser" msu ON msu.id = h."mediaServerUserId"
              WHERE 1=1 ${whereSql}${cursorSql}
              ORDER BY h."startedAt" DESC, h."id" DESC
              LIMIT $${limitBind}
            `,
            ...pageBinds,
          );

          if (page.length === 0) break;
          for (const r of page) {
            const line = [
              escapeCSV(r.title), escapeCSV(r.mediaType), escapeCSV(r.year),
              escapeCSV(r.seasonNumber), escapeCSV(r.episodeNumber), escapeCSV(r.episodeTitle),
              escapeCSV(r.username), escapeCSV(r.source),
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
          const last = page[page.length - 1];
          cursor = { startedAt: last.startedAt, id: last.id };

          if (page.length < take) break;
        }

        if (emitted >= MAX_EXPORT_ROWS) {
          // CSV has no comment syntax, so this trailing notice IS a data record to
          // every parser — escapeCSV keeps it a single well-formed field instead of
          // a raw fragment that splits the row. The remedy has to be the date
          // filters: this route reads no `cursor` param, so the notice previously
          // pointed at a knob that does not exist.
          controller.enqueue(
            encoder.encode(
              escapeCSV(
                `Export truncated at ${MAX_EXPORT_ROWS} rows — narrow startDate/endDate and export again`,
              ) + "\n",
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
