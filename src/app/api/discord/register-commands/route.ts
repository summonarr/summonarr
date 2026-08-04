import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { DISCORD_SLASH_COMMANDS } from "@/lib/discord-commands";
import { prisma } from "@/lib/prisma";
import { safeFetchTrusted } from "@/lib/safe-fetch";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_HOSTS = ["discord.com"];

export const POST = withAdmin(async (_req, _ctx, _session) => {
  const rows = await prisma.setting.findMany({
    where: { key: { in: ["discordBotToken", "discordClientId", "discordGuildId"] } },
  });
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  if (!cfg.discordBotToken || !cfg.discordClientId) {
    return NextResponse.json({ error: "Bot Token and Client ID are required" }, { status: 400 });
  }

  const url = cfg.discordGuildId
    ? `${DISCORD_API}/applications/${cfg.discordClientId}/guilds/${cfg.discordGuildId}/commands`
    : `${DISCORD_API}/applications/${cfg.discordClientId}/commands`;

  const res = await safeFetchTrusted(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${cfg.discordBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(DISCORD_SLASH_COMMANDS),
    allowedHosts: DISCORD_HOSTS,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[discord] Command registration failed (${res.status}):`, text);
    return NextResponse.json({ error: `Discord API request failed (${res.status})` }, { status: 502 });
  }

  const scope = cfg.discordGuildId ? `guild ${cfg.discordGuildId}` : "globally";
  return NextResponse.json({ ok: true, message: `Slash commands registered ${scope}` });
});
