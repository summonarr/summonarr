import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCappedOr } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { requireStepUp } from "@/lib/step-up-auth";
import { logAudit, auditContext } from "@/lib/audit";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`discord-link:${session.user.id}`, 5, 10 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }

  let discordId: string | null = null;
  const body = await readJsonCappedOr<{ discordId?: unknown; confirmPassword?: unknown }>(req, 16 * 1024, {});
  if (body instanceof NextResponse) return body;
  // Reject a discordId that is present but not a valid Discord id (a
  // "snowflake"), instead of quietly ignoring it. The /link command in
  // interactions/route.ts only lets that one Discord account redeem a token
  // bound to it; an unbound token can be redeemed by ANY Discord account that
  // sees it. Leaving the field out entirely is fine (the web UI sends no body)
  // and creates an unbound token on purpose.
  const rawDiscordId = body.discordId === undefined || body.discordId === null ? "" : String(body.discordId).trim();
  if (rawDiscordId.length > 0) {
    if (!DISCORD_SNOWFLAKE.test(rawDiscordId)) {
      return NextResponse.json({ error: t("apiUser.discord.invalidDiscordId") }, { status: 400 });
    }
    discordId = rawDiscordId;
  }

  // Step-up (guardrail 6g): a redeemed link lets that Discord account request,
  // report issues and — for a request manager — approve AS this user, and it
  // survives a password change. So a hijacked session must not be able to mint
  // a code for the hijacker's own Discord account. (The iOS app never calls this
  // route; its Discord flow is initiate-merge.)
  const denied = await requireStepUp({
    req,
    session,
    confirmPassword: body.confirmPassword,
    context: "discord-link",
    messages: {
      passwordRequired: t("apiAuth.stepUp.passwordRequired"),
      recentSignInRequired: t("apiAuth.stepUp.recentSignIn"),
    },
    t,
  });
  if (denied) return denied;

  // 16 random bytes = 128 bits (32 hex characters), far too many to guess.
  const token = randomBytes(16).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordLinkToken.upsert({
    where: { userId: session.user.id },
    update: { token, expiresAt, discordId },
    create: { token, userId: session.user.id, expiresAt, discordId },
  });

  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email,
    action: "SETTINGS_CHANGE",
    target: `discord-link:${session.user.id}`,
    details: { type: "discord-link-code", boundToDiscordId: discordId !== null },
    ...auditContext(req, session),
  });

  return NextResponse.json({ token, expiresAt });
});
