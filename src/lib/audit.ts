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

// One builder for every writer so the sanitization set cannot drift between
// them. userAgent is a raw attacker-controlled request header rendered into the
// admin audit table (tooltip title attribute), so it gets the full
// sanitizeForLog strip (controls + bidi overrides); ipAddress is normally a
// validated getClientIp value but is sanitized the same way as an extra safety step.
//
// target and details are bounded too: a caller logging a large list (settings
// keys, instance lists, error arrays) would otherwise write a row the viewer
// and the export load whole. An oversized details is replaced by a marker
// object, so the column still holds valid JSON for every reader.
export const MAX_AUDIT_TARGET_LENGTH = 512;
// Cap for the short identity columns (name, address, agent, provider), so a caller that
// passes a raw value straight in can never write an unbounded string.
const MAX_AUDIT_FIELD_LENGTH = 512;
export const MAX_AUDIT_DETAILS_LENGTH = 16 * 1024;

export function auditDetailsJson(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const json = JSON.stringify(details);
  if (json.length <= MAX_AUDIT_DETAILS_LENGTH) return json;
  return JSON.stringify({ truncated: true, originalLength: json.length, keys: Object.keys(details).slice(0, 50) });
}

function auditRowData(params: AuditParams) {
  return {
    userId: params.userId,
    userName: sanitizeText(params.userName ?? "unknown").slice(0, MAX_AUDIT_FIELD_LENGTH),
    action: params.action,
    target: sanitizeText(params.target).slice(0, MAX_AUDIT_TARGET_LENGTH),
    details: auditDetailsJson(params.details),
    ipAddress: params.ipAddress ? sanitizeForLog(params.ipAddress).slice(0, MAX_AUDIT_FIELD_LENGTH) : null,
    userAgent: params.userAgent ? sanitizeForLog(params.userAgent).slice(0, MAX_AUDIT_FIELD_LENGTH) : null,
    provider: params.provider ? params.provider.slice(0, MAX_AUDIT_FIELD_LENGTH) : null,
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

// logAudit for a row the caller finalizes later (an export's outcome): the same
// swallowing contract, returning the row's id, or null when the write failed.
export async function logAuditReturningId(params: AuditParams): Promise<string | null> {
  try {
    const row = await prisma.auditLog.create({ data: auditRowData(params), select: { id: true } });
    return row.id;
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err);
    return null;
  }
}

// logAuditOrFail is for writes that must succeed (e.g. inside a transaction where failure should roll back)
export async function logAuditOrFail(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({ data: auditRowData(params) });
}

// logAuditOrFail answering the row's id — for a row that must exist before the
// caller goes on and that it finalizes later (the audit-log export's paper trail).
export async function logAuditOrFailReturningId(params: AuditParams): Promise<string> {
  const row = await prisma.auditLog.create({ data: auditRowData(params), select: { id: true } });
  return row.id;
}

// logAuditOrFail on a transaction client: the row is written INSIDE the caller's
// $transaction, so a failed write rolls back the mutation it audits (guardrail 26).
// Never caught here — a swallowed error inside a tx turns its COMMIT into a
// silent ROLLBACK (guardrail 23). Await it in sequence with the tx's other
// queries (guardrail 23c).
export async function logAuditTx(tx: Pick<typeof prisma, "auditLog">, params: AuditParams): Promise<void> {
  await tx.auditLog.create({ data: auditRowData(params) });
}

// PII retention window for audit rows, in days. Both scrub paths (the
// scrub-audit-pii cron and the manual DELETE /api/admin/audit-log) derive their
// cutoff from this ONE reader so the promise they enforce can't drift. The
// bounds mirror the write-side validation in /api/settings — clamping here too
// means a hand-edited Setting row can't silently scrub yesterday's log.
export const AUDIT_PII_RETENTION_DEFAULT_DAYS = 90;
export const AUDIT_PII_RETENTION_MIN_DAYS = 7;
export const AUDIT_PII_RETENTION_MAX_DAYS = 3650;

// The userName the PII scrub (DELETE /api/admin/audit-log + the
// scrub-audit-pii cron) writes over every row past the retention window. Both
// scrub paths write and filter on this constant; the admin audit-log viewer
// compares against it to render a muted, translated "redacted" instead of an English token
// dressed as an account name — so the two must keep agreeing. This module pulls
// in prisma, so a "use client" component never imports it: the audit-log page
// (a server component) hands the value down as a prop.
export const REDACTED_USER_NAME = "[redacted]";

export async function getAuditPiiRetentionDays(): Promise<number> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "auditPiiRetentionDays" } });
    if (!row) return AUDIT_PII_RETENTION_DEFAULT_DAYS;
    const n = parseInt(row.value, 10);
    if (!Number.isInteger(n)) return AUDIT_PII_RETENTION_DEFAULT_DAYS;
    return Math.min(AUDIT_PII_RETENTION_MAX_DAYS, Math.max(AUDIT_PII_RETENTION_MIN_DAYS, n));
  } catch (err) {
    // A failed read must never scrub MORE than the admin chose: the scrub is
    // irreversible, and the default (90) is shorter than any longer setting.
    // The longest window scrubs (next to) nothing; the next run reads again.
    console.warn("[audit] couldn't read the PII retention setting; scrubbing with the longest window this run:", err instanceof Error ? err.message : err);
    return AUDIT_PII_RETENTION_MAX_DAYS;
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

// Who did it, and from where: the signed-in actor plus auditContext, spread
// into a logAudit call. Read when called, so a background job that outlives
// the request can hold the result.
export function auditActor(
  req: Request | { headers: Headers },
  session: { user: { id: string; name?: string | null; email?: string | null; provider?: string } },
) {
  return {
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    ...auditContext(req, session),
  };
}

// Rewrites the details of a row written earlier (an export's paper trail,
// closed with how it ended). Swallows like logAudit: the operation it records
// has already happened, so a failed write only leaves the row unfinished.
export async function finalizeAuditRow(id: string, details: Record<string, unknown>, scope: string): Promise<void> {
  try {
    await prisma.auditLog.update({ where: { id }, data: { details: auditDetailsJson(details) } });
  } catch (err) {
    console.error(`${scope} failed to finalize audit row:`, err);
  }
}
