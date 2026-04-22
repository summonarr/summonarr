import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { AuditAction, Prisma } from "@/generated/prisma";

const VALID_ACTIONS: AuditAction[] = [
  "REQUEST_APPROVE", "REQUEST_DECLINE", "REQUEST_DELETE",
  "USER_ROLE_CHANGE", "USER_DELETE", "SETTINGS_CHANGE",
  "LIBRARY_SYNC", "ISSUE_STATUS_CHANGE", "MAINTENANCE_TOGGLE",
  "BACKUP_EXPORT", "BACKUP_IMPORT",
  "AUTH_LOGIN", "AUTH_LOGIN_FAILED", "AUTH_LOGOUT",
  "SESSION_REVOKE", "CACHE_WARM", "RATINGS_CACHE_CLEAR", "ISSUE_DELETE",
];

const CHUNK_SIZE = 1000;
const MAX_EXPORT_RECORDS = 100_000;

function escapeCSV(value: string): string {
  // Prefix formula-injection characters to prevent CSV injection in Excel/Sheets
  let safe = value;
  if (/^[=+\-@\t\r]/.test(safe)) {
    safe = `'${safe}`;
  }
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session) || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setDate(end.getDate() + 1);
      where.createdAt.lt = end;
    }
  }
  if (user) where.userName = { contains: user, mode: "insensitive" };
  if (target) where.target = { contains: target, mode: "insensitive" };
  if (hideCron) where.userId = { not: "system" };

  const date = new Date().toISOString().slice(0, 10);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      if (format === "csv") {
        controller.enqueue(encoder.encode("id,createdAt,userId,userName,action,target,details,ipAddress,userAgent,provider\n"));
      } else {
        controller.enqueue(encoder.encode("[\n"));
      }

      let cursor: string | undefined;
      let first = true;
      let totalExported = 0;

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

      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv" : "application/json",
      "Content-Disposition": `attachment; filename="audit-log-${date}.${format}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
