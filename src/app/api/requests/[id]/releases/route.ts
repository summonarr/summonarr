import { NextResponse } from "next/server";
import { tooManyRequests } from "@/lib/http";
import { withPermission } from "@/lib/api-auth";
import {
  ArrItemNotFoundError,
  arrErrorMessage,
  getReleasesForMovie,
  getReleasesForSeries,
  getSonarrSeasons,
  grabMovieRelease,
  grabSeriesRelease,
  isArrConfigured,
  resolveTvdbIdFromTmdbId,
  type GrabProgress,
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
import { grabDefinitelyRefused, grabRefusalResponse } from "@/lib/release-grab";
import { claimReleaseHandle, forgetReleaseHandle, issueReleaseHandles, releaseReleaseHandle } from "@/lib/release-handles";
import { answerOf, releaseSearchJobResponse, runningReleaseSearchJob, startReleaseSearchJob } from "@/lib/release-search-jobs";

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
//   `&async=1` on a release search → 202 { job } at once; the search runs in
//          the background (release-search-jobs.ts: a reverse proxy cuts a
//          request held for the minute or two indexers take) and GET ?job=<id>
//          answers 202 while it runs, then the search's own answer, 404 once
//          the job is gone. Without it the answer is synchronous, as before.
//   POST { release: <handle>, season? } → grabs it. 410 when the handle is
//          unknown, expired, or from another search — or when the arr's own
//          30-minute search cache no longer has the release; 409 with the
//          arr's reason when the indexer or download client refused it. The
//          handle is spent on success. Audited (ARR_RELEASE_GRAB)
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
  // arrErrorMessage, never the error object: Node prints an ArrResponseError's
  // whole upstream body, which can quote an indexer URL with its apikey.
  console.error(`[request-releases] ${where} failed:`, arrErrorMessage(err));
  return NextResponse.json({ error: t("apiUser.issues.arrFailed") }, { status: 502 });
}

export const GET = withPermission(Permission.MANAGE_REQUESTS)(async (req, { params }: RouteContext, session) => {
  const t = translatorForRequest(req);
  const job = req.nextUrl.searchParams.get("job");
  if (job !== null) return releaseSearchJobResponse(session.user.id, job, t);
  const { id } = await params;
  const loaded = await loadRequest(id, t);
  if (loaded instanceof NextResponse) return loaded;
  const service = loaded.mediaType === "MOVIE" ? "radarr" : "sonarr";
  const season = parseSeason(req.nextUrl.searchParams.get("season"));
  if (season === null) return NextResponse.json({ error: t("apiUser.requests.releases.seasonInvalid") }, { status: 400 });
  const background = req.nextUrl.searchParams.get("async") === "1";

  try {
    let tvdbId: number | null = null;
    if (loaded.mediaType === "TV") {
      tvdbId = await tvdbIdFor(loaded);
      if (!tvdbId) return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
      // The season list costs one library read, no indexer hit — not rate limited.
      if (season === undefined) return NextResponse.json({ seasons: await getSonarrSeasons(tvdbId, loaded.arrInstance) });
    }
    const key = handleScope(loaded, loaded.mediaType === "MOVIE" ? undefined : season);
    // Joining a search already running costs no indexer hit, so no rate token.
    const running = background ? runningReleaseSearchJob(session.user.id, key) : null;
    if (running) return NextResponse.json({ job: running }, { status: 202 });
    if (!checkRateLimit(`request-releases:${session.user.id}`, SEARCH_LIMIT_PER_MIN, 60_000)) {
      return tooManyRequests(60, t("apiUser.common.tooManyRequestsLater"));
    }
    const search = async (): Promise<NextResponse> => {
      try {
        const releases = loaded.mediaType === "MOVIE"
          ? await getReleasesForMovie(loaded.tmdbId, loaded.arrInstance)
          : await getReleasesForSeries(tvdbId as number, "SEASON", season as number, null, loaded.arrInstance);
        return NextResponse.json({ releases: issueReleaseHandles(key, releases, { owner: session.user.id }) });
      } catch (err) {
        return arrFailure(err, t, service, "search");
      }
    };
    if (!background) return await search();
    const { jobId } = startReleaseSearchJob(session.user.id, key, async () => answerOf(await search()));
    return NextResponse.json({ job: jobId }, { status: 202 });
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
  const picked = claimReleaseHandle(handleScope(loaded, loaded.mediaType === "MOVIE" ? undefined : season), handle);
  if (picked === "unknown") return NextResponse.json({ error: t("apiUser.requests.releases.handleExpired") }, { status: 410 });
  if (picked === "busy") return NextResponse.json({ error: t("apiUser.requests.releases.grabInProgress") }, { status: 409 });
  const { guid, indexerId } = picked;

  const progress: GrabProgress = { sent: false };
  try {
    if (loaded.mediaType === "MOVIE") {
      await grabMovieRelease(loaded.tmdbId, guid, indexerId, loaded.arrInstance, progress);
    } else {
      const tvdbId = await tvdbIdFor(loaded);
      if (!tvdbId) {
        releaseReleaseHandle(handle);
        return NextResponse.json({ error: t("apiUser.issues.tvdbUnresolved") }, { status: 422 });
      }
      await grabSeriesRelease(tvdbId, guid, indexerId, season ?? null, null, loaded.arrInstance, progress);
    }
  } catch (err) {
    // Nothing sent yet (no config, the title lookup or the tvdb resolution
    // failed), or the arr definitely refused (a 4xx, or it doesn't have the
    // title): the release may be tried again. No answer, or a 408/5xx (a
    // timeout, the network, a gateway that gave up while the arr was still
    // sending it to the client): it may well have taken it — never send it twice.
    if (!progress.sent) releaseReleaseHandle(handle);
    else if (grabDefinitelyRefused(err)) releaseReleaseHandle(handle);
    else forgetReleaseHandle(handle);
    const refused = grabRefusalResponse(err, service === "radarr" ? "Radarr" : "Sonarr", t);
    if (refused) return refused;
    return arrFailure(err, t, service, "grab");
  }
  forgetReleaseHandle(handle);

  // The guid is never recorded: some indexers use the download link — apikey
  // included — as the guid.
  void logAudit({
    userId: session.user.id,
    userName: session.user.name ?? session.user.email ?? null,
    action: "ARR_RELEASE_GRAB",
    target: `request:${loaded.id}`,
    details: { service, instance: loaded.arrInstance, indexerId, release: picked.title, ...(season !== undefined ? { season } : {}) },
    ...auditContext(req, session),
  });
  return NextResponse.json({ ok: true });
});
