// Which Discord server an interaction came from, and whether this bot answers it.
//
// The Ed25519 signature on /api/interactions proves an interaction came from
// DISCORD — not from OUR server. Slash commands registered globally (or a
// leftover global set from before the Guild ID was saved) are usable in every
// server the bot has been added to, and a bot that is "Public" in the
// Developer Portal can be added to any server by anyone. Without this check a
// stranger could add the bot to their own server and run /request there,
// creating requests (and an @discord.local shadow account) on this instance.
//
// So every interaction except PING must carry the configured discordGuildId:
//   - a DM (no guild_id) is refused. Nothing the bot does needs one: /link runs
//     in the server (optionally its welcome channel), and the DMs the bot SENDS
//     (notify DMs, the merge code) carry embeds and text only — no buttons that
//     would come back here as a component interaction.
//   - an interaction from any other server is refused.
//   - with NO Guild ID configured every interaction is refused (fail closed):
//     there is no server to compare against, and answering everyone is exactly
//     the hole. The setup guide already lists the Guild ID as required.
//
// Pure and dependency-free so the route and the tests share one definition.

export type DiscordGuildVerdict = "ok" | "not-configured" | "wrong-guild";

export function discordGuildVerdict(
  interaction: { guild_id?: unknown },
  configuredGuildId: string | null | undefined,
): DiscordGuildVerdict {
  const configured = typeof configuredGuildId === "string" ? configuredGuildId.trim() : "";
  if (!configured) return "not-configured";
  const guildId = typeof interaction.guild_id === "string" ? interaction.guild_id : "";
  return guildId !== "" && guildId === configured ? "ok" : "wrong-guild";
}
