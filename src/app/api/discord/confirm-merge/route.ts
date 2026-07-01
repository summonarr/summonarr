import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { assignDiscordRolesOnLink } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { timingSafeEqual } from "crypto";
import { readJsonCapped } from "@/lib/body-size";

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

  const parsed = await readJsonCapped<{ code?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const code = String(parsed.code ?? "").trim().toUpperCase();

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
    // deleteMany (not delete) — on a concurrent double-submit of an expired code
    // the second delete would throw P2025 → 500; deleteMany no-ops. Matches the
    // race-safe pattern used by the rate-limit path above.
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: "Code has expired — please request a new one." },
      { status: 400 }
    );
  }
  if (code.length !== record.code.length || !timingSafeEqual(Buffer.from(record.code), Buffer.from(code))) {
    return NextResponse.json({ error: "Incorrect code." }, { status: 400 });
  }

  try {
    const { migrated } = await mergeDiscordIntoWebAccount(session.user.id, record.discordId);
    // Consume the code only AFTER the merge succeeds — deleting it first meant a
    // transient merge failure burned the code and the user couldn't retry.
    // deleteMany (not delete): a concurrent duplicate submit races both callers
    // past the merge; the loser's bare delete would throw P2025 into the catch
    // below and turn a SUCCEEDED link into a 409.
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });

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
