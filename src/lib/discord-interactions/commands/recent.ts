import { prisma } from "@/lib/prisma";
import { escMd } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { getRecentlyAdded } from "@/lib/recently-added";
import { editOriginal, mediaTypeOption, optionValue, truncateText } from "../reply";
import { discordVisibleInstances } from "../search";
import type { CommandContext } from "../types";

const RECENT_LIST_SIZE = 10;

// No site account is needed to browse what arrived — unless the admin requires a
// linked account for the bot (the /status rule). A deactivated account is refused
// outright: its restricted-server grants are still on the row (guardrail 33), so
// reading through them would keep showing a banned user what lands there.
export async function handleRecentCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, discordUserId, data } = ctx;
  const requireLinked = ctx.requireLinked && !ctx.isExemptByRole;
  if (!(await isFeatureEnabled("feature.page.recentlyAdded"))) {
    await editOriginal(appId, token, { content: t("notify.bot.recent.disabled") });
    return;
  }
  const viewer = await prisma.user.findUnique({
    where: { discordId: discordUserId },
    select: { id: true, email: true, deactivatedAt: true },
  });
  if (viewer?.deactivatedAt) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.deactivated") });
    return;
  }
  if (requireLinked && (!viewer || viewer.email.endsWith("@discord.local"))) {
    await editOriginal(appId, token, { content: t("notify.bot.linkRequired") });
    return;
  }
  if (!checkRateLimit(`discord-read:${discordUserId}`, 20, 60_000)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast") });
    return;
  }
  const type = mediaTypeOption(optionValue(data.options, "type"));
  const [plexOn, jellyfinOn, visible] = await Promise.all([
    isFeatureEnabled("feature.integration.plex"),
    isFeatureEnabled("feature.integration.jellyfin"),
    // The library rows are scoped to the servers this Discord user may see, in
    // the query (guardrail 35) — never masked afterwards.
    discordVisibleInstances(discordUserId),
  ]);
  const recent = await getRecentlyAdded({ plex: plexOn ? visible.plex : [], jellyfin: jellyfinOn ? visible.jellyfin : [] });
  // A title the user hid ("not interested") stays out of their list, as on the site.
  const hidden = viewer && recent.length > 0
    ? new Set(
        (await prisma.hiddenItem.findMany({
          where: { userId: viewer.id, tmdbId: { in: recent.map((r) => r.id) } },
          select: { tmdbId: true, mediaType: true },
        })).map((h) => `${h.mediaType === "MOVIE" ? "movie" : "tv"}:${h.tmdbId}`),
      )
    : new Set<string>();
  const items = recent
    .filter((r) => (type ? r.mediaType === type : true) && !hidden.has(`${r.mediaType}:${r.id}`))
    .slice(0, RECENT_LIST_SIZE);
  if (items.length === 0) {
    await editOriginal(appId, token, { content: t("notify.bot.recent.none") });
    return;
  }
  const lines = items.map(
    (r) => `${r.mediaType === "movie" ? "🎬" : "📺"} **${escMd(truncateText(r.title, 80))}**${r.releaseYear ? ` (${r.releaseYear})` : ""}`,
  );
  await editOriginal(appId, token, { content: `${t("notify.bot.recent.header")}\n${lines.join("\n")}` });
}
