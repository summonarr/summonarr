import { prisma } from "@/lib/prisma";
import { discordUserOf, type CommandContext, type CommandInteraction } from "../types";
import { editOriginal, interactionTranslator } from "../reply";
import { handleIssueCommand } from "./issue";
import { handleLinkCommand } from "./link";
import { handleRecentCommand } from "./recent";
import { handleRequestCommand } from "./request";
import { handleStatusCommand } from "./status";
import { handleWatchlistCommand } from "./watchlist";

// Slash-command registry: command name → handler. An unknown name is a silent
// no-op (the deferred reply is left as is), exactly as the old else-if chain.
const COMMAND_HANDLERS: Record<string, (ctx: CommandContext) => Promise<void>> = {
  request: handleRequestCommand,
  status: handleStatusCommand,
  link: handleLinkCommand,
  watchlist: handleWatchlistCommand,
  issue: handleIssueCommand,
  recent: handleRecentCommand,
};

export async function handleCommand(interaction: CommandInteraction): Promise<void> {
  const appId = interaction.application_id;
  const token = interaction.token;
  const interactionId = interaction.id as string;
  const data = interaction.data;
  const discordUser = discordUserOf(interaction);
  const discordUserId = discordUser.id;
  const discordUsername = discordUser.username as string;
  const commandName = data.name;

  const channelId = interaction.channel_id;
  const memberRoles: string[] = interaction.member?.roles ?? [];
  const t = await interactionTranslator(interaction, discordUserId);

  const [welcomeRow, requireLinkedRow, autoApproveRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "discordWelcomeChannelId" } }),
    prisma.setting.findUnique({ where: { key: "discordRequireLinkedAccount" } }),
    prisma.setting.findUnique({ where: { key: "discordAutoApproveRoles" } }),
  ]);

  const welcomeChannelId = welcomeRow?.value?.trim() || null;
  const requireLinked = requireLinkedRow?.value === "true";
  const autoApproveRoles = (autoApproveRow?.value ?? "").split(",").map((r) => r.trim()).filter(Boolean);
  const isExemptByRole = autoApproveRoles.length > 0 && memberRoles.some((r) => autoApproveRoles.includes(r));

  if (welcomeChannelId && channelId) {
    const inWelcome = channelId === welcomeChannelId;
    if (commandName === "link" && !inWelcome) {
      await editOriginal(appId, token, { content: t("notify.bot.linkWelcomeOnly") });
      return;
    }
    // The welcome channel is for /link alone; every other command is refused there.
    if (commandName !== "link" && inWelcome) {
      await editOriginal(appId, token, { content: t("notify.bot.commandNotHere", { command: commandName }) });
      return;
    }
  }

  const ctx: CommandContext = {
    interaction, t, appId, token, interactionId, discordUserId, discordUsername, data, requireLinked, isExemptByRole,
  };

  try {
    const handler = Object.hasOwn(COMMAND_HANDLERS, commandName) ? COMMAND_HANDLERS[commandName] : undefined;
    if (handler) await handler(ctx);
  } catch (err) {
    console.error("[interactions] handleCommand error:", err);
    await editOriginal(appId, token, { content: t("notify.bot.unexpected") }).catch(() => {});
  }
}
