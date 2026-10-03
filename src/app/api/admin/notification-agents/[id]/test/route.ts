import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { loadedAgentFromRow, sendAgentTest } from "@/lib/notify-agents";
import { SAMPLE_EVENT } from "@/lib/notify-events";
import { checkRateLimit } from "@/lib/rate-limit";

// Sends one sample event to a channel, immediately, with no retry — even when the
// channel is disabled or the feature flag is off, so an admin can verify a
// destination before turning it on. Rate-limited: it fetches an admin-entered URL.
export const POST = withAdmin(async (
  req,
  { params }: { params: Promise<{ id: string }> },
  session,
) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  if (!checkRateLimit(`agent-test:${session.user.id}`, 10, 60_000)) {
    return NextResponse.json({ error: t("apiAdmin.agents.error.rateLimited") }, { status: 429 });
  }
  const row = await prisma.notificationAgent.findUnique({
    where: { id },
    select: { id: true, kind: true, name: true, events: true, config: true, secret: true },
  });
  if (!row) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  const agent = loadedAgentFromRow(row);
  if (!agent) return NextResponse.json({ error: t("apiAdmin.agents.error.invalidStored") }, { status: 400 });
  const r = await sendAgentTest(agent, SAMPLE_EVENT);
  return NextResponse.json({ ok: r.verdict === "ok", status: r.status, error: r.error });
});
