import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { ArrLinkInstanceError, resolveArrOpenUrl, type ArrLinkTarget } from "@/lib/arr-links-data";
import { parseQueueService } from "@/lib/arr-queue-data";
import { translatorForRequest } from "@/lib/i18n/server-locale";

const ID_RE = /^[1-9]\d{0,9}$/;

// "Open in Radarr / Sonarr" (ADMIN). Every in-app link to an arr's web UI goes
// through here: it resolves the title on that instance on click — a library
// title opens its page, one the instance doesn't have opens Add New for the
// TMDB id — and redirects. `tmdbId` or `arrId` (Radarr movie / Sonarr series id)
// names the title. The target host is the instance's External URL setting,
// else its connection URL: admin-configured, never request-supplied.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const params = req.nextUrl.searchParams;
  const service = parseQueueService(params.get("service"));
  const instance = params.get("instance") ?? "";
  const tmdbRaw = params.get("tmdbId");
  const arrRaw = params.get("arrId");
  let target: ArrLinkTarget | null = null;
  if (tmdbRaw !== null && ID_RE.test(tmdbRaw) && arrRaw === null) target = { tmdbId: Number(tmdbRaw) };
  else if (arrRaw !== null && ID_RE.test(arrRaw) && tmdbRaw === null) target = { arrId: Number(arrRaw) };
  if (!service || instance.length > 100 || !target) {
    return NextResponse.json({ error: t("apiAdmin.arrOpen.paramsInvalid") }, { status: 400 });
  }
  try {
    const url = await resolveArrOpenUrl(service, instance, target);
    if (!url) return NextResponse.json({ error: t("apiAdmin.arrOpen.noAddress") }, { status: 404 });
    return NextResponse.redirect(url, 302);
  } catch (err) {
    if (err instanceof ArrLinkInstanceError) {
      return NextResponse.json(
        { error: t("apiAdmin.missing.instanceUnknown", { service: service === "radarr" ? "Radarr" : "Sonarr" }) },
        { status: 404 },
      );
    }
    throw err;
  }
});
