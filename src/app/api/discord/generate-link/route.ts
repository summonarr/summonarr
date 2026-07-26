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
  // Fail CLOSED on a malformed snowflake. `discordId` is the binding the /link consumer
  // enforces (interactions/route.ts: `row.discordId && row.discordId !== discordUserId`),
  // so a dropped binding silently downgrades the token to bearer — any Discord account that
  // sees it can redeem it and pull the victim's request/issue/vote history across. Falling
  // through to null on a JSON number or a stray-whitespace paste did exactly that, with a
  // 200 telling the caller the token was account-bound. Omitting the field entirely is still
  // valid (the web UI POSTs no body) and keeps the null binding.
  const rawDiscordId = body.discordId === undefined || body.discordId === null ? "" : String(body.discordId).trim();
  if (rawDiscordId.length > 0) {
    if (!DISCORD_SNOWFLAKE.test(rawDiscordId)) {
      return NextResponse.json({ error: "Invalid discordId" }, { status: 400 });
    }
    discordId = rawDiscordId;
  }

  // 128-bit entropy (32 hex chars) — bumped from 80-bit to resist offline guessing
  const token = randomBytes(16).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordLinkToken.upsert({
    where: { userId: session.user.id },
    update: { token, expiresAt, discordId },
    create: { token, userId: session.user.id, expiresAt, discordId },
  });

  return NextResponse.json({ token, expiresAt });
});
