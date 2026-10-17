import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { DiscordCodeAlreadyUsedError, mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { assignDiscordRolesOnLink } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { discordMergeCodeMatches, isDiscordMergeCodeMac, normalizeDiscordMergeCode } from "@/lib/discord-merge-code";

// Step 2 of linking a Discord account: the user types in the 12-character code
// the bot sent them by DM (step 1 is discord/initiate-merge, which also holds
// the DM text).

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  if (!checkRateLimit(`discord-merge:${session.user.id}`, 5, 10 * 60 * 1000)) {
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: "rate_limit", message: t("apiUser.discord.merge.rateLimited") },
      { status: 429 }
    );
  }

  const parsed = await readJsonCapped<{ code?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const code = normalizeDiscordMergeCode(String(parsed.code ?? ""));

  const record = await prisma.discordMergeCode.findUnique({
    where: { userId: session.user.id },
  });

  if (!record) {
    return NextResponse.json(
      { error: t("apiUser.discord.merge.noPending") },
      { status: 400 }
    );
  }
  // A row that holds no MAC was written before codes were stored hashed: its
  // plaintext is never compared (that would keep the stored value usable as the
  // credential), so it reads as expired and the user requests a new code.
  if (record.expiresAt < new Date() || !isDiscordMergeCodeMac(record.code)) {
    // deleteMany (not delete) — on a concurrent double-submit of an expired code
    // the second delete would throw P2025 → 500; deleteMany no-ops. Matches the
    // race-safe pattern used by the rate-limit path above.
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: t("apiUser.discord.merge.expired") },
      { status: 400 }
    );
  }
  // The row holds an HMAC of the code (discord-merge-code.ts), compared in
  // constant time. Any input is hashed first, so a multibyte or odd-length
  // submission is a plain mismatch, never a timingSafeEqual length throw.
  if (!discordMergeCodeMatches(record.code, session.user.id, record.discordId, code)) {
    return NextResponse.json({ error: t("apiUser.discord.merge.incorrect") }, { status: 400 });
  }

  try {
    // The code is consumed INSIDE the merge transaction (claimCode): a
    // concurrent double-submit merges once, and a failed merge rolls the delete
    // back so the user can retry. The claim names the exact row verified above,
    // so a code re-sent in between is not consumed by the old one.
    const { migrated } = await mergeDiscordIntoWebAccount(session.user.id, record.discordId, {
      claimCode: async (tx) => {
        const { count } = await tx.discordMergeCode.deleteMany({
          where: { userId: session.user.id, discordId: record.discordId, code: record.code },
        });
        return count === 1;
      },
    });

    await assignDiscordRolesOnLink(
      record.discordId,
      session.user.email ?? "",
      (session.user.role as "ADMIN" | "ISSUE_ADMIN" | "USER") ?? "USER"
    );

    return NextResponse.json({ ok: true, migrated, discordId: record.discordId });
  } catch (err) {
    if (err instanceof DiscordCodeAlreadyUsedError) {
      // Lost the claim. A double-submit whose twin already linked THIS Discord
      // account succeeded, so say so; anything else (the code was re-sent or
      // swept in between) has no pending code left.
      const now = await prisma.user.findUnique({ where: { id: session.user.id }, select: { discordId: true } });
      if (now?.discordId === record.discordId) {
        return NextResponse.json({ ok: true, migrated: 0, discordId: record.discordId });
      }
      return NextResponse.json({ error: t("apiUser.discord.merge.noPending") }, { status: 400 });
    }
    return NextResponse.json({ error: t("apiUser.discord.merge.linkFailed") }, { status: 409 });
  }
});
