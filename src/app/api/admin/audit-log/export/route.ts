import { NextResponse } from "next/server";
import type { AuditLog, Prisma } from "@/generated/prisma";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { auditContext, finalizeAuditRow, logAuditOrFailReturningId } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildAuditLogWhere } from "@/lib/audit-log-filter";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const CHUNK_SIZE = 1000;
const MAX_EXPORT_RECORDS = 100_000;
// The producer waits on its reader (below), so a response nobody reads — Next
// runs GET for a HEAD and never reads it — or a download that stalls would
// hold it, and leave its paper-trail row "started", indefinitely. A real
// download starts reading at once; the whole export is bounded too.
const FIRST_READ_TIMEOUT_MS = 60 * 1000;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

const LOG_SCOPE = "[audit-log/export]";

type ExportFormat = "csv" | "json";
type ExportStatus = "completed" | "aborted" | "failed";

function escapeCSV(value: string): string {
  // Prefix formula-injection characters to prevent CSV injection in Excel/Sheets
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function csvRow(log: AuditLog): string {
  return [
    log.id,
    log.createdAt.toISOString(),
    log.userId,
    escapeCSV(log.userName),
    log.action,
    escapeCSV(log.target),
    escapeCSV(log.details ?? ""),
    log.ipAddress ?? "",
    escapeCSV(log.userAgent ?? ""),
    log.provider ?? "",
  ].join(",");
}

// The paper-trail row's details: what was asked for and how it ended.
function exportDetails(
  filters: Record<string, unknown>,
  outcome: { status: ExportStatus | "started"; rowCount: number; truncated: boolean; totalMatching?: number; error?: string },
): Record<string, unknown> {
  const { status, rowCount, truncated, totalMatching, error } = outcome;
  return {
    kind: "audit-log",
    filters,
    rowCount,
    ...(totalMatching !== undefined ? { totalMatching } : {}),
    truncated,
    status,
    ...(error ? { error } : {}),
  };
}

// Pages the matching rows newest first and writes them; resolves to how many
// were written. Every write waits until the reader has drained the last one.
async function writeExport(
  write: (text: string) => Promise<void>,
  where: Prisma.AuditLogWhereInput,
  format: ExportFormat,
  trailer: string | null,
): Promise<number> {
  if (format === "csv") {
    await write("id,createdAt,userId,userName,action,target,details,ipAddress,userAgent,provider\n");
  } else {
    await write("[\n");
  }
  let exported = 0;
  let cursor: string | undefined;
  let first = true;
  while (exported < MAX_EXPORT_RECORDS) {
    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (logs.length === 0) break;
    for (const log of logs) {
      if (format === "csv") {
        await write(csvRow(log) + "\n");
      } else {
        await write((first ? "  " : ",\n  ") + JSON.stringify(log));
        first = false;
      }
    }
    exported += logs.length;
    if (logs.length < CHUNK_SIZE) break;
    cursor = logs[logs.length - 1].id;
  }
  if (format === "json") await write("\n]\n");
  else if (trailer) await write(trailer);
  return exported;
}

// Runs the export into `writable` in the background and closes the
// paper-trail row with how it ended — BEFORE the reader sees the end of the
// stream or its error, so whoever watches the download finish (or fail) finds
// the row already final: a partial or aborted export is visible in the trail.
function pumpExport(
  writable: WritableStream<Uint8Array>,
  run: { where: Prisma.AuditLogWhereInput; format: ExportFormat; total: number; truncated: boolean },
  finalize: (outcome: { status: ExportStatus; rowCount: number; error?: string }) => Promise<void>,
): void {
  const encoder = new TextEncoder();
  const writer = writable.getWriter();
  // A trailer only when the CSV was cut short (see GET).
  const trailer = run.format === "csv" && run.truncated
    // Protocol marker, not UI copy: a `#` line a spreadsheet shows as one odd
    // last row and a script can grep for.
    ? `# truncated: export capped at ${MAX_EXPORT_RECORDS} of ${run.total} matching rows\n`
    : null;
  void (async () => {
    // .unref(): the producer suspends on its first write until someone reads,
    // and a ref'd timer would hold the event loop open for a caller that
    // never does (the server's listener keeps it alive on its own).
    const overall = setTimeout(
      () => void writer.abort(new Error("Audit log export timed out")).catch(() => {}),
      EXPORT_TIMEOUT_MS,
    ).unref();
    const firstRead = setTimeout(
      () => void writer.abort(new Error("Audit log export was never read")).catch(() => {}),
      FIRST_READ_TIMEOUT_MS,
    ).unref();
    let rowCount = 0;
    let failure: unknown = null;
    try {
      rowCount = await writeExport(async (text) => {
        await writer.write(encoder.encode(text));
        // The reader has started (this write waited for it).
        clearTimeout(firstRead);
      }, run.where, run.format, trailer);
    } catch (err) {
      failure = err;
    } finally {
      clearTimeout(overall);
      clearTimeout(firstRead);
    }
    // Whatever stopped it — the reader leaving, a timeout, a failed read —
    // the row says "aborted" with the error.
    await finalize({
      status: failure === null ? "completed" : "aborted",
      rowCount,
      ...(failure !== null ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
    });
    if (failure !== null) await writer.abort(failure).catch(() => { /* consumer already gone */ });
    else await writer.close().catch(() => { /* consumer already gone */ });
  })();
}

export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const url = req.nextUrl;
  const format: ExportFormat = url.searchParams.get("format") === "json" ? "json" : "csv";
  // The same filter as the list and the page (audit-log-filter.ts), validated
  // up front: an Invalid Date would otherwise throw inside the stream after the
  // response headers were sent — a half-written export and, worse, an audit row
  // never finalized (an exfil-evasion vector).
  const filter = buildAuditLogWhere(url.searchParams);
  if (filter.error) {
    const msg = filter.error === "invalidDateFrom"
      ? t("apiAdmin.auditLog.invalidDateFrom")
      : t("apiAdmin.auditLog.invalidDateTo");
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  const { where } = filter;

  // Audit-log export streams up to MAX_EXPORT_RECORDS rows of PII; throttle to 3/hour per admin.
  // The check sits AFTER parameter validation on purpose: `checkRateLimit` records a hit on every
  // call under the limit, so running it first let three malformed-date 400s (which export nothing)
  // burn the whole hourly budget and lock the admin out of a corrected request. Everything above
  // this line is synchronous, so the placement is equivalent for concurrent callers, and it still
  // precedes the paper-trail `auditLog.create` below — a throttled request writes and reads nothing.
  if (!checkRateLimit(`audit-log-export:${session.user.id}`, 3, 3_600_000)) {
    return NextResponse.json({ error: t("apiAdmin.auditLog.tooManyExports") }, { status: 429 });
  }

  const date = new Date().toISOString().slice(0, 10);

  // Capture filter values pre-stream so the audit row reflects what was actually
  // queried (an unknown action is recorded as null: it filtered nothing); the
  // row count is filled in once the stream completes.
  const filters = { format, ...filter.filters };

  // Audit-log export is itself an audit-relevant action — without a paper-trail row a malicious
  // admin could exfiltrate the entire trail with no record. Write the row BEFORE the stream
  // begins (so a client abort or mid-stream throw can't skip it), then update it with the
  // final row count / status once the stream ends. Through the shared row
  // builder (audit.ts), which sanitizes the client-supplied user agent; a failed
  // write still throws, so no export runs without its row. Named by the account
  // id when it has neither a name nor an email.
  const auditRowId = await logAuditOrFailReturningId({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? session.user.id,
    action: "AUDIT_LOG_EXPORT",
    target: "audit-log:export",
    details: exportDetails(filters, { status: "started", rowCount: 0, truncated: false }),
    ...auditContext(req, session),
  });

  // Counted up front so a capped export can SAY so: the file used to end
  // normally with the oldest rows missing and `truncated: true` written only to
  // the paper-trail row's details. The header is the machine signal; the CSV
  // also carries a trailing comment line (a JSON body is a bare array, kept
  // as-is — scripts parse it — so JSON callers read the header).
  // It runs after the paper-trail row exists (the totals include that row), so
  // a failure here must close the row as failed, or it reads "started" forever.
  let total: number;
  try {
    total = await prisma.auditLog.count({ where });
  } catch (err) {
    console.error(`${LOG_SCOPE} count failed:`, err);
    await finalizeAuditRow(
      auditRowId,
      exportDetails(filters, { status: "failed", rowCount: 0, truncated: false, error: err instanceof Error ? err.message : String(err) }),
      LOG_SCOPE,
    );
    return NextResponse.json({ error: t("apiAdmin.auditLog.exportFailed") }, { status: 500 });
  }
  const truncated = total > MAX_EXPORT_RECORDS;

  // Writing through a TransformStream makes `await writer.write(...)` suspend
  // until the consumer has drained — real backpressure. Producing inside a
  // ReadableStream's start() cannot: enqueue never blocks, pull() is not
  // invoked until start() settles, so up to MAX_EXPORT_RECORDS rows (details
  // VarChar(8000), userAgent 512) piled up in the stream queue while a WAN
  // browser drained at its own pace (the same shape db-export documents).
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  pumpExport(writable, { where, format, total, truncated }, ({ status, rowCount, error }) =>
    finalizeAuditRow(
      auditRowId,
      exportDetails(filters, {
        status,
        rowCount,
        totalMatching: total,
        truncated: truncated || rowCount >= MAX_EXPORT_RECORDS,
        error,
      }),
      LOG_SCOPE,
    ),
  );

  return new NextResponse(readable, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv" : "application/json",
      "Content-Disposition": `attachment; filename="audit-log-${date}.${format}"`,
      "X-Content-Type-Options": "nosniff",
      // IPs and user agents: never kept by a browser or shared cache.
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "true", "X-Export-Limit": String(MAX_EXPORT_RECORDS) } : {}),
    },
  });
});
