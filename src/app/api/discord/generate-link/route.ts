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
  if (typeof body.discordId === "string" && DISCORD_SNOWFLAKE.test(body.discordId)) {
    discordId = body.discordId;
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
