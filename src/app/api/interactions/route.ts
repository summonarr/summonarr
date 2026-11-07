import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sanitizeForLog } from "@/lib/sanitize";
import { bodyTooLarge, checkBodySize, readBodyBytesCapped } from "@/lib/body-size";
import { isFeatureEnabled } from "@/lib/features";
import { discordGuildVerdict } from "@/lib/discord-guild";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { handleCommand } from "@/lib/discord-interactions/commands";
import { handleComponent } from "@/lib/discord-interactions/components";
import { interactionTranslatorSync } from "@/lib/discord-interactions/reply";
import { getPublicKey, verifySignature } from "@/lib/discord-interactions/signature";
import { withDiscordTimeout } from "@/lib/discord-interactions/timeout";
import type { DiscordInteraction } from "@/lib/discord-interactions/types";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1_048_576;

export async function POST(req: NextRequest) {
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";

  const tooLarge = checkBodySize(req, MAX_BODY_BYTES);
  if (tooLarge) return tooLarge;

  // A chunked body has no Content-Length for the check above (Discord sends one,
  // but a proxy can rewrite headers). The read stops at the cap, and the bytes are
  // decoded once — no second full copy just to measure it, on a public route
  // that has not verified anything yet.
  const raw = await readBodyBytesCapped(req, MAX_BODY_BYTES);
  if (raw === null) return bodyTooLarge(MAX_BODY_BYTES, req);
  const body = new TextDecoder().decode(raw);

  const publicKey = await getPublicKey();
  if (!publicKey) {
    return new NextResponse("Bot not configured — set discordPublicKey in Settings", { status: 503 });
  }

  if (!verifySignature(publicKey, signature, timestamp, body)) {
    console.warn(`[interactions] Signature verification failed sigLen=${sanitizeForLog(signature.length)} bodyLen=${sanitizeForLog(body.length)}`);
    return new NextResponse("Invalid request signature", { status: 401 });
  }

  // Reject replayed requests: Discord requires servers to enforce a 5-second timestamp window.
  // Asymmetric tolerance — past timestamps must be < 5s old (Discord's rule); future timestamps
  // are accepted up to 2s for benign clock skew but anything beyond is rejected, since a future
  // timestamp widens the replay window.
  const requestAge = Date.now() / 1000 - Number(timestamp);
  if (Number.isNaN(requestAge) || requestAge > 5 || requestAge < -2) {
    console.warn(`[interactions] Stale or skewed timestamp rejected: age=${sanitizeForLog(requestAge.toFixed(1))}s`);
    return new NextResponse("Request timestamp too old", { status: 401 });
  }

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(body) as DiscordInteraction;
  } catch {
    console.warn("[interactions] Malformed JSON body after signature verification");
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // type=1 is Discord's PING to verify the endpoint is reachable; respond with PONG immediately
  if (interaction.type === 1) {
    return NextResponse.json({ type: 1 });
  }

  // Feature gate: the flag previously gated only the notify libs, so disabling the
  // Discord integration still left slash commands and admin buttons fully live.
  // PING stays exempt (above) so Discord's endpoint verification keeps passing while
  // the feature is off; real interactions get an ephemeral explanation (type 4 + flags 64).
  if (!(await isFeatureEnabled("feature.integration.discord"))) {
    return NextResponse.json({ type: 4, data: { content: interactionTranslatorSync(interaction)("notify.bot.disabled"), flags: 64 } });
  }

  // Server gate (discord-guild.ts): the signature proves the interaction came
  // from Discord, not from OUR server. Anything outside the configured guild —
  // another server the bot was added to, or a DM — is answered with an
  // ephemeral refusal and touches nothing else. Before the replay guard, so a
  // refused interaction doesn't even write a nonce row. Only the two types this
  // route acts on (2 command, 3 component) are gated; every other type is the
  // 400 at the bottom anyway.
  if (interaction.type === 2 || interaction.type === 3) {
    const guildRow = await prisma.setting.findUnique({ where: { key: "discordGuildId" } });
    const guildVerdict = discordGuildVerdict(interaction, guildRow?.value);
    if (guildVerdict !== "ok") {
      const key = guildVerdict === "not-configured" ? "notify.bot.serverNotConfigured" : "notify.bot.wrongServer";
      return NextResponse.json({ type: 4, data: { content: interactionTranslatorSync(interaction)(key), flags: 64 } });
    }
  }

  // Replay guard (defense-in-depth beyond the 5s timestamp window above): a captured,
  // validly-signed interaction can otherwise be re-POSTed within that window. Discord
  // interaction ids are unique snowflakes — record each once and reject duplicates.
  // Best-effort: a storage hiccup must NOT drop a legitimate interaction, so only an
  // actual unique-violation (P2002) counts as a replay. PING (handled above) is exempt.
  const interactionId = typeof interaction.id === "string" ? interaction.id : null;
  if (interactionId) {
    try {
      await prisma.discordSearchCache.create({
        data: { queryKey: `nonce:${interactionId}`, data: "", expiresAt: new Date(Date.now() + 30 * 1000) },
      });
    } catch (err) {
      if (isPrismaErrorCode(err, "P2002")) {
        console.warn(`[interactions] Replayed interaction rejected: ${sanitizeForLog(interactionId)}`);
        return new NextResponse("Duplicate interaction", { status: 401 });
      }
      console.error(`[interactions] Replay-guard write failed: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
    }
  }

  if (interaction.type === 2) {
    const cmdInteraction = interaction;
    // type=5 defers the response (ephemeral); the actual reply is sent via editOriginal
    withDiscordTimeout(() => handleCommand(cmdInteraction), cmdInteraction.application_id, cmdInteraction.token, interactionTranslatorSync(cmdInteraction));
    return NextResponse.json({ type: 5, data: { flags: 64 } });
  }

  if (interaction.type === 3) {
    const cmpInteraction = interaction;
    // type=6 acknowledges component interaction with no visible change; reply follows from editOriginal
    withDiscordTimeout(() => handleComponent(cmpInteraction), cmpInteraction.application_id, cmpInteraction.token, interactionTranslatorSync(cmpInteraction));
    return NextResponse.json({ type: 6 });
  }

  return new NextResponse(null, { status: 400 });
}
