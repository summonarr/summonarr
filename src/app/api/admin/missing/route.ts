import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import {
  loadCutoffMovies,
  loadCutoffSeries,
  loadMissingMovies,
  loadMissingSeries,
  parseMissingMode,
  parseMissingService,
} from "@/lib/arr-missing-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Missing (ADMIN). What one service's instances are missing that should
// already be there: Radarr movies with no file whose physical or digital release
// date has passed, Sonarr series with an aired, monitored, regular-season
// episode that has no file. `mode=cutoff` lists instead what HAS a file below
// the quality profile's cutoff (Radarr/Sonarr's own /wanted/cutoff, monitored
// titles only). One live listing per configured instance of the requested
// service; nothing is cached or written.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const service = parseMissingService(params.get("service"));
  if (!service) {
    return NextResponse.json({ error: t("apiAdmin.missing.serviceInvalid") }, { status: 400 });
  }
  const mode = parseMissingMode(params.get("mode"));
  if (!mode) {
    return NextResponse.json({ error: t("apiAdmin.missing.modeInvalid") }, { status: 400 });
  }
  const report =
    mode === "cutoff"
      ? service === "radarr" ? await loadCutoffMovies() : await loadCutoffSeries()
      : service === "radarr" ? await loadMissingMovies(new Date()) : await loadMissingSeries();
  return NextResponse.json(report);
});
