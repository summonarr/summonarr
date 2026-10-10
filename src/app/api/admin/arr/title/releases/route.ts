import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-auth";
import { arrFailure, arrTitleGate, parseArrId, parseSeasonNumber, type ArrTitleTarget } from "@/lib/arr-admin-http";
import { grabTitleRelease, searchTitleReleases, type ReleaseScope } from "@/lib/arr-title-data";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import { checkRateLimit } from "@/lib/rate-limit";
import { issueReleaseHandles, redeemReleaseHandle } from "@/lib/release-handles";

const SEARCH_LIMIT_PER_MIN = 20;
const HANDLE_RE = /^[0-9a-f]{32}$/;

// Admin title manager, interactive search (ADMIN) — pick a release by hand
// for ANY title on the instance, the arr's own "Interactive Search".
//   GET ?service&instance&id                — a movie;
//   GET ?service=sonarr&instance&id&season=N — one season of a series, or
//   GET ?service=sonarr&instance&id&episodeId=E — one episode. Sonarr has no
//       whole-series release search (a series-only query answers with the
//       indexers' RSS feed), so a series needs one of the two.
//       → { releases }: the same projected list as the request "Pick release"
//       (no indexer download URL), each `guid` replaced by an opaque handle
//       bound to this title, instance and scope (release-handles.ts).
//   POST { service, instance, id, release: <handle>, season? | episodeId? } —
//       grab it. 410 when the handle is unknown, expired, or from another
//       search. Audited ARR_RELEASE_GRAB after the arr accepted it; the guid
//       is never recorded.
function scopeOf(target: ArrTitleTarget, rawSeason: unknown, rawEpisode: unknown): ReleaseScope | "invalid" {
  const hasSeason = rawSeason !== undefined && rawSeason !== null && rawSeason !== "";
  const hasEpisode = rawEpisode !== undefined && rawEpisode !== null && rawEpisode !== "";
  if (target.service === "radarr") return hasSeason || hasEpisode ? "invalid" : null;
  if (hasSeason === hasEpisode) return "invalid";
  if (hasSeason) {
    const seasonNumber = parseSeasonNumber(rawSeason);
    return seasonNumber === null ? "invalid" : { seasonNumber };
  }
  const episodeId = parseArrId(rawEpisode);
  return episodeId === null ? "invalid" : { episodeId };
}

const handleScope = (target: ArrTitleTarget, scope: ReleaseScope) =>
  ["title", target.service, target.instance, target.arrId, scope && "seasonNumber" in scope ? `s${scope.seasonNumber}` : scope ? `e${scope.episodeId}` : ""].join("\u0000");

export const GET = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const q = req.nextUrl.searchParams;
  const target = await arrTitleGate(q.get("service"), q.get("instance"), q.get("id"), t);
  if (target instanceof NextResponse) return target;
  const scope = scopeOf(target, q.get("season"), q.get("episodeId"));
  if (scope === "invalid") return NextResponse.json({ error: t("apiAdmin.arr.releaseScopeInvalid") }, { status: 400 });
  if (!checkRateLimit(`arr-title-releases:${session.user.id}`, SEARCH_LIMIT_PER_MIN, 60_000)) {
    return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
  }
  try {
    const releases = await searchTitleReleases(target.service, target.instance, target.arrId, scope);
    return NextResponse.json({ releases: issueReleaseHandles(handleScope(target, scope), releases) });
  } catch (err) {
    return arrFailure(err, target, t, "release search");
  }
});

export const POST = withAdmin(async (req, _ctx, session) => {
  const t = translatorForRequest(req);
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 16 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const target = await arrTitleGate(body.service, body.instance, body.id, t);
  if (target instanceof NextResponse) return target;
  const handle = body.release;
  if (typeof handle !== "string" || !HANDLE_RE.test(handle)) {
    return NextResponse.json({ error: t("apiUser.requests.releases.releaseRequired") }, { status: 400 });
  }
  const scope = scopeOf(target, body.season, body.episodeId);
  if (scope === "invalid") return NextResponse.json({ error: t("apiAdmin.arr.releaseScopeInvalid") }, { status: 400 });
  const picked = redeemReleaseHandle(handleScope(target, scope), handle);
  if (!picked) return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  try {
    await grabTitleRelease(target.service, target.instance, target.arrId, picked, scope);
  } catch (err) {
    return arrFailure(err, target, t, "release grab");
  }
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_RELEASE_GRAB",
    target: `${target.service}:${target.instance}:${target.arrId}`,
    details: {
      service: target.service,
      instance: target.instance,
      arrId: target.arrId,
      indexerId: picked.indexerId,
      source: "title",
      ...(scope && "seasonNumber" in scope ? { season: scope.seasonNumber } : {}),
      ...(scope && "episodeId" in scope ? { episodeId: scope.episodeId } : {}),
    },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
