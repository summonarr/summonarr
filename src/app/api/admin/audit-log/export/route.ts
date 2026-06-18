import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import type { AuditAction, Prisma } from "@/generated/prisma";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

const VALID_ACTIONS: AuditAction[] = AUDIT_ACTIONS;

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
  // Audit-log export streams up to MAX_EXPORT_RECORDS rows of PII; throttle to 3/hour per admin
  if (!checkRateLimit(`audit-log-export:${session.user.id}`, 3, 3_600_000)) {
    return NextResponse.json({ error: "Too many exports — try again later" }, { status: 429 });
  }

  const url = req.nextUrl;
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const action = url.searchParams.get("action") as AuditAction | null;
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const user = url.searchParams.get("user");
  const target = url.searchParams.get("target");
  const hideCron = url.searchParams.get("hideCron") === "1";

  const where: Prisma.AuditLogWhereInput = {};
  if (action && VALID_ACTIONS.includes(action)) where.action = action;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    // Validate dates up front. An Invalid Date would otherwise throw inside the ReadableStream's
    // start() callback after response headers were sent — producing a half-written export and,
    // worse, skipping the audit row at the bottom of the stream (an exfil-evasion vector).
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: "Invalid dateFrom" }, { status: 400 });
      }
      where.createdAt.gte = d;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      if (isNaN(end.getTime())) {
        return NextResponse.json({ error: "Invalid dateTo" }, { status: 400 });
      }
      end.setDate(end.getDate() + 1);
      where.createdAt.lt = end;
    }
  }
  if (user) where.userName = { contains: user, mode: "insensitive" };
  if (target) where.target = { contains: target, mode: "insensitive" };
  if (hideCron) where.userId = { not: "system" };

  const date = new Date().toISOString().slice(0, 10);

  // Audit-log export is itself an audit-relevant action — a malicious admin
  // could otherwise exfiltrate the entire trail with no record. Filter
  // values are captured pre-stream so the audit row reflects what was
  // actually queried; the row count is filled in once the stream completes.
  const filters = {
    format,
    action: action ?? null,
    dateFrom: dateFrom ?? null,
    dateTo: dateTo ?? null,
    user: user ?? null,
    target: target ?? null,
    hideCron,
  };
  const ctx = auditContext(req, session);
  const exporter = {
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? session.user.id,
  };

  // Audit-log export is itself an audit-relevant action — without a paper-trail row a malicious
  // admin could exfiltrate the entire trail with no record. Write the row BEFORE the stream
  // begins (so a client abort or mid-stream throw can't skip it), then update it with the
  // final row count / status in the finally block.
  const auditRow = await prisma.auditLog.create({
    data: {
      userId: exporter.userId,
      userName: exporter.userName,
      action: "AUDIT_LOG_EXPORT",
      target: "audit-log:export",
      details: JSON.stringify({
        kind: "audit-log",
        filters,
        rowCount: 0,
        truncated: false,
        status: "started",
      }),
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      provider: ctx.provider ?? null,
    },
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let totalExported = 0;
      let streamStatus: "completed" | "aborted" = "aborted";
      let streamError: string | null = null;

      try {
        if (format === "csv") {
          controller.enqueue(encoder.encode("id,createdAt,userId,userName,action,target,details,ipAddress,userAgent,provider\n"));
        } else {
          controller.enqueue(encoder.encode("[\n"));
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
              controller.enqueue(encoder.encode(row + "\n"));
            } else {
              const prefix = first ? "  " : ",\n  ";
              first = false;
              controller.enqueue(encoder.encode(prefix + JSON.stringify(log)));
            }
          }

          totalExported += logs.length;
          if (logs.length < CHUNK_SIZE) break;
          cursor = logs[logs.length - 1].id;
        }

        if (format === "json") {
          controller.enqueue(encoder.encode("\n]\n"));
        }
        streamStatus = "completed";
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
        try { controller.error(err); } catch { /* already closed */ }
      } finally {
        // Always update the audit row with the final state so a partial / aborted export is
        // visible in the audit trail.
        try {
          await prisma.auditLog.update({
            where: { id: auditRow.id },
            data: {
              details: JSON.stringify({
                kind: "audit-log",
                filters,
                rowCount: totalExported,
                truncated: totalExported >= MAX_EXPORT_RECORDS,
                status: streamStatus,
                ...(streamError ? { error: streamError } : {}),
              }),
            },
          });
        } catch (err) {
          console.error("[audit-log/export] failed to finalize audit row:", err);
        }
        try { controller.close(); } catch { /* already errored */ }
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv" : "application/json",
      "Content-Disposition": `attachment; filename="audit-log-${date}.${format}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
