import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { mergeDiscordIntoWebAccount } from "@/lib/discord-merge";
import { assignDiscordRolesOnLink } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { timingSafeEqual } from "crypto";
import { readJsonCapped } from "@/lib/body-size";

// Step 2 of linking a Discord account: the user types in the 12-character code
// the bot sent them by DM (step 1 is discord/initiate-merge, which also holds
// the DM text).

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
  // timingSafeEqual throws if the two buffers differ in length, so compare the
  // BYTE lengths first. A string length check is not enough: a 12-character
  // code with non-ASCII letters is more than 12 bytes, and the throw would
  // turn "Incorrect code" into a 500.
  const expected = Buffer.from(record.code, "utf8");
  const supplied = Buffer.from(code, "utf8");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
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
