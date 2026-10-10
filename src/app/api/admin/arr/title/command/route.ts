import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError } from "@/lib/arr";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { arrFailure, arrTitleGate, parseIdArray, parseSeasonNumber } from "@/lib/arr-admin-http";
import { MissingInstanceError, NothingMissingError, searchMissing } from "@/lib/arr-missing-data";
import { parseTitleCommand } from "@/lib/arr-title";
import { refreshTitle, searchEpisodes, searchMovie, searchSeason } from "@/lib/arr-title-data";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";

const MAX_EPISODES = 1_000;
// Searches hit every indexer the instance has; bounded per admin like the
// other indexer-spending admin actions.
const LIMIT_PER_MIN = 30;

// Admin title manager, the title's buttons (ADMIN). Queues one Radarr/Sonarr
// command on the title's own instance → 202 { commands }.
//   Radarr: action "search" (MoviesSearch — the movie's own Search, an upgrade
//           search when it has a file) or "refresh" (RefreshMovie).
//   Sonarr: "refresh" (RefreshSeries); "searchMissing" — exactly what the
//           series is missing, re-judged live (the Missing page's plan, never
//           SeriesSearch; 409 when nothing is); "searchSeason" + seasonNumber
//           (SeasonSearch); "searchEpisodes" + episodeIds (one EpisodeSearch —
//           every id must be one of the series' episodes).
// Not audited, like the Missing page's search: it asks the arr to do what it
// does on its own schedule.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 32 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const action = parseTitleCommand(target.service, body.action);
  if (!action) return NextResponse.json({ error: t("apiAdmin.arr.commandInvalid") }, { status: 400 });
  const season = action === "searchSeason" ? parseSeasonNumber(body.seasonNumber) : null;
  const episodeIds = action === "searchEpisodes" ? parseIdArray(body.episodeIds, MAX_EPISODES) : null;
  if ((action === "searchSeason" && season === null) || (action === "searchEpisodes" && !episodeIds)) {
    return NextResponse.json({ error: t("apiAdmin.arr.commandInvalid") }, { status: 400 });
  }
  if (!checkRateLimit(`arr-title-command:${session.user.id}`, LIMIT_PER_MIN, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  const { service, instance, arrId } = target;
  try {
    switch (action) {
      case "refresh":
        return NextResponse.json(await refreshTitle(service, instance, arrId), { status: 202 });
      case "search":
        return NextResponse.json(await searchMovie(instance, arrId), { status: 202 });
      case "searchSeason":
        return NextResponse.json(await searchSeason(instance, arrId, season as number), { status: 202 });
      case "searchEpisodes":
        return NextResponse.json(await searchEpisodes(instance, arrId, episodeIds as number[]), { status: 202 });
      case "searchMissing": {
        const result = await searchMissing("sonarr", instance, arrId, new Date());
        return NextResponse.json(result, { status: 202 });
      }
    }
  } catch (err) {
    if (err instanceof MissingInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: ARR_SERVICE_LABEL[service] }) }, { status: 404 });
    }
    if (err instanceof NothingMissingError) {
      return NextResponse.json({ error: t("apiAdmin.missing.nothingMissing") }, { status: 409 });
    }
    if (err instanceof ArrResponseError && err.status === 404 && action === "searchMissing") {
      return NextResponse.json({ error: t("apiAdmin.arr.titleNotFound", { service: ARR_SERVICE_LABEL[service] }) }, { status: 404 });
    }
    return arrFailure(err, target, t, `title ${action}`);
  }
});
