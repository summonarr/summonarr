import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof NextResponse) return session;

  if (!checkRateLimit(`discord-link:${session.user.id}`, 5, 10 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many requests — try again later" }, { status: 429 });
  }

  let discordId: string | null = null;
  try {
    const body = await req.json().catch(() => ({})) as { discordId?: unknown };
    if (typeof body.discordId === "string" && DISCORD_SNOWFLAKE.test(body.discordId)) {
      discordId = body.discordId;
    }
  } catch { }

  const token = randomBytes(10).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordLinkToken.upsert({
    where: { userId: session.user.id },
    update: { token, expiresAt, discordId },
    create: { token, userId: session.user.id, expiresAt, discordId },
  });

  return NextResponse.json({ token, expiresAt });
}
