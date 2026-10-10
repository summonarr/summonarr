import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrResponseError } from "@/lib/arr";
import { loadSeriesEpisodes } from "@/lib/arr-queue-data";
import { importFailure, serviceGate } from "@/lib/arr-queue-http";
import { translatorForRequest } from "@/lib/i18n/server-locale";

// Admin → Download Queue → Import, a Sonarr series' episodes (ADMIN): what the
// episode picker offers when a file is re-matched. `instance` must be a
// configured Sonarr instance; `seriesId` is Sonarr's own id.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const target = await serviceGate("sonarr", params.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const raw = params.get("seriesId") ?? "";
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    return NextResponse.json({ error: t("apiAdmin.missing.seriesIdInvalid") }, { status: 400 });
  }
  try {
    return NextResponse.json({ episodes: await loadSeriesEpisodes(target.instance, Number(raw)) });
  } catch (err) {
    if (err instanceof ArrResponseError && err.status === 404) {
      return NextResponse.json({ error: t("apiAdmin.missing.seriesNotFound") }, { status: 404 });
    }
    return importFailure(err, target.service, target.instance, t, "episode listing");
  }
});
