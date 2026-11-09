import { prisma } from "@/lib/prisma";
import { escMd } from "@/lib/discord-notify";
import type { Translator } from "@/lib/i18n/translate";
import {
  buildResultsPayload,
  editOriginal,
  mediaTypeOption,
  optionValue,
  requireLinkedSiteAccount,
  savePending,
  truncateText,
  withinDiscordReadBudget,
} from "../reply";
import { searchForDiscord } from "../search";
import type { CommandContext, PendingWatchlistAdd, TmdbResult } from "../types";

// The /watchlist list view: the newest WATCHLIST_LIST_SIZE titles, a count of
// the rest, and a menu that removes one. Short enough that the message stays
// inside Discord's 2000-character content cap whatever the titles are.
const WATCHLIST_LIST_SIZE = 10;

// Also re-rendered by the `wlrm:` select after a removal.
export async function watchlistListPayload(t: Translator, userId: string, discordUserId: string, notice: string | null) {
  const [items, total] = await Promise.all([
    prisma.watchlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: WATCHLIST_LIST_SIZE,
      select: { tmdbId: true, mediaType: true, title: true, createdAt: true },
    }),
    prisma.watchlistItem.count({ where: { userId } }),
  ]);
  if (total === 0) {
    return { content: [notice, t("notify.bot.watchlist.empty")].filter(Boolean).join("\n"), embeds: [], components: [] };
  }
  const lines = items.map(
    (i) => `${i.mediaType === "MOVIE" ? "🎬" : "📺"} **${escMd(truncateText(i.title, 80))}** — <t:${Math.floor(i.createdAt.getTime() / 1000)}:R>`,
  );
  const more = total > items.length ? t("notify.bot.watchlist.more", { count: total - items.length }) : null;
  return {
    content: [notice, t("notify.bot.watchlist.header", { count: total }), ...lines, more].filter(Boolean).join("\n"),
    embeds: [],
    components: [{
      type: 1,
      components: [{
        type: 3,
        custom_id: `wlrm:${discordUserId}`,
        placeholder: t("notify.bot.watchlist.removePlaceholder"),
        min_values: 1,
        max_values: 1,
        options: items.map((i) => ({
          label: truncateText(i.title, 100),
          value: `${i.mediaType}:${i.tmdbId}`,
          description: i.mediaType === "MOVIE" ? t("notify.bot.status.movie") : t("notify.bot.status.tv"),
        })),
      }],
    }],
  };
}

// The first option as a sub-command record, or undefined when it isn't an object.
function subCommandOf(options: unknown): { name?: unknown; options?: unknown } | undefined {
  const first: unknown = Array.isArray(options) ? options[0] : undefined;
  return first !== null && typeof first === "object" ? (first as { name?: unknown; options?: unknown }) : undefined;
}

export async function handleWatchlistCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, interactionId, discordUserId, data } = ctx;
  const sub = subCommandOf(data.options);
  const linked = await requireLinkedSiteAccount(t, discordUserId);
  if ("refusal" in linked) {
    await editOriginal(appId, token, { content: linked.refusal });
    return;
  }
  if (!withinDiscordReadBudget(discordUserId)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast") });
    return;
  }

  if (sub?.name === "list") {
    await editOriginal(appId, token, await watchlistListPayload(t, linked.user.id, discordUserId, null));
    return;
  }
  if (sub?.name !== "add") {
    await editOriginal(appId, token, { content: t("notify.bot.inactiveButton") });
    return;
  }

  const type = mediaTypeOption(optionValue(sub.options, "type"));
  const query = optionValue(sub.options, "query");
  if (!type || typeof query !== "string" || query.trim().length === 0) {
    await editOriginal(appId, token, { content: t("notify.bot.searchFailed") });
    return;
  }
  let results: TmdbResult[];
  try {
    results = await searchForDiscord(query, type, discordUserId);
  } catch (err) {
    console.error("[interactions] TMDB search error:", err);
    await editOriginal(appId, token, { content: t("notify.bot.searchFailed") });
    return;
  }
  if (results.length === 0) {
    await editOriginal(appId, token, {
      content: type === "movie" ? t("notify.bot.noResults.movie", { query: escMd(query) }) : t("notify.bot.noResults.tv", { query: escMd(query) }),
    });
    return;
  }
  await savePending(`pw:${interactionId}:${discordUserId}`, { results } satisfies PendingWatchlistAdd);
  await editOriginal(
    appId,
    token,
    buildResultsPayload(t, query, results, interactionId, discordUserId, { prefix: "wladd", labelKey: "notify.bot.watchlist.select" }),
  );
}
