import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError, arrErrorMessage } from "@/lib/arr";
import { isFeatureEnabled } from "@/lib/features";
import { loadMissingEpisodes, MissingInstanceError } from "@/lib/arr-missing-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Missing, one series expanded (ADMIN): its aired, monitored,
// regular-season episodes that have no file, with their air dates. `instance` is
// a Sonarr instance slug (absent/empty = the default instance) and must name a
// configured instance; `seriesId` is Sonarr's own series id from the report.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const instance = params.get("instance") ?? "";
  const rawId = params.get("seriesId") ?? "";
  const seriesId = /^[1-9]\d{0,9}$/.test(rawId) ? Number(rawId) : NaN;
  if (!Number.isSafeInteger(seriesId)) {
    return NextResponse.json({ error: t("apiAdmin.missing.seriesIdInvalid") }, { status: 400 });
  }
  if (!(await isFeatureEnabled("feature.integration.sonarr"))) {
    return NextResponse.json({ error: t("apiAdmin.missing.integrationDisabled", { service: "Sonarr" }) }, { status: 404 });
  }
  try {
    const episodes = await loadMissingEpisodes(instance, seriesId, new Date());
    return NextResponse.json({ episodes });
  } catch (err) {
    if (err instanceof MissingInstanceError) {
      return NextResponse.json({ error: t("apiAdmin.missing.instanceUnknown", { service: "Sonarr" }) }, { status: 404 });
    }
    if (err instanceof ArrResponseError && err.status === 404) {
      return NextResponse.json({ error: t("apiAdmin.missing.seriesNotFound") }, { status: 404 });
    }
    console.warn(`[missing] sonarr instance "${instance}" episode listing failed:`, arrErrorMessage(err));
    return NextResponse.json({ error: t("apiAdmin.missing.sonarrUnreachable") }, { status: 502 });
  }
});
