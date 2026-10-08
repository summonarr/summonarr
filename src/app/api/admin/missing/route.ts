import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { loadMissingMovies, loadMissingSeries, parseMissingService } from "@/lib/arr-missing-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Missing (ADMIN). What one service's instances are missing that should
// already be there: Radarr movies with no file whose physical or digital release
// date has passed, Sonarr series with an aired, monitored, regular-season
// episode that has no file. One live listing per configured instance of the
// requested service; nothing is cached or written.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const service = parseMissingService(req.nextUrl.searchParams.get("service"));
  if (!service) {
    return NextResponse.json({ error: t("apiAdmin.missing.serviceInvalid") }, { status: 400 });
  }
  const report = service === "radarr" ? await loadMissingMovies(new Date()) : await loadMissingSeries();
  return NextResponse.json(report);
});
