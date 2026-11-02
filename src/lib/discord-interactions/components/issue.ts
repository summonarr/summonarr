import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { createIssue } from "@/lib/issue-create";
import { sessionForUser } from "@/lib/auto-request";
import { maintenanceGuard } from "@/lib/maintenance";
import { TMDB_POSTER_BASE, editOriginal, linkedAccountRefusal, linkedSiteAccount, loadPending, savePending } from "../reply";
import type { ComponentContext, PendingIssue } from "../types";

// `issuepick:<interactionId>:<discordUserId>:<index>` — an /issue result button.
export async function handleIssuePick(ctx: ComponentContext): Promise<void> {
  const { t, appId, token, customId, discordUserId } = ctx;
  const [, pendingInteractionId, ownerId, idxStr] = customId.split(":");
  if (discordUserId !== ownerId) return;
  const key = `pi:${pendingInteractionId}:${discordUserId}`;
  const pending = await loadPending<PendingIssue>(key);
  if (!pending) {
    await editOriginal(appId, token, { content: t("notify.bot.issue.expired"), embeds: [], components: [] });
    return;
  }
  const selected = pending.results[parseInt(idxStr, 10)];
  if (!selected) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.invalid"), embeds: [], components: [] });
    return;
  }
  if (!(await isFeatureEnabled("feature.page.issues"))) {
    await editOriginal(appId, token, { content: t("notify.bot.issue.disabled"), embeds: [], components: [] });
    return;
  }
  const linked = await linkedSiteAccount(discordUserId);
  const refusal = linkedAccountRefusal(t, linked);
  if (refusal || linked.kind !== "ok") {
    await editOriginal(appId, token, { content: refusal ?? t("notify.bot.linkRequired"), embeds: [], components: [] });
    return;
  }
  const session = sessionForUser(linked.user);
  if (await maintenanceGuard(session)) {
    await editOriginal(appId, token, { content: t("notify.bot.maintenance"), embeds: [], components: [] });
    return;
  }
  // The web POST's per-user issue budget.
  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitIssues" } });
  if (!checkRateLimit(`issues:${linked.user.id}`, parseRateLimit(rlRow?.value, 10), 60 * 1000)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast"), embeds: [], components: [] });
    return;
  }
  // Claim the search: one report per search, so a double click can't file two.
  const claimed = await prisma.discordSearchCache.deleteMany({ where: { queryKey: key } });
  if (claimed.count === 0) {
    await editOriginal(appId, token, { content: t("notify.bot.issue.expired"), embeds: [], components: [] });
    return;
  }
  const isTv = selected.mediaType === "tv";
  const scope = isTv && pending.season !== null ? (pending.episode !== null ? "EPISODE" : "SEASON") : "FULL";
  const created = await createIssue(
    session,
    {
      mediaType: isTv ? "TV" : "MOVIE",
      tmdbId: selected.id,
      issueType: pending.issueType,
      scope,
      seasonNumber: scope === "FULL" ? undefined : (pending.season ?? undefined),
      episodeNumber: scope === "EPISODE" ? (pending.episode ?? undefined) : undefined,
      note: pending.note ?? undefined,
    },
    t,
  );
  const embed: Record<string, unknown> = { title: `${selected.title} (${selected.releaseYear})` };
  if (selected.posterPath) embed.thumbnail = { url: `${TMDB_POSTER_BASE}${selected.posterPath}` };
  if (!created.ok) {
    // Nothing was filed: give the search back so another result (or this
    // one, once fixed) can still be picked instead of "search expired".
    await savePending(key, pending).catch(() => {});
    embed.color = 0xed4245;
    embed.description = created.error;
  } else {
    // This handler is already detached from the interaction's request (the
    // route answered Discord before it ran), so the admin fan-out runs here
    // rather than through after(). It never throws.
    void created.notify();
    embed.color = 0x57f287;
    const where = scope === "EPISODE"
      ? t("notify.bot.issue.whereEpisode", { season: pending.season ?? 0, episode: pending.episode ?? 0 })
      : scope === "SEASON"
        ? t("notify.bot.issue.whereSeason", { season: pending.season ?? 0 })
        : null;
    embed.description = [t("notify.bot.issue.reported"), where].filter(Boolean).join("\n");
  }
  await editOriginal(appId, token, { content: "", embeds: [embed], components: [] });
}
