import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { isFeatureEnabled } from "@/lib/features";
import { readJsonCapped } from "@/lib/body-size";
import { MissingInstanceError, NothingMissingError, parseMissingService, searchMissing } from "@/lib/arr-missing-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const MAX_BODY_BYTES = 4 * 1024;
const SERVICE_LABEL = { radarr: "Radarr", sonarr: "Sonarr" } as const;

// Admin → Missing, one row's Search button (ADMIN). Queues a search on that
// instance for exactly what the title is missing, re-judged live: a Radarr
// MoviesSearch for the movie, or for a series a Sonarr SeasonSearch per season
// with no file at all plus one EpisodeSearch for every other missing episode
// (never SeriesSearch — that would also hunt upgrades). 409 when nothing is
// missing any more. Nothing in Summonarr is written.
export const POST = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const service = parseMissingService(typeof body.service === "string" ? body.service : null);
  const instance = body.instance === undefined ? "" : body.instance;
  const arrId = body.arrId;
  if (
    !service ||
    typeof instance !== "string" || instance.length > 100 ||
    typeof arrId !== "number" || !Number.isSafeInteger(arrId) || arrId <= 0
  ) {
    return NextResponse.json({ error: t("apiAdmin.missing.searchBodyInvalid") }, { status: 400 });
  }
  const label = SERVICE_LABEL[service];
  if (!(await isFeatureEnabled(`feature.integration.${service}`))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: label }) }, { status: 404 });
  }
  try {
    const result = await searchMissing(service, instance, arrId, new Date());
    return NextResponse.json(result, { status: 202 });
  } catch (err) {
    if (err instanceof MissingInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: label }) }, { status: 404 });
    }
    if (err instanceof NothingMissingError) {
      return NextResponse.json({ error: t("apiAdmin.missing.nothingMissing") }, { status: 409 });
    }
    if (err instanceof ArrResponseError && err.status === 404) {
      const key = service === "radarr" ? "apiAdmin.missing.movieNotFound" : "apiAdmin.missing.seriesNotFound";
      return NextResponse.json({ error: t(key) }, { status: 404 });
    }
    console.warn(`[missing] ${service} instance "${instance}" search failed:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.missing.searchFailed", { service: label }) }, { status: 502 });
  }
});
