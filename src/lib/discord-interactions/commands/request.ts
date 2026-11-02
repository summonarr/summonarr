import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { buildResultsPayload, editOriginal } from "../reply";
import { attachAvailability, cachedSearchTmdb, discordVisibleInstances } from "../search";
import type { CommandContext, CommandOption, PendingSearch, TmdbResult } from "../types";

export async function handleRequestCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, interactionId, discordUserId, discordUsername, data, requireLinked, isExemptByRole } = ctx;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
  const rlLimit = parseRateLimit(rlRow?.value, 20);
  if (!checkRateLimit(`discord-request:${discordUserId}`, rlLimit, 60 * 1000)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast") });
    return;
  }

  const maintRow = await prisma.setting.findUnique({ where: { key: "maintenanceEnabled" } });
  if (maintRow?.value === "true") {
    const discordAdmin = await prisma.user.findFirst({ where: { discordId: discordUserId, role: "ADMIN" }, select: { id: true } });
    if (!discordAdmin) {
      await editOriginal(appId, token, { content: t("notify.bot.maintenance") });
      return;
    }
  }

  if (requireLinked && !isExemptByRole) {
    const linkedUser = await prisma.user.findFirst({
      where: { discordId: discordUserId, NOT: { email: { endsWith: "@discord.local" } } },
      select: { id: true },
    });
    if (!linkedUser) {
      await editOriginal(appId, token, { content: t("notify.bot.linkRequiredToRequest") });
      return;
    }
  }

  // `options` is always present on a real /request; a payload without it throws
  // here (and is reported as an unexpected error), exactly as before.
  const options = data.options as CommandOption[];
  const type = options.find((o) => o.name === "type")?.value as "movie" | "tv";
  const query = options.find((o) => o.name === "query")?.value as string;

  let results: TmdbResult[];
  try {
    const raw = await cachedSearchTmdb(query, type, discordUserId);
    results = await attachAvailability(raw, await discordVisibleInstances(discordUserId));
  } catch (err) {
    console.error("[interactions] TMDB search error:", err);
    await editOriginal(appId, token, { content: t("notify.bot.searchFailed") });
    return;
  }

  if (results.length === 0) {
    await editOriginal(appId, token, {
      content: type === "movie" ? t("notify.bot.noResults.movie", { query }) : t("notify.bot.noResults.tv", { query }),
    });
    return;
  }

  const key = `p:${interactionId}:${discordUserId}`;
  const pendingPayload: PendingSearch = { results, discordUserId, discordUsername };
  await prisma.discordSearchCache.upsert({
    where:  { queryKey: key },
    create: { queryKey: key, data: JSON.stringify(pendingPayload), expiresAt: new Date(Date.now() + 5 * 60_000) },
    update: { data: JSON.stringify(pendingPayload), expiresAt: new Date(Date.now() + 5 * 60_000) },
  });

  await editOriginal(appId, token, buildResultsPayload(t, query, results, interactionId, discordUserId));
}
