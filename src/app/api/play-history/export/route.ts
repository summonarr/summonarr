import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { hasPermission, Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { logAuditOrFail, auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  composeWhere,
  invalidDateParam,
  normalizePlayHistoryFilters,
  playHistoryFilterFragments,
} from "@/lib/play-history-filters";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { getStatsTimeZone } from "@/lib/stats-time-zone-data";
import { bitrateToKbps } from "@/lib/bitrate";
import type { Translator } from "@/lib/i18n/translate";

export const dynamic = "force-dynamic";

const MAX_EXPORT_ROWS = 10_000;
const PAGE_SIZE = 1000;

// UTF-8 byte-order mark. Excel (Windows) sniffs a double-clicked .csv's encoding
// from a BOM, not from the Content-Type charset, so without it any non-ASCII
// title ("Amélie", a CJK series) opens as mojibake.
const UTF8_BOM = "\uFEFF";

// The stored `bitrate` is UNITLESS without `source` — Plex rows are kbps, Jellyfin
// rows are bps (guardrail 19a) — so the raw column never leaves the DB: both
// export paths emit kbps via bitrateToKbps, null when the row has none.
function exportBitrateKbps(r: ExportRow): number | null {
  const kbps = bitrateToKbps(r.bitrate, r.source);
  return kbps > 0 ? kbps : null;
}

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
  pausedDuration: number;
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

// The filters as composeWhere bound them (play-history-filters.ts).
type ExportWhere = { whereSql: string; binds: unknown[]; nextBindIndex: number };
type ExportCursor = { startedAt: Date; id: string };

/**
 * One page of the export, newest first with `id` as the tiebreak, after
 * `cursor` when given. Keyset over (startedAt, id) DESC — the predicate
 * Prisma's `cursor` + `skip: 1` compiled to, written out because the filters
 * are raw fragments. The expanded OR form (rather than a row comparison)
 * mirrors src/lib/my-watch-history.ts, which avoids relying on Postgres
 * inferring parameter types inside a row constructor.
 */
function fetchExportPage(where: ExportWhere, cursor: ExportCursor | null, take: number): Promise<ExportRow[]> {
  const binds: unknown[] = [...where.binds];
  let cursorSql = "";
  if (cursor) {
    cursorSql =
      ` AND (h."startedAt" < $${where.nextBindIndex}` +
      ` OR (h."startedAt" = $${where.nextBindIndex} AND h."id" < $${where.nextBindIndex + 1}))`;
    binds.push(cursor.startedAt, cursor.id);
  }
  // Derived from the array so it can't drift from what was pushed —
  // nextBindIndex when there's no cursor, nextBindIndex + 2 with one.
  const limitBind = binds.length + 1;
  binds.push(take);
  return prisma.$queryRawUnsafe<ExportRow[]>(
    `
      SELECT ${EXPORT_SELECT}, msu."username" AS username
      FROM "PlayHistory" h
      LEFT JOIN "MediaServerUser" msu ON msu.id = h."mediaServerUserId"
      WHERE 1=1 ${where.whereSql}${cursorSql}
      ORDER BY h."startedAt" DESC, h."id" DESC
      LIMIT $${limitBind}
    `,
    ...binds,
  );
}

// One exported row as the JSON export writes it.
function exportJsonRow(r: ExportRow) {
  return {
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
    bitrateKbps: exportBitrateKbps(r),
    videoDecision: r.videoDecision,
    audioDecision: r.audioDecision,
    container: r.container,
  };
}

// The column headers are deliberately fixed English identifiers (machine-
// readable, stable across locales); only the prose notice is localized.
const CSV_HEADERS = [
  "Title", "Media Type", "Year", "Season", "Episode", "Episode Title",
  "Username", "Source", "Started At", "Stopped At",
  "Duration (s)", "Play Duration (s)", "Paused Duration (s)", "Watched",
  "Platform", "Player", "Device",
  "Play Method", "Video Codec", "Audio Codec", "Resolution", "Bitrate (kbps)",
  "Video Decision", "Audio Decision", "Container",
];

// One exported row as a CSV line, in CSV_HEADERS' order.
function exportCsvLine(r: ExportRow): string {
  return [
    r.title, r.mediaType, r.year,
    r.seasonNumber, r.episodeNumber, r.episodeTitle,
    r.username, r.source,
    r.startedAt.toISOString(), r.stoppedAt.toISOString(),
    r.duration, r.playDuration, r.pausedDuration,
    r.watched, r.platform, r.player,
    r.device, r.playMethod,
    r.videoCodec, r.audioCodec, r.resolution,
    exportBitrateKbps(r), r.videoDecision, r.audioDecision,
    r.container,
  ].map(escapeCSV).join(",");
}

/**
 * Writes the CSV export page by page. `write` resolves once the consumer took
 * the chunk (TransformStream backpressure), so pages are read only as fast as
 * the client downloads them, and a cancelled download rejects the pending
 * write and stops the loop there. At most MAX_EXPORT_ROWS rows; the page that
 * reaches the cap asks for ONE more row, never written, so an export of
 * exactly MAX_EXPORT_ROWS rows is not reported as cut.
 */
async function writeCsvExport(write: (text: string) => Promise<void>, where: ExportWhere, t: Translator): Promise<void> {
  await write(UTF8_BOM + CSV_HEADERS.join(",") + "\n");
  let cursor: ExportCursor | null = null;
  let emitted = 0;
  let truncated = false;
  while (emitted < MAX_EXPORT_ROWS) {
    const take = Math.min(PAGE_SIZE, MAX_EXPORT_ROWS - emitted);
    const reachesCap = emitted + take >= MAX_EXPORT_ROWS;
    const page = await fetchExportPage(where, cursor, reachesCap ? take + 1 : take);
    if (page.length === 0) break;
    truncated = page.length > take;
    const rows = truncated ? page.slice(0, take) : page;
    for (const r of rows) await write(exportCsvLine(r) + "\n");
    emitted += rows.length;
    const last = rows[rows.length - 1];
    cursor = { startedAt: last.startedAt, id: last.id };
    if (rows.length < take) break;
  }
  if (truncated) {
    // CSV has no comment syntax, so this trailing notice IS a data record to
    // every parser — escapeCSV keeps it a single well-formed field instead of
    // a raw fragment that splits the row. The remedy has to be the date
    // filters: this route reads no `cursor` param.
    await write(escapeCSV(t("apiUser.playHistory.exportTruncated", { max: MAX_EXPORT_ROWS })) + "\n");
  }
}

// The streaming CSV response. A failure while producing it is logged (a
// truncated download is otherwise undiagnosable); a cancelled download — the
// consumer gone, so the pending write rejected — is not a failure.
function csvExportResponse(where: ExportWhere, t: Translator, filename: string): Response {
  const encoder = new TextEncoder();
  // Writing through a TransformStream makes `await writer.write(...)` wait for
  // the consumer (the readable side buffers nothing ahead). Producing inside a
  // ReadableStream's start() could not: enqueue never blocks, so every page was
  // queried and queued however slowly the client read.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let consumerGone = false;
  const write = (text: string) =>
    writer.write(encoder.encode(text)).catch((err: unknown) => {
      consumerGone = true;
      throw err;
    });

  void (async () => {
    try {
      await writeCsvExport(write, where, t);
      await writer.close().catch(() => { /* consumer already gone */ });
    } catch (err) {
      if (!consumerGone) {
        console.error("[play-history-export] CSV export failed:", err instanceof Error ? err.message : err);
      }
      await writer.abort(err).catch(() => { /* consumer already gone */ });
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}

export async function GET(request: NextRequest) {
  const t = translatorForRequest(request);
  // Not wrapped in withPermission because this route streams a CSV body; the
  // ADMIN check is done by hand just below (guardrail 6a).
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;
  if (!hasPermission(session.user.permissions, Permission.ADMIN)) {
    return NextResponse.json({ error: t("apiUser.common.forbidden") }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;
  const format = params.get("format") === "json" ? "json" : "csv";

  // Reject unparseable dates with a 400 BEFORE the audit write below — an
  // Invalid Date fed into the query throws an uncaught 500, and the paper-trail
  // row must not record an export that never ran.
  const badDate = invalidDateParam(params);
  if (badDate) {
    return NextResponse.json({ error: t("apiUser.playHistory.invalidDate", { name: badDate }) }, { status: 400 });
  }

  // Raw fragments, not a Prisma `where`, and shared with the list route the
  // admin table exports FROM — so "export what I'm looking at" holds for every
  // filter, `search` included. Prisma's `contains` emits an ILIKE with no
  // ESCAPE clause, so a term carrying a `%`/`_` could only be made safe there
  // by stripping the character, which silently exported the wrong rows (a
  // `john_doe` export searched for `johndoe`). See src/lib/play-history-filters.ts.
  const filters = normalizePlayHistoryFilters(params, await getStatsTimeZone());
  const where: ExportWhere = composeWhere(playHistoryFilterFragments(filters));

  // AFTER parameter validation on purpose, as in the audit-log export: a hit is
  // recorded on every call, so a mistyped date used to spend one of the five
  // hourly exports on a 400. Still before the audit write, so a throttled request
  // leaves no paper trail. Keyed on the session user ALONE: getClientIp falls back
  // to a hash of the User-Agent whenever TRUST_PROXY is not "true" — the default
  // docker deployment — so folding it in let one admin session mint a fresh bucket
  // per UA string and multiply its own allowance on a bulk PII export. A
  // caller-controlled component can only ever widen a limit, never tighten it.
  if (!checkRateLimit(`ph-export:${session.user.id}`, 5, 3_600_000)) {
    return NextResponse.json({ error: t("apiUser.playHistory.exportRateLimited") }, { status: 429 });
  }

  // Play-history export streams up to MAX_EXPORT_ROWS of viewer PII (titles,
  // usernames, devices, IP-correlated rows). Its paper-trail row is written
  // BEFORE any row leaves, and a failed write refuses the export: no viewer
  // history goes out without its record (the audit-log export's rule). No
  // mutation precedes it, so logAuditOrFail is the right writer (guardrail 26).
  // The filters are logged (not the rows) so the trail captures scope without
  // re-deriving PII.
  const ctx = auditContext(request, { user: { provider: session.user.provider } });
  try {
    await logAuditOrFail({
      userId: session.user.id,
      userName: session.user.name ?? session.user.email ?? session.user.id,
      action: "PLAY_HISTORY_EXPORT",
      target: "play-history:export",
      details: { kind: "play-history", format, maxRows: MAX_EXPORT_ROWS, filters: auditedFilters(filters, params) },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      provider: ctx.provider,
    });
  } catch (err) {
    console.error("[play-history-export] audit write failed; export refused:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: t("apiUser.playHistory.exportFailed") }, { status: 500 });
  }

  const filename = `play-history-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  if (format === "csv") return csvExportResponse(where, t, filename);

  // JSON: one bare array (scripts parse it), at most MAX_EXPORT_ROWS, in the
  // CSV's order.
  // One row past the cap tells a cut from an exact fit; the array stays bare, so
  // the signal rides a response header.
  const fetched = await fetchExportPage(where, null, MAX_EXPORT_ROWS + 1);
  const truncated = fetched.length > MAX_EXPORT_ROWS;
  const rows = truncated ? fetched.slice(0, MAX_EXPORT_ROWS) : fetched;
  return new NextResponse(JSON.stringify(rows.map(exportJsonRow), null, 2), {
    headers: {
      "Content-Type": "application/json",
      "X-Export-Truncated": truncated ? "true" : "false",
      "X-Export-Max-Rows": String(MAX_EXPORT_ROWS),
      "Content-Disposition": `attachment; filename="${filename}.json"`,
    },
  });
}

// The VALIDATED filter values, not the raw params: an unrecognized source,
// mediaType, watched or tmdbId never narrows the query (`source=plexx` exports
// every row), so logging the raw string would record a scope the export did not
// actually have. The dates are logged as sent: they were validated, and every
// accepted one narrows.
function auditedFilters(filters: ReturnType<typeof normalizePlayHistoryFilters>, params: URLSearchParams) {
  return {
    source: filters.source,
    mediaType: filters.mediaType,
    watched: filters.watched,
    userId: filters.userId,
    tmdbId: filters.tmdbId,
    playMethod: filters.playMethod,
    platform: filters.platform,
    startDate: params.get("startDate") || null,
    endDate: params.get("endDate") || null,
    fromDay: filters.fromDay,
    toDay: filters.toDay,
    ...(filters.fromDay || filters.toDay ? { timeZone: filters.timeZone } : {}),
    search: filters.search,
  };
}
