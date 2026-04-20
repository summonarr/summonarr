import { prisma } from "./prisma";
import { getClientIp } from "./rate-limit";
import { sanitizeText } from "./sanitize";
import type { AuditAction } from "@/generated/prisma";

export type AuditParams = {
  userId: string;
  userName: string | null | undefined;
  action: AuditAction;
  target: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
  provider?: string | null;
  sessionId?: string | null;
};

// logAudit swallows errors by design — a failed audit write must never break the triggering request
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        userName: sanitizeText(params.userName ?? "unknown"),
        action: params.action,
        target: sanitizeText(params.target),
        details: params.details ? JSON.stringify(params.details) : null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        provider: params.provider ?? null,
        sessionId: params.sessionId ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] Failed to write audit log:", err);
  }
}

// logAuditOrFail is for writes that must succeed (e.g. inside a transaction where failure should roll back)
export async function logAuditOrFail(params: AuditParams): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      userName: sanitizeText(params.userName ?? "unknown"),
      action: params.action,
      target: sanitizeText(params.target),
      details: params.details ? JSON.stringify(params.details) : null,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      provider: params.provider ?? null,
      sessionId: params.sessionId ?? null,
    },
  });
}

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
