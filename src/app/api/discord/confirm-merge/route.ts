import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { assignDiscordRolesOnLink } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { timingSafeEqual } from "crypto";

// Bot DM template lives in src/app/api/discord/initiate-merge/route.ts
// (the 12-char code copy is updated there).

export const POST = withAuth(async (req, _ctx, session) => {
  if (!checkRateLimit(`discord-merge:${session.user.id}`, 5, 10 * 60 * 1000)) {
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: "rate_limit", message: "Too many attempts. Wait 10 minutes and try again." },
      { status: 429 }
    );
  }

  let code: string;
  try {
    const body = await req.json();
    code = String(body.code ?? "").trim().toUpperCase();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const record = await prisma.discordMergeCode.findUnique({
    where: { userId: session.user.id },
  });

  if (!record) {
    return NextResponse.json(
      { error: "No pending verification — please request a code first." },
      { status: 400 }
    );
  }
  if (record.expiresAt < new Date()) {
    await prisma.discordMergeCode.delete({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: "Code has expired — please request a new one." },
      { status: 400 }
    );
  }
  if (code.length !== record.code.length || !timingSafeEqual(Buffer.from(record.code), Buffer.from(code))) {
    return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
  }

  await prisma.discordMergeCode.delete({ where: { userId: session.user.id } });

  try {
    const { migrated } = await mergeDiscordIntoWebAccount(session.user.id, record.discordId);

    await assignDiscordRolesOnLink(
      record.discordId,
      session.user.email ?? "",
      (session.user.role as "ADMIN" | "ISSUE_ADMIN" | "USER") ?? "USER"
    );

    return NextResponse.json({ ok: true, migrated, discordId: record.discordId });
  } catch {
    return NextResponse.json({ error: "Could not link accounts." }, { status: 409 });
  }
});
