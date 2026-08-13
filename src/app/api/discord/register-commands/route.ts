import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { putDiscordCommands, recordDiscordSchemaHash } from "@/lib/discord-register";

export const POST = withAdmin(async (_req, _ctx, _session) => {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["discordBotToken", "discordClientId", "discordGuildId"] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  if (!cfg.discordBotToken || !cfg.discordClientId) {
    return NextResponse.json({ error: "Bot Token and Client ID are required" }, { status: 400 });
  }

  const guildId = cfg.discordGuildId?.trim() || null;
  const res = await putDiscordCommands(cfg.discordBotToken, cfg.discordClientId, guildId);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[discord] Command registration failed (${res.status}):`, text);
    return NextResponse.json({ error: `Discord API request failed (${res.status})` }, { status: 502 });
  }

  // Record the schema hash so the boot self-heal treats this registration as
  // current and won't redundantly re-push on the next restart.
  await recordDiscordSchemaHash(guildId);
  const scope = guildId ? `guild ${guildId}` : "globally";
  return NextResponse.json({ ok: true, message: `Slash commands registered ${scope}` });
});
