import { instanceDefaultLocale, translatorFor } from "@/lib/i18n/server-locale";
import { discordUserOf, type ComponentContext, type ComponentInteraction } from "../types";
import { editOriginal, interactionTranslator } from "../reply";
import { handleAdminDecision } from "./admin-decision";
import { handleIssuePick } from "./issue";
import { handlePick } from "./pick";
import { handleWatchlistAdd, handleWatchlistRemove } from "./watchlist";

// custom_id family registry, matched in order by prefix. An unmatched id is an
// "inactive button" reply.
const COMPONENT_HANDLERS: ReadonlyArray<{ prefixes: readonly string[]; handle: (ctx: ComponentContext) => Promise<void> }> = [
  { prefixes: ["pick:"], handle: handlePick },
  { prefixes: ["wladd:"], handle: handleWatchlistAdd },
  { prefixes: ["wlrm:"], handle: handleWatchlistRemove },
  { prefixes: ["issuepick:"], handle: handleIssuePick },
  { prefixes: ["admin_approve:", "admin_decline:"], handle: handleAdminDecision },
];

export async function handleComponent(interaction: ComponentInteraction): Promise<void> {
  const appId = interaction.application_id;
  const token = interaction.token;
  const customId = interaction.data.custom_id;
  const discordUser = discordUserOf(interaction);
  const discordUserId = discordUser.id;
  // The clicker's language for their own (ephemeral) replies; the admin-channel
  // embed edits use the instance default instead (`channelT`).
  const t = await interactionTranslator(interaction, discordUserId);
  const channelT = translatorFor(instanceDefaultLocale());
  const ctx: ComponentContext = { interaction, t, channelT, appId, token, customId, discordUser, discordUserId };

  try {
    const entry = COMPONENT_HANDLERS.find((h) => h.prefixes.some((p) => customId.startsWith(p)));
    if (entry) {
      await entry.handle(ctx);
    } else {
      await editOriginal(appId, token, { content: t("notify.bot.inactiveButton") }).catch(() => {});
    }
  } catch (err) {
    console.error("[interactions] handleComponent error:", err);
    await editOriginal(appId, token, { content: t("notify.bot.unexpectedShort"), embeds: [], components: [] }).catch(() => {});
  }
}
