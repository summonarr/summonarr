import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCappedOr } from "@/lib/body-size";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`discord-link:${session.user.id}`, 5, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  let discordId: string | null = null;
  const body = await readJsonCappedOr<{ discordId?: unknown }>(req, 16 * 1024, {});
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
      return NextResponse.json({ error: "Invalid discordId" }, { status: 400 });
    }
    discordId = rawDiscordId;
  }

  // 16 random bytes = 128 bits (32 hex characters), far too many to guess.
  const token = randomBytes(16).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordLinkToken.upsert({
    where: { userId: session.user.id },
    update: { token, expiresAt, discordId },
    create: { token, userId: session.user.id, expiresAt, discordId },
  });

  return NextResponse.json({ token, expiresAt });
});
