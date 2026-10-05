import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { readJsonCapped } from "@/lib/body-size";
import { logAudit, auditContext } from "@/lib/audit";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateAgentCache } from "@/lib/notify-agents";
import { AGENT_BODY_CAP, AGENT_PUBLIC_SELECT, MAX_AGENTS, destinationDetails, parseAgentInput, toPublicAgent } from "@/lib/notify-agents-admin";

// Outbound notification channels (ADMIN). Instance-wide config, so ADMIN only —
// a channel receives every request and issue event.

export const GET = withAdmin(async () => {
  const rows = await prisma.notificationAgent.findMany({ select: AGENT_PUBLIC_SELECT, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ agents: rows.map(toPublicAgent) });
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, AGENT_BODY_CAP);
  if (parsed instanceof NextResponse) return parsed;
  const r = parseAgentInput(parsed && typeof parsed === "object" ? parsed : {}, null);
  if (!r.ok) return NextResponse.json({ error: t(`apiAdmin.agents.error.${r.error}`) }, { status: 400 });

  if ((await prisma.notificationAgent.count()) >= MAX_AGENTS) {
    return NextResponse.json({ error: t("apiAdmin.agents.error.tooMany", { max: MAX_AGENTS }) }, { status: 400 });
  }
  const { kind, name, enabled, events, config, secret } = r.input;
  // `secret` is plaintext here; the Prisma extension encrypts it (guardrail 7a).
  const row = await prisma.notificationAgent.create({
    data: { kind, name, enabled, events, config: config as object, secret: secret ?? null },
    select: AGENT_PUBLIC_SELECT,
  });
  invalidateAgentCache();
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `notification-agent:${row.id}`,
    details: { op: "create", kind, name, events, enabled, ...destinationDetails(config) },
    ...auditContext(req, session),
  });
  return NextResponse.json({ agent: toPublicAgent(row) }, { status: 201 });
});
