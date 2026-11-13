import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { safeFetchTrusted } from "@/lib/safe-fetch";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { isNativeSessionForStepUp, requireStepUp } from "@/lib/step-up-auth";
import { requireStepUpSecondFactor } from "@/lib/step-up-second-factor";
import { generateDiscordMergeCode } from "@/lib/discord-merge-code";
import { isFeatureEnabled } from "@/lib/features";
import { check, v } from "@/lib/validate";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];
const SNOWFLAKE_RE = /^\d{17,20}$/;
// Discord's answer to opening a DM channel: only its id is read, and it goes
// into the next request's path, so it must be a snowflake.
const DmChannel = v.object({ id: v.string() });

export const POST = withAuth(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  // With the Discord integration switched off nothing is linked and nobody is
  // DM'd, even with a bot token still saved. First, so a refusal spends no rate
  // limit, step-up or write.
  if (!(await isFeatureEnabled("feature.integration.discord"))) {
    return NextResponse.json({ error: t("apiUser.discord.disabled") }, { status: 403 });
  }
  const parsed = await readJsonCapped<{ discordId?: unknown; confirmPassword?: unknown; secondFactor?: unknown }>(req, 16384);
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
  // Both limits are PEEKED here and spent only once the step-up has passed,
  // below: the web client's first request never carries the password, so
  // spending here used two hits per code and refused the second code.
  const globalKey = `discord-merge-init-global:${session.user.id}`;
  const targetKey = `discord-merge-init:${session.user.id}:${discordId}`;
  if (!peekRateLimit(globalKey, 10, 60 * 60_000)) {
    return NextResponse.json(
      { error: t("apiUser.discord.merge.tooManyAttempts") },
      { status: 429 }
    );
  }

  // A second, tighter limit per (user, target Discord id): at most 3 codes for
  // the same Discord account every 15 minutes.
  if (!peekRateLimit(targetKey, 3, 15 * 60 * 1000)) {
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

  // Step-up (guardrail 6g), as generate-link: a hijacked WEB session must not be
  // able to link the hijacker's own Discord account. A native (iOS) session is
  // exempt — the shipped app has no step-up prompt here (guardrail 25: additive
  // only) and its token lives in the Keychain, not an ambient cookie. "Native"
  // is isNativeSessionForStepUp (step-up-auth.ts): the never-expiring deadline
  // (guardrail 6c), or a pre-6c 1-year session told by its AuthSession row and
  // presented as a bearer — NOT the transport alone: a stolen browser cookie
  // replayed as a bearer token is still a web session and still gets the step-up.
  if (!(await isNativeSessionForStepUp(session, req))) {
    const denied = await requireStepUp({
      req,
      session,
      confirmPassword: parsed.confirmPassword,
      context: "discord-merge",
      messages: {
        passwordRequired: t("apiAuth.stepUp.passwordRequired"),
        recentSignInRequired: t("apiAuth.stepUp.recentSignIn"),
      },
      t,
    });
    if (denied) return denied;
    // An account with an active second factor also presents a fresh one, after
    // the password and before a code is stored or DMed
    // (step-up-second-factor.ts). Inside the web-only branch: the native
    // exemption above covers both halves, for the same reason.
    const factorDenied = await requireStepUpSecondFactor({ req, session, secondFactor: parsed.secondFactor, context: "discord-merge" });
    if (factorDenied) return factorDenied;
  }

  // Spend both, now that this request will mint and DM a code. A concurrent
  // request may have taken the last slot since the peek.
  if (!checkRateLimit(globalKey, 10, 60 * 60_000)) {
    return NextResponse.json({ error: t("apiUser.discord.merge.tooManyAttempts") }, { status: 429 });
  }
  if (!checkRateLimit(targetKey, 3, 15 * 60 * 1000)) {
    return NextResponse.json({ error: t("apiUser.discord.merge.waitFifteen") }, { status: 429 });
  }

  const botTokenRow = await prisma.setting.findUnique({ where: { key: "discordBotToken" } });
  if (!botTokenRow?.value) {
    return NextResponse.json({ error: t("apiUser.discord.merge.botNotConfigured") }, { status: 503 });
  }

  // 6 random bytes = 12 hex characters (~48 bits). Together with the rate
  // limits, that is far too many to guess in the 10-minute window. Only its
  // HMAC is stored; the code itself goes out in the DM below and nowhere else
  // (discord-merge-code.ts).
  const { code, codeMac } = generateDiscordMergeCode(session.user.id, discordId);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.discordMergeCode.upsert({
    where: { userId: session.user.id },
    update: { discordId, code: codeMac, expiresAt },
    create: { userId: session.user.id, discordId, code: codeMac, expiresAt },
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

    const channel = check(DmChannel, await dmRes.json().catch(() => undefined));
    if (!channel.ok || !SNOWFLAKE_RE.test(channel.value.id)) {
      throw new Error(`Discord returned no usable DM channel id${channel.ok ? "" : ` (${channel.error})`}`);
    }
    const channelId = channel.value.id;

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
