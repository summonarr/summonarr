import { instanceDefaultLocale, translatorFor } from "@/lib/i18n/server-locale";
import { discordUserOf, type ComponentContext, type ComponentInteraction } from "../types";
import { editOriginal, ephemeralFollowup, interactionTranslator, interactionTranslatorSync } from "../reply";
import { handleAdminDecision } from "./admin-decision";
import { handleIssuePick } from "./issue";
import { handlePick } from "./pick";
import { handleWatchlistAdd, handleWatchlistRemove } from "./watchlist";

// The admin buttons sit on the shared admin-channel request card, which every
// admin uses; the other families sit on the clicker's own result message.
const SHARED_CARD_PREFIXES = ["admin_approve:", "admin_decline:"] as const;

// custom_id family registry, matched in order by prefix. An unmatched id is an
// "inactive button" reply.
const COMPONENT_HANDLERS: ReadonlyArray<{ prefixes: readonly string[]; handle: (ctx: ComponentContext) => Promise<void> }> = [
  { prefixes: ["pick:"], handle: handlePick },
  { prefixes: ["wladd:"], handle: handleWatchlistAdd },
  { prefixes: ["wlrm:"], handle: handleWatchlistRemove },
  { prefixes: ["issuepick:"], handle: handleIssuePick },
  { prefixes: SHARED_CARD_PREFIXES, handle: handleAdminDecision },
];

export async function handleComponent(interaction: ComponentInteraction): Promise<void> {
  const appId = interaction.application_id;
  const token = interaction.token;
  const customId = interaction.data.custom_id;
  const discordUser = discordUserOf(interaction);
  if (!discordUser) {
    await editOriginal(appId, token, { content: interactionTranslatorSync(interaction)("notify.bot.unexpectedShort") }).catch(() => {});
    return;
  }
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
    // Components are deferred with type 6, so the edit below would rewrite the
    // CLICKED message. On the shared admin card that wiped the request and its
    // buttons for every admin while the request stayed undecided: tell only the
    // clicker instead and leave the card for a retry.
    if (SHARED_CARD_PREFIXES.some((p) => customId.startsWith(p))) {
      await ephemeralFollowup(appId, token, t("notify.bot.unexpectedShort")).catch(() => {});
      return;
    }
    await editOriginal(appId, token, { content: t("notify.bot.unexpectedShort"), embeds: [], components: [] }).catch(() => {});
  }
}
