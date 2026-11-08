import { prisma } from "@/lib/prisma";
import { escMd } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { addToWatchlist, takeWatchlistAddToken } from "@/lib/watchlist-add";
import { sessionForUser } from "@/lib/auto-request";
import { TMDB_POSTER_BASE, editOriginal, loadPending, requireLinkedSiteAccount, truncateText } from "../reply";
import { watchlistListPayload } from "../commands/watchlist";
import type { ComponentContext, PendingWatchlistAdd } from "../types";

// `wladd:<interactionId>:<discordUserId>:<index>` — a /watchlist add result button.
export async function handleWatchlistAdd(ctx: ComponentContext): Promise<void> {
  const { t, appId, token, customId, discordUserId } = ctx;
  const [, pendingInteractionId, ownerId, idxStr] = customId.split(":");
  if (discordUserId !== ownerId) return;
  const pending = await loadPending<PendingWatchlistAdd>(`pw:${pendingInteractionId}:${discordUserId}`);
  if (!pending) {
    await editOriginal(appId, token, { content: t("notify.bot.watchlist.expired"), embeds: [], components: [] });
    return;
  }
  const selected = pending.results[parseInt(idxStr, 10)];
  if (!selected) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.invalid"), embeds: [], components: [] });
    return;
  }
  const linked = await requireLinkedSiteAccount(t, discordUserId);
  if ("refusal" in linked) {
    await editOriginal(appId, token, { content: linked.refusal, embeds: [], components: [] });
    return;
  }
  if (!takeWatchlistAddToken(linked.user.id)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast"), embeds: [], components: [] });
    return;
  }
  const added = await addToWatchlist(
    sessionForUser(linked.user),
    selected.id,
    selected.mediaType === "movie" ? "MOVIE" : "TV",
    t,
  );
  const embed: Record<string, unknown> = { title: `${selected.title} (${selected.releaseYear})` };
  if (selected.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
  if (!added.ok) {
    embed.color = added.reason === "already-added" ? 0x5865f2 : 0xed4245;
    embed.description = added.error;
  } else {
    embed.color = 0x57f287;
    // The auto-request outcome rides along exactly as the web add reports it.
    embed.description = [t("notify.bot.watchlist.added"), added.autoRequest?.message].filter(Boolean).join("\n");
  }
  await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
}

// `wlrm:<discordUserId>` — the /watchlist list "remove one" select menu.
export async function handleWatchlistRemove(ctx: ComponentContext): Promise<void> {
  const { interaction, t, appId, token, customId, discordUserId } = ctx;
  const [, ownerId] = customId.split(":");
  if (discordUserId !== ownerId) return;
  const linked = await requireLinkedSiteAccount(t, discordUserId);
  if ("refusal" in linked) {
    await editOriginal(appId, token, { content: linked.refusal, embeds: [], components: [] });
    return;
  }
  // The web DELETE's per-user budget.
  if (!checkRateLimit(`watchlist-del:${linked.user.id}`, 60, 60_000)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast"), embeds: [], components: [] });
    return;
  }
  const value = Array.isArray(interaction.data.values) ? interaction.data.values[0] : undefined;
  const match = typeof value === "string" ? /^(MOVIE|TV):(\d{1,10})$/.exec(value) : null;
  if (!match) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.invalid"), embeds: [], components: [] });
    return;
  }
  const where = { userId: linked.user.id, tmdbId: Number(match[2]), mediaType: match[1] as "MOVIE" | "TV" };
  const row = await prisma.watchlistItem.findFirst({ where, select: { title: true } });
  // deleteMany: a title already removed elsewhere is a no-op, not an error.
  await prisma.watchlistItem.deleteMany({ where });
  const notice = row ? t("notify.bot.watchlist.removed", { title: escMd(truncateText(row.title, 80)) }) : null;
  await editOriginal(appId, token, await watchlistListPayload(t, linked.user.id, discordUserId, notice));
}
