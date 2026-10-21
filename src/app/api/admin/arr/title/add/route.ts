import { NextResponse } from "next/server";
import { tooManyRequests } from "@/lib/http";
import { withAdmin } from "@/lib/api-auth";
import { ARR_SERVICE_LABEL } from "@/lib/arr-admin";
import { arrFailure, arrGate, parseArrId } from "@/lib/arr-admin-http";
import { parseTitleAdd } from "@/lib/arr-title-add";
import { TitleExistsError, TitleLookupError, addTitle, loadAddChoices } from "@/lib/arr-title-lifecycle";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { invalidateArrLibraryIndexCache } from "@/lib/library-cleanup-arr";
import { invalidateNeverWatchedReport } from "@/lib/never-watched-report";
import { checkRateLimit } from "@/lib/rate-limit";

const ADDS_PER_MIN = 20;

// Admin "Add to Radarr/Sonarr" (ADMIN) — a title nobody requested, with the
// arr's own add choices, instead of the request path's configured defaults.
//   GET ?service&instance&tmdbId → { presentArrId, preview, qualityProfiles,
//       rootFolders, tags, defaults }: the instance's own choices, its configured
//       add defaults to preselect, and the arr id when it already has the title.
//   POST { service, instance, tmdbId, qualityProfileId, rootFolderPath, tags,
//       search, monitored + minimumAvailability? (Radarr) | monitor +
//       seriesType? + seasonFolder? (Sonarr) } → 201 { arrId, title }. Every
//       value must be one the instance offers (400, nothing written); a title
//       it already has is 409 { arrId }. Audited ARR_TITLE_ADD after the arr
//       accepted it. No MediaRequest is created — nobody asked for it, so
//       nobody is notified and no watch grade counts it.
export const GET = withAdmin(async (req) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrGate(q.get("service"), q.get("instance"), t);
  if (target instanceof NextResponse) return target;
  const tmdbId = parseArrId(q.get("tmdbId"));
  if (tmdbId === null) return NextResponse.json({ error: t("apiAdmin.arr.idInvalid") }, { status: 400 });
  try {
    return NextResponse.json(await loadAddChoices(target.service, target.instance, tmdbId));
  } catch (err) {
    return arrFailure(err, target, t, "add choices");
  }
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 16 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrGate(body.service, body.instance, t);
  if (target instanceof NextResponse) return target;
  const add = parseTitleAdd(target.service, body);
  if (!add) return NextResponse.json({ error: t("apiAdmin.arr.addInvalid") }, { status: 400 });
  if (!checkRateLimit(`arr-title-add:${session.user.id}`, ADDS_PER_MIN, 60_000)) {
    return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
  }
  const service = ARR_SERVICE_LABEL[target.service];
  let result;
  try {
    result = await addTitle(target.service, target.instance, add);
  } catch (err) {
    if (err instanceof TitleExistsError) {
      return NextResponse.json({ error: t("apiAdmin.arr.addExists", { service }), arrId: err.arrId }, { status: 409 });
    }
    if (err instanceof TitleLookupError) {
      return NextResponse.json({ error: t("apiAdmin.arr.addLookupFailed", { service }) }, { status: 404 });
    }
    return arrFailure(err, target, t, "title add");
  }
  invalidateArrLibraryIndexCache();
  // The never-watched report's copies and "eligible" read that index — the
  // title manager's Remove drops it the same way.
  invalidateNeverWatchedReport();
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_TITLE_ADD",
    target: `${target.service}:${target.instance}:${result.arrId}`,
    details: {
      service: target.service,
      instance: target.instance,
      tmdbId: add.tmdbId,
      arrId: result.arrId,
      title: result.title,
      qualityProfileId: add.qualityProfileId,
      rootFolderPath: add.rootFolderPath,
      tags: add.tags,
      search: add.search,
      ...(target.service === "radarr" ? { monitored: add.monitored } : { monitor: add.monitor }),
    },
    ...auditContext(req, session),
  });
  return NextResponse.json(result, { status: 201 });
});
