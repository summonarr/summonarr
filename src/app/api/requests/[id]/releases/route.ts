import { NextResponse } from "next/server";
import { withPermission } from "@/lib/api-auth";
import {
  ArrItemNotFoundError,
  getReleasesForMovie,
  getReleasesForSeries,
  getSonarrSeasons,
  grabMovieRelease,
  grabSeriesRelease,
  isArrConfigured,
  resolveTvdbIdFromTmdbId,
} from "@/lib/arr";
import { isValidInstanceSlug } from "@/lib/arr-instances";
import { auditContext, logAudit } from "@/lib/audit";
import { readJsonCapped } from "@/lib/body-size";
import { translatorForRequest } from "@/lib/i18n/server-locale";
import type { Translator } from "@/lib/i18n/translate";
import { maintenanceGuard } from "@/lib/maintenance";
import { Permission } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { issueReleaseHandles, redeemReleaseHandle } from "@/lib/release-handles";

type RouteContext = { params: Promise<{ id: string }> };

// A release search hits every indexer the instance has; bounded per admin like
// the other indexer-spending admin actions.
const SEARCH_LIMIT_PER_MIN = 20;
const HANDLE_RE = /^[0-9a-f]{32}$/;
const MAX_SEASON = 1_000;

// Interactive search for one APPROVED (or AVAILABLE) request — the request
// queue's "Pick release". The same release list and grab the Issue "Replace"
// panel uses (arr.ts getReleasesFor*/grab*, projected through toArrRelease so
// no indexer download URL reaches the browser), on the request's own instance
// (guardrail 32). Each release's `guid` is replaced by an opaque handle bound
// to this request, instance and season (release-handles.ts): some indexers
// build the guid from the apikey'd download link, and this list goes to
// MANAGE_REQUESTS delegates, not only admins.
//
//   MOVIE: GET → { releases }.
//   TV:    GET without `season` → { seasons } (Sonarr's per-season counts), so
//          the picker can choose one; GET ?season=N → { releases } for that
//          season. Sonarr has no whole-series release search — a series-only
//          query returns the indexers' RSS feed, not this show — so a season
//          is always required.
//   POST { release: <handle>, season? } → grabs it. 410 when the handle is
//          unknown, expired, or from another search. Audited (ARR_RELEASE_GRAB)
//          after Radarr/Sonarr accepted it; the request's status is untouched —
//          the Download webhook / sync flips it when the file lands, as always.
//
// MANAGE_REQUESTS, like every other action on the request queue.

type LoadedRequest = {
  id: string;
  mediaType: "MOVIE" | "TV";
  tmdbId: number;
  tvdbId: number | null;
  status: string;
  arrInstance: string;
};

async function loadRequest(id: string, t: Translator): Promise<LoadedRequest | NextResponse> {
  const req = await prisma.mediaRequest.findUnique({
    where: { id },
    select: { id: true, mediaType: true, tmdbId: true, tvdbId: true, status: true, arrInstance: true },
  });
  if (!req) return NextResponse.json({ error: t("apiUser.common.notFound") }, { status: 404 });
  if (req.status !== "APPROVED" && req.status !== "AVAILABLE") {
    return NextResponse.json({ error: t("apiUser.requests.releases.invalidStatus") }, { status: 409 });
  }
  const service = req.mediaType === "MOVIE" ? "radarr" : "sonarr";
  if (!isValidInstanceSlug(req.arrInstance)) {
    return NextResponse.json({ error: t("apiUser.common.invalidInstance") }, { status: 400 });
  }
  if (!(await isArrConfigured(service, req.arrInstance))) {
    const error = req.arrInstance === ""
      ? t("apiUser.common.notConfigured", { name: service === "radarr" ? "Radarr" : "Sonarr" })
      : t("apiUser.issues.instanceNotConfigured", { service, instance: req.arrInstance });
    return NextResponse.json({ error }, { status: 422 });
  }
  return req as LoadedRequest;
}

async function tvdbIdFor(req: LoadedRequest): Promise<number | null> {
  return req.tvdbId ?? (await resolveTvdbIdFromTmdbId(req.tmdbId, req.arrInstance));
}

// What a handle is bound to: this request, on its instance, for this season.
const handleScope = (req: LoadedRequest, season: number | null | undefined) => `${req.id}\u0000${req.arrInstance}\u0000${season ?? ""}`;

function parseSeason(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_SEASON ? n : null;
}

function arrFailure(err: unknown, t: Translator, service: "radarr" | "sonarr", where: string): NextResponse {
  if (err instanceof ArrItemNotFoundError) {
    return NextResponse.json(
      { error: t("apiUser.requests.releases.notInArr", { service: service === "radarr" ? "Radarr" : "Sonarr" }) },
      { status: 409 },
    );
  }
  // The detail (raw upstream text) goes to the log; the client gets the translated generic.
  console.error(`[request-releases] ${where} failed:`, err);
  return NextResponse.json({ error: t("apiUser.issues.arrFailed") }, { status: 502 });
}

export const GET = withPermission(Permission.MANAGE_REQUESTS)(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const { id } = await params;
  const loaded = await loadRequest(id, t);
  if (loaded instanceof NextResponse) return loaded;
  const service = loaded.mediaType === "MOVIE" ? "radarr" : "sonarr";
  const season = parseSeason(req.nextUrl.searchParams.get("season"));
  if (season === null) return NextResponse.json({ error: t("apiUser.requests.releases.seasonInvalid") }, { status: 400 });

  try {
    if (loaded.mediaType === "MOVIE") {
      if (!checkRateLimit(`request-releases:${session.user.id}`, SEARCH_LIMIT_PER_MIN, 60_000)) {
        return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
      }
      const releases = await getReleasesForMovie(loaded.tmdbId, loaded.arrInstance);
      return NextResponse.json({ releases: issueReleaseHandles(handleScope(loaded, undefined), releases) });
    }
    const tvdbId = await tvdbIdFor(loaded);
    if (!tvdbId) return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
    // The season list costs one library read, no indexer hit — not rate limited.
    if (season === undefined) return NextResponse.json({ seasons: await getSonarrSeasons(tvdbId, loaded.arrInstance) });
    if (!checkRateLimit(`request-releases:${session.user.id}`, SEARCH_LIMIT_PER_MIN, 60_000)) {
      return NextResponse.json({ error: t("apiUser.common.tooManyRequestsLater") }, { status: 429 });
    }
    const releases = await getReleasesForSeries(tvdbId, "SEASON", season, null, loaded.arrInstance);
    return NextResponse.json({ releases: issueReleaseHandles(handleScope(loaded, season), releases) });
  } catch (err) {
    return arrFailure(err, t, service, "search");
  }
});

export const POST = withPermission(Permission.MANAGE_REQUESTS)(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const maint = await maintenanceGuard(session);
  if (maint) return maint;

  const { id } = await params;
  const parsed = await readJsonCapped<Record<string, unknown>>(req, 16 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};

  const handle = body.release;
  if (typeof handle !== "string" || !HANDLE_RE.test(handle)) {
    return NextResponse.json({ error: t("apiUser.requests.releases.releaseRequired") }, { status: 400 });
  }
  const season = parseSeason(body.season);
  if (season === null) return NextResponse.json({ error: t("apiUser.requests.releases.seasonInvalid") }, { status: 400 });

  const loaded = await loadRequest(id, t);
  if (loaded instanceof NextResponse) return loaded;
  const service = loaded.mediaType === "MOVIE" ? "radarr" : "sonarr";
  // A movie search has no season; a TV handle is only good for its own season.
  const picked = redeemReleaseHandle(handleScope(loaded, loaded.mediaType === "MOVIE" ? undefined : season), handle);
  if (!picked) return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  const { guid, indexerId } = picked;

  try {
    if (loaded.mediaType === "MOVIE") {
      await grabMovieRelease(loaded.tmdbId, guid, indexerId, loaded.arrInstance);
    } else {
      const tvdbId = await tvdbIdFor(loaded);
      if (!tvdbId) return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
      await grabSeriesRelease(tvdbId, guid, indexerId, season ?? null, null, loaded.arrInstance);
    }
  } catch (err) {
    return arrFailure(err, t, service, "grab");
  }

  // The guid is never recorded: some indexers use the download link — apikey
  // included — as the guid.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_RELEASE_GRAB",
    target: `request:${loaded.id}`,
    details: { service, instance: loaded.arrInstance, indexerId, ...(season !== undefined ? { season } : {}) },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
