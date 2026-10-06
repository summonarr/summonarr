import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];
const SNOWFLAKE_RE = /^\d{17,20}$/;

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<{ discordId?: unknown }>(req, 16384);
  if (parsed instanceof NextResponse) return parsed;
  const discordId = String(parsed.discordId ?? "").trim();

  if (!SNOWFLAKE_RE.test(discordId)) {
    return NextResponse.json(
      { error: t("apiUser.discord.merge.invalidUserId") },
      { status: 400 }
    );
  }

  // Global per-user cap: the per-target bucket alone lets one account DM
  // hundreds of distinct snowflakes (each unique target gets its own bucket).
  // This caps total merge-init DMs across ALL targets for one user.
  if (!checkRateLimit(`discord-merge-init-global:${session.user.id}`, 10, 60 * 60_000)) {
    return NextResponse.json(
      { error: t("apiUser.discord.merge.tooManyAttempts") },
      { status: 429 }
    );
  }

  // A second, tighter limit per (user, target Discord id): at most 3 codes for
  // the same Discord account every 15 minutes.
  if (!checkRateLimit(`discord-merge-init:${session.user.id}:${discordId}`, 3, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: t("apiUser.discord.merge.waitFifteen") },
      { status: 429 }
    );
  }

  // Deliberately NO "is this snowflake already linked to another account" check
  // here. Answering 409 before the DM let any signed-in caller map which guild
  // members hold a real Summonarr account (a free id answered 200/502). The
  // collision is surfaced by confirm-merge instead — mergeDiscordIntoWebAccount
  // refuses it — i.e. only AFTER the caller has proven control of the Discord
  // account by reading the code. The owner of a taken id receives a DM they did
  // not ask for; the text says to ignore it, and the per-target limit above
  // bounds how often. A @discord.local shadow proceeds as before.

  const botTokenRow = await prisma.setting.findUnique({ where: { key: "discordBotToken" } });
  if (!botTokenRow?.value) {
    return NextResponse.json({ error: t("apiUser.discord.merge.botNotConfigured") }, { status: 503 });
  }

  // 6 random bytes = 12 hex characters (~48 bits). Together with the rate
  // limits, that is far too many to guess in the 10-minute window.
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
      // Written in the requesting user's language (the same translator every
      // other reply of this route uses); the code itself is interpolated.
      body: JSON.stringify({
        content: [
          t("notify.bot.merge.dm.title"),
          "",
          t("notify.bot.merge.dm.code", { code }),
          "",
          t("notify.bot.merge.dm.instructions"),
          "",
          t("notify.bot.merge.dm.ignore"),
        ].join("\n"),
      }),
    });
    if (!msgRes.ok) throw new Error(`Could not send DM (${msgRes.status}): ${await msgRes.text()}`);
  } catch (err) {
    console.warn("[discord/initiate-merge] DM failed:", err);
    await prisma.discordMergeCode.deleteMany({ where: { userId: session.user.id } });
    return NextResponse.json(
      { error: t("apiUser.discord.merge.dmFailed") },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
});
