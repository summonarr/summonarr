import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";

const DISCORD_API = "https://discord.com/api/v10";

const SLASH_COMMANDS = [
  {
    name: "request",
    description: "Request a movie or TV show to be added to the library",
    options: [
      {
        name: "type",
        description: "Movie or TV show",
        type: 3,
        required: true,
        choices: [
          { name: "Movie", value: "movie" },
          { name: "TV Show", value: "tv" },
        ],
      },
      {
        name: "query",
        description: "Title to search for",
        type: 3,
        required: true,
        min_length: 1,
        max_length: 200,
      },
    ],
  },
  {
    name: "status",
    description: "Check the status of your recent media requests",
  },
  {
    name: "link",
    description: "Link your Discord account to your Summonarr account",
    options: [
      {
        name: "token",
        description: "Link token from your Profile page",
        type: 3,
        required: true,
        min_length: 1,
        max_length: 20,
      },
    ],
  },
];

export async function POST() {
  const session = await requireAuth({ role: "ADMIN" });
  if (session instanceof NextResponse) return session;

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

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${cfg.discordBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(SLASH_COMMANDS),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[discord] Command registration failed (${res.status}):`, text);
    return NextResponse.json({ error: `Discord API request failed (${res.status})` }, { status: 502 });
  }

  const scope = cfg.discordGuildId ? `guild ${cfg.discordGuildId}` : "globally";
  return NextResponse.json({ ok: true, message: `Slash commands registered ${scope}` });
}
