import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { auditContext } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import type { AuditAction, Prisma } from "@/generated/prisma";
import { AUDIT_ACTIONS, ACTION_GROUP, type AuditGroup } from "@/lib/audit-actions";
import { sanitizeContainsSearch } from "@/lib/sanitize";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const VALID_ACTIONS: AuditAction[] = AUDIT_ACTIONS;

// Coarse group filter — derived from the shared ACTION_GROUP so the schema enum
// is the single source of truth, matching the audit-log list route.
const GROUP_ACTIONS: Record<AuditGroup, AuditAction[]> = {
  auth: [],
  admin: [],
  system: [],
};
for (const action of AUDIT_ACTIONS) {
  GROUP_ACTIONS[ACTION_GROUP[action]].push(action);
}

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
  const action = url.searchParams.get("action") as AuditAction | null;
  const groupParam = url.searchParams.get("group");
  const group: AuditGroup | null =
    groupParam === "auth" || groupParam === "admin" || groupParam === "system"
      ? groupParam
      : null;
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const user = url.searchParams.get("user");
  const target = url.searchParams.get("target");
  const hideCron = url.searchParams.get("hideCron") === "1";

  const where: Prisma.AuditLogWhereInput = {};
  // Action is more specific than group — action wins if both are present
  if (action && VALID_ACTIONS.includes(action)) {
    where.action = action;
  } else if (group) {
    where.action = { in: GROUP_ACTIONS[group] };
  }
  if (dateFrom || dateTo) {
    where.createdAt = {};
    // Validate dates up front. An Invalid Date would otherwise throw inside the ReadableStream's
    // start() callback after response headers were sent — producing a half-written export and,
    // worse, skipping the audit row at the bottom of the stream (an exfil-evasion vector).
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (isNaN(d.getTime())) {
        return NextResponse.json({ error: t("apiAdmin.auditLog.invalidDateFrom") }, { status: 400 });
      }
      where.createdAt.gte = d;
    }
    if (dateTo) {
      const end = new Date(dateTo);
      if (isNaN(end.getTime())) {
        return NextResponse.json({ error: t("apiAdmin.auditLog.invalidDateTo") }, { status: 400 });
      }
      // UTC day arithmetic — see the list route; the two must agree on the bound.
      end.setUTCDate(end.getUTCDate() + 1);
      where.createdAt.lt = end;
    }
  }
  // Prisma `contains` → ILIKE with no ESCAPE clause; strip wildcard
  // metacharacters and bound the length (search-box DoS, matches /api/votes).
  if (user) where.userName = { contains: sanitizeContainsSearch(user), mode: "insensitive" };
  if (target) where.target = { contains: sanitizeContainsSearch(target), mode: "insensitive" };
  // "Hide cron" means hide the SYSTEM principal, not hide every row without a
  // user. `{ not: "system" }` compiles to `"userId" <> 'system'`, and in SQL
  // NULL <> 'system' is NULL, not TRUE — so Postgres drops every NULL-userId row
  // too. Three writers produce those, and the one that matters is
  // /api/auth/machine-session, which mints an ADMIN-impersonating JWT from
  // CRON_SECRET and is deliberately attributed to the machine rather than to the
  // assumed admin. That row is the only record the mint happened, and ticking a
  // filter labelled "Showing only real users" silently removed it — including
  // from the CSV/JSON export.
  if (hideCron) where.AND = [{ OR: [{ userId: null }, { userId: { not: "system" } }] }];

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
  // queried; the row count is filled in once the stream completes.
  const filters = {
    format,
    action: action ?? null,
    group: group ?? null,
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

  // Counted up front so a capped export can SAY so: the file used to end
  // normally with the oldest rows missing and `truncated: true` written only to
  // the paper-trail row's details. The header is the machine signal; the CSV
  // also carries a trailing comment line (a JSON body is a bare array, kept
  // as-is — scripts parse it — so JSON callers read the header).
  const total = await prisma.auditLog.count({ where });
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
        where: { id: auditRow.id },
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
