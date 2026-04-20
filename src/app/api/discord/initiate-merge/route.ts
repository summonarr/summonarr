import { NextRequest, NextResponse } from "next/server";
import { auth, isTokenExpired } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomInt } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";

const DISCORD_API = "https://discord.com/api/v10";
const SNOWFLAKE_RE = /^\d{17,20}$/;

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session || isTokenExpired(session)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!checkRateLimit(`discord-merge-init:${session.user.id}`, 3, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many requests — please wait 15 minutes before trying again." },
      { status: 429 }
    );
  }

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

  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordMergeCode.upsert({
    where: { userId: session.user.id },
    update: { discordId, code, expiresAt },
    create: { userId: session.user.id, discordId, code, expiresAt },
  });

  const stubUser = alreadyLinked?.email.endsWith("@discord.local") ? alreadyLinked : null;
  const pendingCount = stubUser
    ? await prisma.mediaRequest.count({ where: { requestedBy: stubUser.id } })
    : 0;

  const botToken = botTokenRow.value;
  try {
    const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!dmRes.ok) throw new Error(`Could not open DM channel (${dmRes.status}): ${await dmRes.text()}`);

    const { id: channelId } = (await dmRes.json()) as { id: string };

    const msgRes = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [
          "🔗 **Summonarr account verification**",
          "",
          `Your verification code is: **${code}**`,
          "",
          "Enter this 8-digit code on your Profile page to link your Discord account. It expires in 10 minutes.",
          "",
          "If you did not request this, ignore this message.",
        ].join("\n"),
      }),
    });
    if (!msgRes.ok) throw new Error(`Could not send DM (${msgRes.status}): ${await msgRes.text()}`);
  } catch (err) {
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: "Failed to send Discord DM. Make sure your DMs are open." },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, pendingCount });
}
