import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateAgentCache } from "@/lib/notify-agents";
import { AGENT_BODY_CAP, AGENT_PUBLIC_SELECT, destinationDetails, parseAgentInput, toPublicAgent } from "@/lib/notify-agents-admin";

export const PATCH = withAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const parsed = await readJsonCapped<Record<string, unknown>>(req, AGENT_BODY_CAP);
  if (parsed instanceof NextResponse) return parsed;
  const existing = await prisma.notificationAgent.findUnique({ where: { id }, select: { kind: true, name: true, enabled: true, events: true, config: true } });
  if (!existing) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  const r = parseAgentInput(parsed && typeof parsed === "object" ? parsed : {}, existing);
  if (!r.ok) return NextResponse.json({ error: t(`apiAdmin.agents.error.${r.error}`) }, { status: 400 });

  const { name, enabled, events, config, secret } = r.input;
  // updateMany so a concurrent delete answers 404 instead of throwing P2025.
  const res = await prisma.notificationAgent.updateMany({
    where: { id },
    data: { name, enabled, events, config: config as object, ...(secret !== undefined ? { secret } : {}) },
  });
  if (res.count === 0) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  invalidateAgentCache();
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `notification-agent:${id}`,
    details: { op: "update", name, events, enabled, secretChanged: secret !== undefined, ...destinationDetails(config) },
    ...auditContext(req, session),
  });
  const row = await prisma.notificationAgent.findUnique({ where: { id }, select: AGENT_PUBLIC_SELECT });
  if (!row) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  return NextResponse.json({ agent: toPublicAgent(row) });
});

export const DELETE = withAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const res = await prisma.notificationAgent.deleteMany({ where: { id } });
  if (res.count === 0) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  invalidateAgentCache();
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `notification-agent:${id}`,
    details: { op: "delete" },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
