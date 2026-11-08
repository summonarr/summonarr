import { NextResponse } from "next/server";
import { tooManyRequests } from "@/lib/http";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError } from "@/lib/arr";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { arrFailure, arrTitleGate, parseIdArray, parseSeasonNumber, type ArrTitleTarget } from "@/lib/arr-admin-http";
import { MissingInstanceError, NothingMissingError, searchMissingTracked } from "@/lib/arr-missing-data";
import { parseTitleCommand } from "@/lib/arr-title";
import { refreshTitle, searchEpisodes, searchMovie, searchSeason } from "@/lib/arr-title-data";
import type { ArrService } from "@/lib/arr-instances";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { checkRateLimit } from "@/lib/rate-limit";
import { TITLE_COMMAND_MAX_EPISODES } from "@/lib/api-body-limits";

const MAX_EPISODES = TITLE_COMMAND_MAX_EPISODES;
// Searches hit every indexer the instance has; bounded per admin like the
// other indexer-spending admin actions.
const LIMIT_PER_MIN = 30;

// The body's command with exactly the arguments its action needs, or null
// (400, nothing sent) — checked before the rate limit, so a malformed body
// spends no budget.
type TitleCommandRequest =
  | { action: "refresh" | "search" | "searchMissing" }
  | { action: "searchSeason"; season: number }
  | { action: "searchEpisodes"; episodeIds: number[]; missingOnly: boolean };

function parseCommandRequest(service: ArrService, body: Record<string, unknown>): TitleCommandRequest | null {
  const action = parseTitleCommand(service, body.action);
  if (action === null) return null;
  if (action === "searchSeason") {
    const season = parseSeasonNumber(body.seasonNumber);
    return season === null ? null : { action, season };
  }
  if (action === "searchEpisodes") {
    const episodeIds = parseIdArray(body.episodeIds, MAX_EPISODES);
    return episodeIds ? { action, episodeIds, missingOnly: body.missingOnly === true } : null;
  }
  return { action };
}

// Queues the command on the title's own instance; resolves to what the arr queued.
function runCommand({ service, instance, arrId }: ArrTitleTarget, cmd: TitleCommandRequest) {
  switch (cmd.action) {
    case "refresh":
      return refreshTitle(service, instance, arrId);
    case "search":
      return searchMovie(instance, arrId);
    case "searchSeason":
      return searchSeason(instance, arrId, cmd.season);
    case "searchEpisodes":
      return searchEpisodes(instance, arrId, cmd.episodeIds, { missingOnly: cmd.missingOnly });
    case "searchMissing":
      // { commands, seasons, episodes, commandIds } — one id per season searched whole, plus one.
      // Refused part-way: still 202, counting only what was queued, plus `partial: true`.
      return searchMissingTracked("sonarr", instance, arrId, new Date());
  }
}

function commandFailure(err: unknown, target: ArrTitleTarget, cmd: TitleCommandRequest, t: Translator): NextResponse {
  const service = ARR_SERVICE_LABEL[target.service];
  if (err instanceof MissingInstanceError) {
    return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service }) }, { status: 404 });
  }
  // `nothingMissing` tells this 409 apart from the route's other 409s (an
  // episode id no longer on the series, the arr's own refusal): only this one
  // is "nothing left to search" — the Arr Calendar reads the flag, never the status alone.
  if (err instanceof NothingMissingError) {
    return NextResponse.json({ error: t("apiAdmin.missing.nothingMissing"), nothingMissing: true }, { status: 409 });
  }
  // searchMissing reads the series itself (the other actions answer the
  // shared map's 404): the instance no longer has it.
  if (err instanceof ArrResponseError && err.status === 404 && cmd.action === "searchMissing") {
    return NextResponse.json({ error: t("apiAdmin.arr.titleNotFound", { service }) }, { status: 404 });
  }
  return arrFailure(err, target, t, `title ${cmd.action}`);
}

// Admin title manager, the title's buttons (ADMIN). Queues one Radarr/Sonarr
// command on the title's own instance → 202 { commands, commandIds } — the
// arr's ids for what it queued, which the page follows live
// (GET /api/admin/arr/commands) instead of guessing when it finished.
//   Radarr: action "search" (MoviesSearch — the movie's own Search, an upgrade
//           search when it has a file) or "refresh" (RefreshMovie).
//   Sonarr: "refresh" (RefreshSeries); "searchMissing" — exactly what the
//           series is missing, re-judged live (the Missing page's plan, never
//           SeriesSearch; 409 `{ nothingMissing: true }` when nothing is, 404 when the instance no
//           longer has the series; 202 with `partial: true` and the ids it
//           did queue when Sonarr refused a later command); "searchSeason" + seasonNumber
//           (SeasonSearch); "searchEpisodes" + episodeIds (one EpisodeSearch —
//           every id must be one of the series' episodes; with
//           `missingOnly: true` only the ones that have aired and still have no
//           file — 409 when none is left — so the calendar's Search never turns
//           into an upgrade search).
// Not audited, like the Missing page's search: it asks the arr to do what it
// does on its own schedule.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const body = await readJsonCapped<Record<string, unknown>>(req, 32 * 1024);
  if (body instanceof NextResponse) return body;
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const cmd = parseCommandRequest(target.service, body);
  if (!cmd) return NextResponse.json({ error: t("apiAdmin.arr.commandInvalid") }, { status: 400 });
  if (!checkRateLimit(`arr-title-command:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiAdmin.common.tooManyRequestsLater"));
  }
  try {
    return NextResponse.json(await runCommand(target, cmd), { status: 202 });
  } catch (err) {
    return commandFailure(err, target, cmd, t);
  }
});
