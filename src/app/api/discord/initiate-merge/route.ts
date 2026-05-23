import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { safeFetchTrusted } from "@/lib/safe-fetch";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];
const SNOWFLAKE_RE = /^\d{17,20}$/;

export const POST = withAuth(async (req, _ctx, session) => {
  let discordId: string;
  try {
    const body = await req.json();
    discordId = String(body.discordId ?? "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!SNOWFLAKE_RE.test(discordId)) {
    return NextResponse.json(
      { error: "Invalid Discord user ID — it must be a 17–20 digit number." },
      { status: 400 }
    );
  }

  // Rate-limit per (user, target discord id): a single attacker iterating
  // through victim discord IDs can't share the bucket with their own attempts
  if (!checkRateLimit(`discord-merge-init:${session.user.id}:${discordId}`, 3, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many requests — please wait 15 minutes before trying again." },
      { status: 429 }
    );
  }

  const alreadyLinked = await prisma.user.findUnique({ where: { discordId } });
  if (
    alreadyLinked &&
    alreadyLinked.id !== session.user.id &&
    !alreadyLinked.email.endsWith("@discord.local")
  ) {
    return NextResponse.json(
      { error: "Could not initiate account linking. Please try again later." },
      { status: 409 }
    );
  }

  const botTokenRow = await prisma.setting.findUnique({ where: { key: "discordBotToken" } });
  if (!botTokenRow?.value) {
    return NextResponse.json({ error: "Discord bot is not configured." }, { status: 503 });
  }

  // 12 hex chars (~48 bits) — bumped from 8 decimal digits (~26 bits) to
  // resist online guessing within the 10-min window
  const code = randomBytes(6).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordMergeCode.upsert({
    where: { userId: session.user.id },
    update: { discordId, code, expiresAt },
    create: { userId: session.user.id, discordId, code, expiresAt },
  });

  // Note: do NOT return a pendingCount for the stub user here. Returning it pre-confirmation lets
  // any authenticated caller probe arbitrary Discord snowflakes for shadow-account activity counts
  // (an enumeration oracle), since the response leaks information about a target the caller has
  // not yet proven control of. The confirm-merge endpoint returns `migrated` post-verification,
  // which conveys the same UX information only to a verified owner of the Discord account.

  const botToken = botTokenRow.value;
  try {
    const dmRes = await safeFetchTrusted(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: discordId }),
      allowedHosts: DISCORD_HOSTS,
    });
    if (!dmRes.ok) throw new Error(`Could not open DM channel (${dmRes.status}): ${await dmRes.text()}`);

    const { id: channelId } = (await dmRes.json()) as { id: string };

    const msgRes = await safeFetchTrusted(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      allowedHosts: DISCORD_HOSTS,
      body: JSON.stringify({
        content: [
          "🔗 **Summonarr account verification**",
          "",
          `Your verification code is: **${code}**`,
          "",
          "Enter this 12-character code on your Profile page to link your Discord account. It expires in 10 minutes.",
          "",
          "If you did not request this, ignore this message.",
        ].join("\n"),
      }),
    });
    if (!msgRes.ok) throw new Error(`Could not send DM (${msgRes.status}): ${await msgRes.text()}`);
  } catch (err) {
    console.warn("[discord/initiate-merge] DM failed:", err);
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: "Failed to send Discord DM. Make sure your DMs are open." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
});
