import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { isFeatureEnabled } from "@/lib/features";
import { readJsonCapped } from "@/lib/body-size";
import {
  MissingInstanceError,
  NothingMissingError,
  NothingToUpgradeError,
  parseMissingMode,
  parseMissingService,
  searchCutoff,
  searchMissing,
} from "@/lib/arr-missing-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";
import { tooManyRequests } from "@/lib/http";
import { sanitizeForLog } from "@/lib/sanitize";

const MAX_BODY_BYTES = 4 * 1024;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;
// Every search hits every indexer on the instance, and the page's "Search
// selected" fires one request per title — so it is bounded per admin like the
// title manager's commands (30/min), but high enough that one capped bulk run
// (BULK_SEARCH_MAX, 100 titles) fits inside a window. The page waits out the
// Retry-After and retries a rate-limited row once.
const LIMIT_PER_MIN = 120;
const LIMIT_WINDOW_MS = 60_000;

// Admin → Missing, one row's Search button (ADMIN). Queues a search on that
// instance for exactly what the title is missing, re-judged live: a Radarr
// MoviesSearch for the movie, or for a series a Sonarr SeasonSearch per season
// with no file at all plus one EpisodeSearch for every other missing episode
// (never SeriesSearch — that would also hunt upgrades). 409 (with an additive
// `nothingMissing: true`) when nothing is missing any more (404 when the
// instance no longer has the title). A Sonarr
// search refused part-way is still 202, counting only the commands it queued,
// with an additive `partial: true`. `mode: "cutoff"` is the Cutoff tab's button: an upgrade
// search for exactly what Radarr/Sonarr say is below cutoff right now (Radarr
// MoviesSearch; one Sonarr EpisodeSearch), 409 when nothing is. Nothing in
// Summonarr is written. 429 (with Retry-After) past LIMIT_PER_MIN per admin; a
// malformed body is refused first and spends none of the budget.
export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const service = parseMissingService(typeof body.service === "string" ? body.service : null);
  const instance = body.instance === undefined ? "" : body.instance;
  const arrId = body.arrId;
  const mode = parseMissingMode(body.mode);
  if (
    !service ||
    !mode ||
    typeof instance !== "string" || instance.length > 100 ||
    typeof arrId !== "number" || !Number.isSafeInteger(arrId) || arrId <= 0
  ) {
    return NextResponse.json({ error: t("apiAdmin.missing.searchBodyInvalid") }, { status: 400 });
  }
  if (!checkRateLimit(`missing-search:${session.user.id}`, LIMIT_PER_MIN, LIMIT_WINDOW_MS)) {
    // Retry-After mirrors the limiter's window (http.ts contract).
    return tooManyRequests(LIMIT_WINDOW_MS / 1000, t("apiAdmin.common.tooManyRequestsLater"));
  }
  const label = SERVICE_LABEL[service];
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: label }) }, { status: 404 });
  }
  try {
    const result = mode === "cutoff"
      ? await searchCutoff(service, instance, arrId)
      : await searchMissing(service, instance, arrId, new Date());
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    if (err instanceof MissingInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
    }
    if (err instanceof NothingMissingError) {
      // Additive flag, the same as /api/admin/arr/title/command's: the Arr
      // Calendar shows "nothing left" only for a 409 carrying it.
      return NextResponse.json({ error: t("apiAdmin.missing.nothingMissing"), nothingMissing: true }, { status: 409 });
    }
    if (err instanceof NothingToUpgradeError) {
      return NextResponse.json({ error: t("apiAdmin.missing.nothingToUpgrade") }, { status: 409 });
    }
    if (err instanceof ArrResponseError && err.status === 404) {
      const key = service === "radarr" ? "apiAdmin.missing.movieNotFound" : "apiAdmin.missing.seriesNotFound";
      return NextResponse.json({ error: t(key) }, { status: 404 });
    }
    // The slug is the browser's: never written raw into a log line (CR/LF, ANSI).
    console.warn(`[missing] ${service} instance "${sanitizeForLog(instance)}" search failed:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.missing.searchFailed", { service: label }) }, { status: 502 });
  }
});
