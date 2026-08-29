import { prisma } from "./prisma";
import { getClientIp } from "./rate-limit";
import { sanitizeForLog, sanitizeText } from "./sanitize";
import type { AuditAction } from "@/generated/prisma";

export type AuditParams = {
  // null for non-user actors (e.g. machine sessions) — the AuditLog.userId
  // column is nullable. Most callers pass a real user id.
  userId: string | null;
  userName: string | null | undefined;
  action: AuditAction;
  target: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  provider?: string | null;
  sessionId?: string | null;
};

// One builder for both writers so the sanitization set cannot drift between
// them. userAgent is a raw attacker-controlled request header rendered into the
// admin audit table (tooltip title attribute), so it gets the full
// sanitizeForLog strip (controls + bidi overrides); ipAddress is normally a
// validated getClientIp value but is sanitized the same way as belt-and-braces.
function auditRowData(params: AuditParams) {
  return {
    userId: params.userId,
    userName: sanitizeText(params.userName ?? "unknown"),
    action: params.action,
    target: sanitizeText(params.target),
    details: params.details ? JSON.stringify(params.details) : null,
    ipAddress: params.ipAddress ? sanitizeForLog(params.ipAddress) : null,
    userAgent: params.userAgent ? sanitizeForLog(params.userAgent) : null,
    provider: params.provider ?? null,
    sessionId: params.sessionId ?? null,
  };
}

// logAudit swallows errors by design — a failed audit write must never break the triggering request
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({ data: auditRowData(params) });
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err);
  }
}

// logAuditOrFail is for writes that must succeed (e.g. inside a transaction where failure should roll back)
export async function logAuditOrFail(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({ data: auditRowData(params) });
}

// PII retention window for audit rows, in days. Both scrub paths (the
// scrub-audit-pii cron and the manual DELETE /api/admin/audit-log) derive their
// cutoff from this ONE reader so the promise they enforce can't drift. The
// bounds mirror the write-side validation in /api/settings — clamping here too
// means a hand-edited Setting row can't silently scrub yesterday's log.
export const AUDIT_PII_RETENTION_DEFAULT_DAYS = 90;
export const AUDIT_PII_RETENTION_MIN_DAYS = 7;
export const AUDIT_PII_RETENTION_MAX_DAYS = 3650;

export async function getAuditPiiRetentionDays(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "auditPiiRetentionDays" } });
    if (!row) return AUDIT_PII_RETENTION_DEFAULT_DAYS;
    const n = parseInt(row.value, 10);
    if (!Number.isInteger(n)) return AUDIT_PII_RETENTION_DEFAULT_DAYS;
    return Math.min(AUDIT_PII_RETENTION_MAX_DAYS, Math.max(AUDIT_PII_RETENTION_MIN_DAYS, n));
  } catch {
    // A read failure must not block the scrub — fall back to the documented default.
    return AUDIT_PII_RETENTION_DEFAULT_DAYS;
  }
}

// Builds the ip/userAgent/provider context for an audit entry from the request headers + session.
export function auditContext(
  req: Request | { headers: Headers },
  session?: { user?: { provider?: string } } | null,
) {
  const headers = req.headers;
  return {
    ipAddress: getClientIp(headers as Headers),
    userAgent: headers.get("user-agent")?.slice(0, 512) ?? null,
    provider: session?.user?.provider ?? null,
  };
}
