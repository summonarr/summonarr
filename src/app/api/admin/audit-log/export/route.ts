import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { auditContext, logAuditOrFailReturningId } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildAuditLogWhere } from "@/lib/audit-log-filter";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const CHUNK_SIZE = 1000;
const MAX_EXPORT_RECORDS = 100_000;

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

export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const url = req.nextUrl;
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
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
  const ctx = auditContext(req, session);
  const exporter = {
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? session.user.id,
  };

  // Audit-log export is itself an audit-relevant action — without a paper-trail row a malicious
  // admin could exfiltrate the entire trail with no record. Write the row BEFORE the stream
  // begins (so a client abort or mid-stream throw can't skip it), then update it with the
  // final row count / status in the finally block. Through the shared row
  // builder (audit.ts), which sanitizes the client-supplied user agent; a failed
  // write still throws, so no export runs without its row.
  const auditRowId = await logAuditOrFailReturningId({
    userId: exporter.userId,
    userName: exporter.userName,
    action: "AUDIT_LOG_EXPORT",
    target: "audit-log:export",
    details: { kind: "audit-log", filters, rowCount: 0, truncated: false, status: "started" },
    ...ctx,
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
    console.error("[audit-log/export] count failed:", err);
    try {
      await prisma.auditLog.update({
        where: { id: auditRowId },
        data: {
          details: JSON.stringify({
            kind: "audit-log",
            filters,
            rowCount: 0,
            truncated: false,
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      });
    } catch (updateErr) {
      console.error("[audit-log/export] failed to finalize audit row:", updateErr);
    }
    return NextResponse.json({ error: t("apiAdmin.auditLog.exportFailed") }, { status: 500 });
  }
  const truncated = total > MAX_EXPORT_RECORDS;

  // Writing through a TransformStream makes `await writer.write(...)` suspend
  // until the consumer has drained — real backpressure. Producing inside a
  // ReadableStream's start() cannot: enqueue never blocks, pull() is not
  // invoked until start() settles, so up to MAX_EXPORT_RECORDS rows (details
  // VarChar(8000), userAgent 512) piled up in the stream queue while a WAN
  // browser drained at its own pace (the same shape db-export documents).
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const write = (text: string) => writer.write(encoder.encode(text));

  void (async () => {
    let totalExported = 0;
    let streamStatus: "completed" | "aborted" = "aborted";
    let streamError: string | null = null;
    let failure: unknown = null;

    try {
      if (format === "csv") {
        await write("id,createdAt,userId,userName,action,target,details,ipAddress,userAgent,provider\n");
      } else {
        await write("[\n");
      }

      let cursor: string | undefined;
      let first = true;

      while (totalExported < MAX_EXPORT_RECORDS) {
        const logs = await prisma.auditLog.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: CHUNK_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        if (logs.length === 0) break;

        for (const log of logs) {
          if (format === "csv") {
            const row = [
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
            await write(row + "\n");
          } else {
            const prefix = first ? "  " : ",\n  ";
            first = false;
            await write(prefix + JSON.stringify(log));
          }
        }

        totalExported += logs.length;
        if (logs.length < CHUNK_SIZE) break;
        cursor = logs[logs.length - 1].id;
      }

      if (format === "json") {
        await write("\n]\n");
      } else if (truncated) {
        // Protocol marker, not UI copy: a `#` line a spreadsheet shows as one
        // odd last row and a script can grep for.
        await write(`# truncated: export capped at ${MAX_EXPORT_RECORDS} of ${total} matching rows\n`);
      }
      streamStatus = "completed";
    } catch (err) {
      failure = err;
      streamError = err instanceof Error ? err.message : String(err);
    }

    // Finalize the paper-trail row BEFORE the consumer sees end-of-stream or the
    // error: whoever observes the download finishing (or failing) must find the
    // row already final — a partial / aborted export is visible in the trail.
    try {
      await prisma.auditLog.update({
        where: { id: auditRowId },
        data: {
          details: JSON.stringify({
            kind: "audit-log",
            filters,
            rowCount: totalExported,
            totalMatching: total,
            truncated: truncated || totalExported >= MAX_EXPORT_RECORDS,
            status: streamStatus,
            ...(streamError ? { error: streamError } : {}),
          }),
        },
      });
    } catch (err) {
      console.error("[audit-log/export] failed to finalize audit row:", err);
    }

    if (failure !== null) await writer.abort(failure).catch(() => { /* consumer already gone */ });
    else await writer.close().catch(() => { /* consumer already gone */ });
  })();

  return new NextResponse(readable, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv" : "application/json",
      "Content-Disposition": `attachment; filename="audit-log-${date}.${format}"`,
      "X-Content-Type-Options": "nosniff",
      ...(truncated ? { "X-Export-Truncated": "true", "X-Export-Limit": String(MAX_EXPORT_RECORDS) } : {}),
    },
  });
});
