import { escMd } from "@/lib/discord-notify";
import { isFeatureEnabled } from "@/lib/features";
import { VALID_ISSUE_TYPES, type IssueTypeValue } from "@/lib/issue-create";
import { sessionForUser } from "@/lib/auto-request";
import { maintenanceGuard } from "@/lib/maintenance";
import {
  buildResultsPayload,
  editOriginal,
  mediaTypeOption,
  optionValue,
  requireLinkedSiteAccount,
  savePending,
  withinDiscordReadBudget,
} from "../reply";
import { searchForDiscord } from "../search";
import type { CommandContext, PendingIssue, TmdbResult } from "../types";

type IssueOptions = {
  type: "movie" | "tv";
  query: string;
  problem: IssueTypeValue;
  note: string | null;
  season: number | null;
  episode: number | null;
};

// The /issue options, checked: a media type, a non-blank query and a known
// problem; an optional note; a season and episode for TV only. An episode
// without a season is its own refusal.
function parseIssueOptions(options: unknown): IssueOptions | "invalid" | "season-required" {
  const type = mediaTypeOption(optionValue(options, "type"));
  const query = optionValue(options, "query");
  const problem = optionValue(options, "problem");
  if (!type || typeof query !== "string" || query.trim().length === 0 || !VALID_ISSUE_TYPES.includes(problem as IssueTypeValue)) {
    return "invalid";
  }
  const rawNote = optionValue(options, "note");
  const rawSeason = optionValue(options, "season");
  const rawEpisode = optionValue(options, "episode");
  const note = typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote : null;
  // Seasons and episodes describe TV only; a movie report is always the whole title.
  const season = type === "tv" && typeof rawSeason === "number" ? rawSeason : null;
  const episode = type === "tv" && typeof rawEpisode === "number" ? rawEpisode : null;
  if (episode !== null && season === null) return "season-required";
  return { type, query, problem: problem as IssueTypeValue, note, season, episode };
}

export async function handleIssueCommand(ctx: CommandContext): Promise<void> {
  const { t, appId, token, interactionId, discordUserId, data } = ctx;
  if (!(await isFeatureEnabled("feature.page.issues"))) {
    await editOriginal(appId, token, { content: t("notify.bot.issue.disabled") });
    return;
  }
  const linked = await requireLinkedSiteAccount(t, discordUserId);
  if ("refusal" in linked) {
    await editOriginal(appId, token, { content: linked.refusal });
    return;
  }
  if (await maintenanceGuard(sessionForUser(linked.user))) {
    await editOriginal(appId, token, { content: t("notify.bot.maintenance") });
    return;
  }
  if (!withinDiscordReadBudget(discordUserId)) {
    await editOriginal(appId, token, { content: t("notify.bot.tooFast") });
    return;
  }

  const parsed = parseIssueOptions(data.options);
  if (parsed === "invalid") {
    await editOriginal(appId, token, { content: t("notify.bot.searchFailed") });
    return;
  }
  // Refused here, before a search, rather than after the user has picked a title.
  if (parsed === "season-required") {
    await editOriginal(appId, token, { content: t("apiUser.issues.seasonRequired") });
    return;
  }
  const { type, query, problem, note, season, episode } = parsed;

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
    issueType: problem,
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
