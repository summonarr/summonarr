import { DISCORD_SYNTHETIC_EMAIL_SUFFIX } from "@/lib/user-source";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, parseRateLimit } from "@/lib/rate-limit";
import { escMd } from "@/lib/discord-notify";
import { buildResultsPayload, editOriginal, mediaTypeOption, optionValue, savePending } from "../reply";
import { maintenanceRefuses } from "../request-gates";
import { searchForDiscord } from "../search";
import type { CommandContext, PendingSearch, TmdbResult } from "../types";

export async function handleRequestCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, interactionId, discordUserId, discordUsername, data, requireLinked, isExemptByRole } = ctx;

  const rlRow = await prisma.setting.findUnique({ where: { key: "rateLimitRequests" } });
  const rlLimit = parseRateLimit(rlRow?.value, 20);
  if (!checkRateLimit(`discord-request:${discordUserId}`, rlLimit, 60 * 1000)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast") });
    return;
  }

  // The one Discord maintenance rule (request-gates.ts), shared with the result
  // pick: the ADMIN bit of an active linked account bypasses it.
  if (await maintenanceRefuses(discordUserId)) {
    await editOriginal(appId, token, { content: t("notify.bot.maintenance") });
    return;
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
  if (requireLinked && !isExemptByRole && (!caller || caller.email.endsWith(DISCORD_SYNTHETIC_EMAIL_SUFFIX))) {
    await editOriginal(appId, token, { content: t("notify.bot.linkRequiredToRequest") });
    return;
  }

  const type = mediaTypeOption(optionValue(data.options, "type"));
  const query = optionValue(data.options, "query");
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
