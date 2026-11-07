import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { escMd } from "@/lib/discord-notify";
import { buildResultsPayload, editOriginal, savePending } from "../reply";
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

  // A deactivated account is refused outright, as /recent does: its
  // restricted-server grants are still on the row (guardrail 33), and the result
  // badges below would read through them.
  const caller = await prisma.user.findUnique({
    where: { discordId: discordUserId },
    select: { email: true, deactivatedAt: true },
  });
  if (caller?.deactivatedAt) {
    await editOriginal(appId, token, { content: t("notify.bot.pick.deactivated") });
    return;
  }
  if (requireLinked && !isExemptByRole && (!caller || caller.email.endsWith("@discord.local"))) {
    await editOriginal(appId, token, { content: t("notify.bot.linkRequiredToRequest") });
    return;
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
    // The query is the user's own text inside **"…"**: escaped like every other
    // query that reaches Discord (buildResultsPayload, /issue).
    await editOriginal(appId, token, {
      content: type === "movie" ? t("notify.bot.noResults.movie", { query: escMd(query) }) : t("notify.bot.noResults.tv", { query: escMd(query) }),
    });
    return;
  }

  // Read back by the result buttons (components/pick.ts) under this key.
  const key = `p:${interactionId}:${discordUserId}`;
  const pendingPayload: PendingSearch = { results, discordUserId, discordUsername };
  await savePending(key, pendingPayload);

  await editOriginal(appId, token, buildResultsPayload(t, query, results, interactionId, discordUserId));
}
