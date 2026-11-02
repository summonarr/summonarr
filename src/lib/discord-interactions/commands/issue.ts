import { escMd } from "@/lib/discord-notify";
import { checkRateLimit } from "@/lib/rate-limit";
import { isFeatureEnabled } from "@/lib/features";
import { VALID_ISSUE_TYPES, type IssueTypeValue } from "@/lib/issue-create";
import { sessionForUser } from "@/lib/auto-request";
import { maintenanceGuard } from "@/lib/maintenance";
import {
  buildResultsPayload,
  editOriginal,
  linkedAccountRefusal,
  linkedSiteAccount,
  mediaTypeOption,
  optionValue,
  savePending,
} from "../reply";
import { searchForDiscord } from "../search";
import type { CommandContext, PendingIssue, TmdbResult } from "../types";

export async function handleIssueCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, interactionId, discordUserId, data } = ctx;
  if (!(await isFeatureEnabled("feature.page.issues"))) {
    await editOriginal(appId, token, { content: t("notify.bot.issue.disabled") });
    return;
  }
  const linked = await linkedSiteAccount(discordUserId);
  const refusal = linkedAccountRefusal(t, linked);
  if (refusal || linked.kind !== "ok") {
    await editOriginal(appId, token, { content: refusal ?? t("notify.bot.linkRequired") });
    return;
  }
  if (await maintenanceGuard(sessionForUser(linked.user))) {
    await editOriginal(appId, token, { content: t("notify.bot.maintenance") });
    return;
  }
  if (!checkRateLimit(`discord-read:${discordUserId}`, 20, 60_000)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast") });
    return;
  }

  const type = mediaTypeOption(optionValue(data.options, "type"));
  const query = optionValue(data.options, "query");
  const problem = optionValue(data.options, "problem");
  const rawNote = optionValue(data.options, "note");
  const rawSeason = optionValue(data.options, "season");
  const rawEpisode = optionValue(data.options, "episode");
  if (!type || typeof query !== "string" || query.trim().length === 0 || !VALID_ISSUE_TYPES.includes(problem as IssueTypeValue)) {
    await editOriginal(appId, token, { content: t("notify.bot.searchFailed") });
    return;
  }
  const note = typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote : null;
  // Seasons and episodes describe TV only; a movie report is always the whole title.
  const season = type === "tv" && typeof rawSeason === "number" ? rawSeason : null;
  const episode = type === "tv" && typeof rawEpisode === "number" ? rawEpisode : null;
  // Refused here, before a search, rather than after the user has picked a title.
  if (episode !== null && season === null) {
    await editOriginal(appId, token, { content: t("apiUser.issues.seasonRequired") });
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
  // Issues are about media you HAVE: offer only what this user can see in a
  // library (createIssue enforces the same gate on the pick).
  const inLibrary = results.filter((r) => r.plexAvailable || r.jellyfinAvailable);
  if (inLibrary.length === 0) {
    await editOriginal(appId, token, { content: t("notify.bot.issue.noLibraryResults", { query: escMd(query) }) });
    return;
  }
  await savePending(`pi:${interactionId}:${discordUserId}`, {
    results: inLibrary,
    issueType: problem as IssueTypeValue,
    note,
    season,
    episode,
  } satisfies PendingIssue);
  await editOriginal(
    appId,
    token,
    buildResultsPayload(t, query, inLibrary, interactionId, discordUserId, { prefix: "issuepick", labelKey: "notify.bot.issue.select" }),
  );
}
